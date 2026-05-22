# @nexora/api

Nexora HRMS — REST API server.

**Stack:** Node.js 20 · TypeScript · Express 4 · Prisma 5 · MySQL 8 ·
zod · iron-session · argon2 · pino · helmet · node-cron · PDFKit ·
nodemailer.

This repo is the `apps/api` submodule of the meta repo at
[github.com/Abhishek-triline/HRMS_app](https://github.com/Abhishek-triline/HRMS_app).
You should **work from the meta clone**, not from a standalone clone of
this repo — the workspace dependency `@nexora/contracts` lives in the
meta repo's `packages/contracts/` and won't resolve without it.

---

## Quick start (from the meta clone)

```bash
# At the meta root — not inside apps/api
git clone --recurse-submodules https://github.com/Abhishek-triline/HRMS_app.git
cd HRMS_app
pnpm install

# Database (one-time)
cp apps/api/.env.example apps/api/.env       # fill in DATABASE_URL + SESSION_SECRET
pnpm --filter api db:migrate                 # apply migrations
pnpm --filter api db:seed                    # seed masters + demo users

# Run the dev server (port 4000)
pnpm --filter api dev
```

Demo logins after seed: `admin@nexora.in`, `manager@nexora.in`,
`employee@nexora.in`, `payroll@nexora.in` — password `Demo1234!`.

---

## Repository layout

```
apps/api/
├── src/
│   ├── index.ts                  # Express bootstrap, env validation, scheduler start
│   ├── router.ts                 # /api/v1 root router — mounts every module
│   ├── middleware/               # requireSession · requireRole · idempotencyKey
│   │                             # validateBody · validateQuery · errorHandler
│   ├── lib/                      # prisma · audit · notifications · scheduler
│   │                             # statusInt · logger · mailer · config · openapi
│   └── modules/                  # Per-domain routes + services + helpers
│       ├── auth/                 # Sessions, login, lockout, password reset
│       ├── employees/            # Employees, masters, hierarchy, emp-code
│       ├── leave/                # Leave requests + Encashment + carry-forward
│       ├── attendance/           # Daily records, regularisation, holidays
│       ├── payroll/              # Runs, payslips, PDF, LOP, proration, tax
│       ├── performance/          # Review cycles + ratings + goals
│       ├── notifications/        # In-app + email fanout
│       ├── audit/                # Append-only audit log (read API)
│       └── configuration/        # Org configuration endpoints
├── prisma/
│   ├── schema.prisma             # 30+ models, INT PKs, optimistic `version`
│   ├── migrations/               # Generated migrations (never edit by hand)
│   └── seed.ts                   # Idempotent seed
└── package.json
```

---

## Architecture in one paragraph

Every endpoint stacks `requireSession()` → `requireRole(...)` →
`idempotencyKey()` (mutations only) → `validateBody(zodSchema)` →
service call. The service wraps all writes in `prisma.$transaction`,
guards every mutable row with optimistic-concurrency `version`, and
emits an `audit({ tx, ... })` row inside the same transaction.
`audit_log` is append-only at the DB level (`REVOKE UPDATE, DELETE`
applied in migration). Side-effects that can fail without data loss
(emails, in-app notifications, PDF generation) run **after** the
transaction commits, using `notify(...)` which swallows errors.

Full architecture details (route → service → Prisma layering, business
rules, cron jobs, security): see the meta repo's Claude Code skill
[.claude/skills/nexora-backend-api/](https://github.com/Abhishek-triline/HRMS_app/tree/main/.claude/skills/nexora-backend-api).

---

## Scripts

| Command | Action |
|---|---|
| `pnpm dev` | Watch mode via `tsx watch src/index.ts` (port 4000) |
| `pnpm build` | `prisma generate` + `tsc` → `dist/index.js` |
| `pnpm start` | Run the compiled bundle (production) |
| `pnpm typecheck` | `prisma generate` + `tsc --noEmit` |
| `pnpm lint` | ESLint over `src/**/*.ts` |
| `pnpm test` | Vitest (watch mode) |
| `pnpm test --run` | Vitest single run |
| `pnpm db:migrate` | `prisma migrate dev` — generate + apply a new migration |
| `pnpm db:seed` | `tsx prisma/seed.ts` — idempotent seed |
| `pnpm db:reset` | `prisma migrate reset --force --skip-seed` (**destructive**) |

All commands must run inside the meta clone — none of them resolve
`@nexora/contracts` standalone.

---

## Status codes — INT only

Every status / type / category / role / module column on the wire and
in the database is an INT. The frozen constants are in
[`src/lib/statusInt.ts`](src/lib/statusInt.ts) and mirrored in the
meta repo's `packages/contracts/` for the web app.

Examples:

- `RoleId.Admin = 4` — **NOT** `'Admin'`.
- `LeaveStatus.Pending = 1`, `LeaveStatus.Approved = 2`, …
- `AuditModuleId.payroll = 4`.

**Never re-number an existing code.** Append new codes only.

---

## Scheduled jobs

Run via `node-cron`, started in [`src/lib/scheduler.ts`](src/lib/scheduler.ts)
after Express starts listening. All run in `Asia/Kolkata`. Guarded by
`ENABLE_CRON` (default `true`; set `false` in tests).

| Job | Cron | Purpose |
|---|---|---|
| `attendance.midnight-generate` | `0 0 * * *` | Generate one Absent row per active employee per day; override priority Holiday > WeeklyOff > OnLeave > Present > Absent |
| `leave.escalation-sweep` | `0 * * * *` | Escalate Pending leave requests older than 5 working days (BL-018) and orphaned by Exited managers (BL-022) |
| `encashment.escalation-sweep` | `0 * * * *` | Same for the encashment state machine |
| `leave.carry-forward` | `5 0 1 1 *` | Jan 1 — cap Annual/Casual at carry-forward limit; reset Sick/Unpaid to 0; create fresh balance rows |
| `notifications.archive-90d` | `0 2 * * *` | Soft-delete in-app notifications older than 90 days |
| `idempotency-key.cleanup` | `0 3 * * *` | Drop stale `IdempotencyKey` rows |
| `performance.deadline-nudge` | `0 9 * * *` | Send 7-day + 1-day deadline reminders for open review cycles |

---

## Configuration

Required env vars (see `.env.example`):

| Var | Purpose |
|---|---|
| `DATABASE_URL` | MySQL connection string |
| `SESSION_SECRET` | iron-session encryption key — must be 32+ chars |
| `API_PORT` | Defaults to `4000` |
| `CORS_ORIGINS` | Comma-separated list of allowed origins |
| `SMTP_*` | Optional — when unset, `mailer.ts` logs instead of sending |
| `ENABLE_CRON` | Default `true`; set `false` in vitest / tests |

The server refuses to boot if `SESSION_SECRET` is missing, shorter than
32 chars, or matches a `.env.example` placeholder (SEC-008).

---

## Working in this sub-repo

Submodules default to a **detached HEAD** after
`git submodule update --init`. Switch to a branch before editing:

```bash
cd apps/api
git checkout main
git pull --ff-only origin main
git checkout -b feat/<thing>
# … edit, test, push …
git push -u origin feat/<thing>
# Open PR on github.com/Abhishek-triline/HRMS_api
```

After the PR merges into `main` here, the meta repo's gitlink is still
on the old SHA. Bump it from the meta root:

```bash
cd /path/to/HRMS_app
git submodule update --remote apps/api
git add apps/api
git commit -m "chore: bump apps/api to <short-sha>"
git push
```

---

## Related repos & docs

- Meta repo: https://github.com/Abhishek-triline/HRMS_app
- Web sub-repo: https://github.com/Abhishek-triline/HRMS_web
- Shared contracts package (`@nexora/contracts`): in the meta repo
  under `packages/contracts/`
- API reference: [`docs/api/reference.md`](https://github.com/Abhishek-triline/HRMS_app/blob/main/docs/api/reference.md) in the meta repo
- Database schema reference: [`docs/design/schema-reference.md`](https://github.com/Abhishek-triline/HRMS_app/blob/main/docs/design/schema-reference.md)
- Multi-repo setup playbook: [`docs/repo_setup/MULTI_REPO_SETUP.md`](https://github.com/Abhishek-triline/HRMS_app/blob/main/docs/repo_setup/MULTI_REPO_SETUP.md)
