/**
 * Auth router — mounted at /api/v1/auth.
 *
 * Endpoints (HRMS_API.md § 4):
 *   POST /login                     UC-AUTH-01
 *   POST /logout                    —
 *   POST /forgot-password           UC-FL-02
 *   POST /reset-password            UC-FL-02
 *   POST /first-login/set-password  UC-FL-01
 *   GET  /me                        —
 *
 * Business rules enforced:
 *   BL-005 (lockout — relaxed to 25 strikes / 5 min)
 *   BL-047 (audit every auth event)
 *   UC-FL-01 (first login → must set password)
 *   UC-FL-02 (forgot/reset password flow, no enumeration leak)
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  LoginRequestSchema,
  ForgotPasswordRequestSchema,
  ResetPasswordRequestSchema,
  FirstLoginSetPasswordRequestSchema,
} from '@nexora/contracts/auth';
import { errorEnvelope, ErrorCode } from '@nexora/contracts/errors';
import { validateBody } from '../../middleware/validateBody.js';
import { requireSession } from '../../middleware/requireSession.js';
import { audit } from '../../lib/audit.js';
import { sendMail } from '../../lib/mailer.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import {
  EmployeeStatus,
  TokenPurpose,
  type RoleIdValue,
  type AuditActorRoleValue,
} from '../../lib/statusInt.js';
import {
  hashPassword,
  verifyPassword,
  recordLoginAttempt,
  isLockedOut,
  lockoutRetryAfterSeconds,
  createSessionFor,
  permissionsFor,
  generateToken,
  hashToken,
  decoyHash,
} from './auth.service.js';

const router = Router();

const COOKIE_NAME = process.env['SESSION_COOKIE_NAME'] ?? 'nx_session';
// SESSION_COOKIE_DOMAIN — set to the parent registrable domain in production
// (e.g. ".tlitech.net") when the web and API live on different subdomains so
// the cookie is shared across both. Leave empty in dev (localhost) — the
// browser will scope the cookie to the host automatically.
const COOKIE_DOMAIN = process.env['SESSION_COOKIE_DOMAIN'] ?? '';
const SESSION_TTL_HOURS = Number(process.env['SESSION_TTL_HOURS'] ?? 12);
const SESSION_REMEMBER_ME_DAYS = Number(process.env['SESSION_REMEMBER_ME_DAYS'] ?? 30);
const PASSWORD_RESET_TTL_MINUTES = Number(process.env['PASSWORD_RESET_TTL_MINUTES'] ?? 30);
const WEB_BASE_URL = process.env['WEB_BASE_URL'] ?? 'http://localhost:3000';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve the requesting IP for audit + lockout purposes.
 *
 * SEC-002: We deliberately do NOT honour `X-Forwarded-For` directly.
 * Express's `req.ip` already reflects XFF when `app.set('trust proxy', N)`
 * is configured (see index.ts) — and only when configured. In default
 * (no-proxy) mode, `req.ip` is the socket address, which an external
 * attacker cannot spoof. Trusting raw XFF here would let an attacker
 * rotate header values to bypass the BL-005 5-strikes lockout.
 */
function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/**
 * Set the session cookie using cookie-parser's signed cookie support.
 * The cookie value is signed with SESSION_SECRET (set in cookieParser(SECRET) in index.ts).
 * HttpOnly + Secure + SameSite=Lax (BL-003 / SRS § 9.2).
 */
function setSessionCookie(
  res: Response,
  token: string,
  rememberMe: boolean,
): void {
  const maxAge = rememberMe
    ? SESSION_REMEMBER_ME_DAYS * 24 * 60 * 60
    : SESSION_TTL_HOURS * 60 * 60;

  // res.cookie with `signed: true` uses the secret passed to cookieParser()
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env['NODE_ENV'] === 'production',
    sameSite: 'lax',
    maxAge: maxAge * 1000, // express expects ms
    path: '/',
    signed: true,
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  });
}

// ── POST /login ───────────────────────────────────────────────────────────────

