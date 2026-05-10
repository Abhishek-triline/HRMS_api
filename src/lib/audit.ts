/**
 * Audit log helper — BL-047 / BL-048.
 *
 * EVERY state-changing action MUST call `audit(...)`.
 * This helper generates a ULID id client-side for monotonic ordering
 * and writes a single append-only row.
 *
 * If `tx` is provided, the write runs inside the caller's transaction.
 * Otherwise a new top-level write is used.
 *
 * The DB enforces append-only via REVOKE UPDATE, DELETE on audit_log
 * (applied in the migration after table creation — BL-047 enforcement point).
 */

import { ulid } from 'ulid';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

export type AuditParams = {
  /** The Prisma transaction client — if supplied, the write joins the caller's tx. */
  tx?: Prisma.TransactionClient;
  /** actorId — null only for system-generated events (cron jobs, etc.) */
  actorId: string | null;
  actorRole: string;
  actorIp?: string | null;
  /** Dot-separated action name, e.g. "auth.login.success" */
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  /** Top-level module grouping, e.g. "auth", "leave", "payroll" */
  module: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
};

/**
 * Write a single append-only audit entry.
 * Throws on failure — never silently swallows errors.
 *
 * Both PrismaClient and Prisma.TransactionClient expose `auditLog.create`.
 * We accept either via the shared model surface.
 */
export async function audit(params: AuditParams): Promise<void> {
  const {
    tx,
    actorId,
    actorRole,
    actorIp,
    action,
    targetType,
    targetId,
    module: mod,
    before,
    after,
  } = params;

  // Use transaction client if provided; otherwise use the global singleton.
  // Both share the same model methods — the cast to the shared interface is safe.
  const db = tx ?? prisma;

  await db.auditLog.create({
    data: {
      id: ulid(),
      actorId,
      actorRole,
      actorIp: actorIp ?? null,
      action,
      targetType: targetType ?? null,
      targetId: targetId ?? null,
      module: mod,
      before: (before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (after ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