router.post('/login', validateBody(LoginRequestSchema), async (req: Request, res: Response) => {
  const { email, password, rememberMe } = req.body as {
    email: string;
    password: string;
    rememberMe: boolean;
  };
  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'];

  try {
    // 5-strikes lockout check (BL-005)
    if (await isLockedOut(email, ip)) {
      const retryAfter = await lockoutRetryAfterSeconds(email, ip);
      // SEC-004: lockouts are an auditable security event — record before responding.
      await audit({
        actorId: null,
        actorRole: 'unknown',
        actorIp: ip,
        action: 'auth.login.lockout',
        targetType: 'Employee',
        targetId: null,
        module: 'auth',
        after: { email, retryAfterSeconds: retryAfter },
      });
      res
        .status(423)
        .setHeader('Retry-After', String(retryAfter))
        .json(
          errorEnvelope(
            ErrorCode.LOCKED,
            `Account locked due to too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
            { details: { retryAfterSeconds: retryAfter } },
          ),
        );
      return;
    }

    // Look up employee by email
    const employee = await prisma.employee.findUnique({
      where: { email: email.toLowerCase() },
    });

    // SEC-005: always run argon2 verification — even on miss — so the response
    // time does not leak whether the email exists. The decoy hash is a real
    // argon2id hash of an unguessable random string generated at first use.
    const hashToVerify = employee?.passwordHash ?? (await decoyHash());
    const verified = await verifyPassword(password, hashToVerify);
    const passwordOk = employee ? verified : false;

    if (!employee || !passwordOk) {
      await recordLoginAttempt({ email, ip, success: false, employeeId: employee?.id ?? null });
      await audit({
        actorId: employee?.id ?? null,
        actorRole: (employee?.roleId ?? 'unknown') as AuditActorRoleValue | 'unknown',
        actorIp: ip,
        action: 'auth.login.failure',
        targetType: 'Employee',
        targetId: employee?.id ?? null,
        module: 'auth',
      });
      res
        .status(401)
        .json(errorEnvelope(ErrorCode.INVALID_CREDENTIALS, 'Invalid email or password.'));
      return;
    }

    // SEC-002-P2: an Exited employee MUST NOT be allowed to log in even with
    // a valid password. Same for the placeholder Inactive state — the only
    // way out of Inactive is the first-login flow, which uses its own
    // dedicated endpoint. We surface a generic INVALID_CREDENTIALS to avoid
    // leaking the account-status detail to a brute-forcer.
    if (employee.status === EmployeeStatus.Exited || employee.status === EmployeeStatus.Inactive) {
      await recordLoginAttempt({ email, ip, success: false, employeeId: employee.id });
      await audit({
        actorId: employee.id,
        actorRole: employee.roleId as AuditActorRoleValue,
        actorIp: ip,
        action: 'auth.login.blocked-status',
        targetType: 'Employee',
        targetId: employee.id,
        module: 'auth',
        after: { status: employee.status },
      });
      res
        .status(401)
        .json(errorEnvelope(ErrorCode.INVALID_CREDENTIALS, 'Invalid email or password.'));
      return;
    }

    // Success — record, create session, set cookie
    await recordLoginAttempt({ email, ip, success: true, employeeId: employee.id });

    const { token } = await createSessionFor({
      employeeId: employee.id,
      ip,
      userAgent,
      rememberMe: rememberMe ?? false,
    });

    setSessionCookie(res, token, rememberMe ?? false);

    await audit({
      actorId: employee.id,
      actorRole: employee.roleId as AuditActorRoleValue,
      actorIp: ip,
      action: 'auth.login.success',
      targetType: 'Employee',
      targetId: employee.id,
      module: 'auth',
    });

    res.status(200).json({
      data: {
        user: {
          id: employee.id,
          code: employee.code,
          email: employee.email,
          name: employee.name,
          roleId: employee.roleId,
          status: employee.status,
          departmentId: employee.departmentId ?? null,
          designationId: employee.designationId ?? null,
          reportingManagerId: employee.reportingManagerId ?? null,
          mustResetPassword: employee.mustResetPassword,
        },
        roleId: employee.roleId,
      },
    });
  } catch (err: unknown) {
    logger.error({ err }, 'auth.login.error');
    res
      .status(500)
      .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Login failed due to a server error.'));
  }
});

// ── POST /logout ──────────────────────────────────────────────────────────────

router.post('/logout', requireSession(), async (req: Request, res: Response) => {
  const user = req.user!;
  const ip = clientIp(req);

  try {
    // Delete session row by INT id
    if (user.sessionId) {
      await prisma.session.delete({ where: { id: user.sessionId } }).catch(() => undefined);
    }

    await audit({
      actorId: user.id,
      actorRole: user.roleId as RoleIdValue,
      actorIp: ip,
      action: 'auth.logout',
      targetType: 'Employee',
      targetId: user.id,
      module: 'auth',
    });

    res.clearCookie(COOKIE_NAME, { path: '/', ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}) }).status(200).json({ data: { success: true } });
  } catch (err: unknown) {
    logger.error({ err }, 'auth.logout.error');
    res
      .status(500)
      .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Logout failed due to a server error.'));
  }
});

// ── POST /forgot-password ─────────────────────────────────────────────────────

router.post(
  '/forgot-password',
  validateBody(ForgotPasswordRequestSchema),
  async (req: Request, res: Response) => {
    const { email } = req.body as { email: string };
    const ip = clientIp(req);

    // Always return 200 — never reveal account existence (no enumeration leak)
    const GENERIC_MSG = 'If an account with that email exists, a password reset link has been sent.';

    try {
      const employee = await prisma.employee.findUnique({
        where: { email: email.toLowerCase() },
      });

      // SEC-P8-008: OnNotice employees may also request a password reset —
      // they still have active employment and should be able to recover access.
      if (
        employee &&
        [EmployeeStatus.Active, EmployeeStatus.OnNotice].includes(employee.status as typeof EmployeeStatus.Active)
      ) {
        const rawToken = generateToken();
        const tokenHash = hashToken(rawToken);
        const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000);

        await prisma.passwordResetToken.create({
          data: {
            employeeId: employee.id,
            tokenHash,
            purposeId: TokenPurpose.ResetPassword,
            expiresAt,
          },
        });

        const resetUrl = `${WEB_BASE_URL}/reset-password?token=${rawToken}`;

        await sendMail({
          to: employee.email,
          subject: 'Nexora HRMS — Password Reset',
          text: `Hello ${employee.name},\n\nUse the link below to reset your password (valid for ${PASSWORD_RESET_TTL_MINUTES} minutes):\n\n${resetUrl}\n\nIf you did not request this, please ignore this email.\n\nNexora HRMS`,
          html: `<p>Hello ${employee.name},</p><p>Click the link below to reset your password (valid for ${PASSWORD_RESET_TTL_MINUTES} minutes):</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you did not request this, ignore this email.</p>`,
        });

        await audit({
          actorId: employee.id,
          actorRole: employee.roleId as AuditActorRoleValue,
          actorIp: ip,
          action: 'auth.password.reset.requested',
          targetType: 'Employee',
          targetId: employee.id,
          module: 'auth',
        });
      } else {
        // Still audit the attempt so security team can review unusual requests
        await audit({
          actorId: null,
          actorRole: 'unknown',
          actorIp: ip,
          action: 'auth.password.reset.requested.noop',
          targetType: null,
          targetId: null,
          module: 'auth',
        });
      }

      res.status(200).json({ data: { message: GENERIC_MSG } });
    } catch (err: unknown) {
      logger.error({ err }, 'auth.forgot-password.error');
      // Still return 200 to avoid timing-based enumeration
      res.status(200).json({ data: { message: GENERIC_MSG } });
    }
  },
);

// ── POST /reset-password ──────────────────────────────────────────────────────

router.post(
  '/reset-password',
  validateBody(ResetPasswordRequestSchema),
  async (req: Request, res: Response) => {
    const { token, newPassword } = req.body as { token: string; newPassword: string };
    const ip = clientIp(req);

    try {
      const tokenHash = hashToken(token);

      const tokenRow = await prisma.passwordResetToken.findUnique({
        where: { tokenHash },
        include: { employee: true },
      });

      if (!tokenRow || tokenRow.purposeId !== TokenPurpose.ResetPassword) {
        res.status(400).json(errorEnvelope(ErrorCode.TOKEN_INVALID, 'Invalid or unknown token.'));
        return;
      }

      if (tokenRow.usedAt) {
        res
          .status(400)
          .json(errorEnvelope(ErrorCode.TOKEN_INVALID, 'This reset link has already been used.'));
        return;
      }

      if (tokenRow.expiresAt < new Date()) {
        res
          .status(400)
          .json(errorEnvelope(ErrorCode.TOKEN_EXPIRED, 'This reset link has expired. Request a new one.'));
        return;
      }

      const passwordHash = await hashPassword(newPassword);

      // Transactional: update password, mark token used, delete all sessions (BL-047 / SRS § 9.7)
      await prisma.$transaction(async (tx) => {
        await tx.employee.update({
          where: { id: tokenRow.employeeId },
          data: { passwordHash, updatedAt: new Date() },
        });

        await tx.passwordResetToken.update({
          where: { id: tokenRow.id },
          data: { usedAt: new Date() },
        });

        await tx.session.deleteMany({ where: { employeeId: tokenRow.employeeId } });

        await audit({
          tx,
          actorId: tokenRow.employeeId,
          actorRole: tokenRow.employee.roleId as AuditActorRoleValue,
          actorIp: ip,
          action: 'auth.password.reset',
          targetType: 'Employee',
          targetId: tokenRow.employeeId,
          module: 'auth',
          before: { passwordChanged: false },
          after: { passwordChanged: true, sessionsRevoked: true },
        });
      });

      res.clearCookie(COOKIE_NAME, { path: '/', ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}) }).status(200).json({ data: { success: true } });
    } catch (err: unknown) {
      logger.error({ err }, 'auth.reset-password.error');
      res
        .status(500)
        .json(
          errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Password reset failed due to a server error.'),
        );
    }
  },
);

// ── POST /first-login/set-password ────────────────────────────────────────────

router.post(
  '/first-login/set-password',
  validateBody(FirstLoginSetPasswordRequestSchema),
  async (req: Request, res: Response) => {
    const { tempCredentialsToken, newPassword } = req.body as {
      tempCredentialsToken: string;
      newPassword: string;
    };
    const ip = clientIp(req);
    const userAgent = req.headers['user-agent'];

    try {
      const tokenHash = hashToken(tempCredentialsToken);

      const tokenRow = await prisma.passwordResetToken.findUnique({
        where: { tokenHash },
        include: { employee: true },
      });

      if (!tokenRow || tokenRow.purposeId !== TokenPurpose.FirstLogin) {
        res
          .status(400)
          .json(errorEnvelope(ErrorCode.TOKEN_INVALID, 'Invalid or unknown first-login token.'));
        return;
      }

      if (tokenRow.usedAt) {
        res
          .status(400)
          .json(
            errorEnvelope(
              ErrorCode.TOKEN_INVALID,
              'This first-login link has already been used.',
            ),
          );
        return;
      }

      if (tokenRow.expiresAt < new Date()) {
        res
          .status(400)
          .json(
            errorEnvelope(
              ErrorCode.TOKEN_EXPIRED,
              'This first-login link has expired. Please contact your administrator.',
            ),
          );
        return;
      }

      const passwordHash = await hashPassword(newPassword);

      const updatedEmployee = await prisma.$transaction(async (tx) => {
        const emp = await tx.employee.update({
          where: { id: tokenRow.employeeId },
          data: {
            passwordHash,
            mustResetPassword: false,
            status: EmployeeStatus.Active,
            updatedAt: new Date(),
          },
        });

        await tx.passwordResetToken.update({
          where: { id: tokenRow.id },
          data: { usedAt: new Date() },
        });

        // SEC-007: drop any pre-existing sessions for this employee — same
        // pattern as /reset-password. An Inactive employee shouldn't have any
        // sessions, but we enforce the invariant here so the path stays
        // consistent with the rest of the auth surface.
        await tx.session.deleteMany({ where: { employeeId: tokenRow.employeeId } });

        await audit({
          tx,
          actorId: tokenRow.employeeId,
          actorRole: tokenRow.employee.roleId as AuditActorRoleValue,
          actorIp: ip,
          action: 'auth.first-login.complete',
          targetType: 'Employee',
          targetId: tokenRow.employeeId,
          module: 'auth',
          before: { mustResetPassword: true, status: tokenRow.employee.status },
          after: { mustResetPassword: false, status: EmployeeStatus.Active },
        });

        return emp;
      });

      // Create session after password is set
      const { token } = await createSessionFor({
        employeeId: tokenRow.employeeId,
        ip,
        userAgent,
        rememberMe: false,
      });

      setSessionCookie(res, token, false);

      const emp = updatedEmployee;
      res.status(200).json({
        data: {
          user: {
            id: emp.id,
            code: emp.code,
            email: emp.email,
            name: emp.name,
            roleId: emp.roleId,
            status: emp.status,
            departmentId: emp.departmentId ?? null,
            designationId: emp.designationId ?? null,
            reportingManagerId: emp.reportingManagerId ?? null,
            mustResetPassword: emp.mustResetPassword,
          },
          roleId: emp.roleId,
        },
      });
    } catch (err: unknown) {
      logger.error({ err }, 'auth.first-login.error');
      res
        .status(500)
        .json(
          errorEnvelope(
            ErrorCode.INTERNAL_ERROR,
            'First-login setup failed due to a server error.',
          ),
        );
    }
  },
);

// ── GET /me ───────────────────────────────────────────────────────────────────

router.get('/me', requireSession(), (req: Request, res: Response) => {
  const user = req.user!;

  res.status(200).json({
    data: {
      user: {
        id: user.id,
        code: user.code,
        email: user.email,
        name: user.name,
        roleId: user.roleId,
        status: user.status,
        department: user.department ?? null,
        designation: user.designation ?? null,
        reportingManagerId: user.reportingManagerId ?? null,
        mustResetPassword: user.mustResetPassword,
      },
      roleId: user.roleId,
      permissions: permissionsFor(user.roleId as RoleIdValue),
    },
  });
});

export { router as authRouter };
