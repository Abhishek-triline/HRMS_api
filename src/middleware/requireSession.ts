/**
 * requireSession — session authentication middleware (v2).
 *
 * Reads the signed session cookie, looks up the Session row by token,
 * attaches req.user with INT IDs (employeeId: number, roleId: number).
 * Rejects with 401 UNAUTHENTICATED on any miss or expired session.
 *
 * v2 changes from Phase 3:
 *   - Session.id is INT; looked up by Session.token (public random hex).
 *   - req.user.id is INT (was string cuid).
 *   - req.user.roleId is INT (replaces string role field).
 *   - Employee status comparison uses EmployeeStatus INT constants.
 *   - Employee includes department/designation via master relations.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { errorEnvelope, ErrorCode } from '@nexora/contracts/errors';
import type { AuthUser } from '@nexora/contracts/auth';
import { prisma } from '../lib/prisma.js';
import { EmployeeStatus } from '../lib/statusInt.js';

// Augment Express Request to carry the authenticated user.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser & { sessionId: number };
      sessionId?: number;
    }
  }
}

const COOKIE_NAME = process.env['SESSION_COOKIE_NAME'] ?? 'nx_session';

export function requireSession(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // cookie-parser populates req.signedCookies when initialized with a secret
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cookie-parser runtime augmentation
    const signedCookies = (req as any).signedCookies as Record<string, string | false> | undefined;
    const rawCookie = signedCookies?.[COOKIE_NAME];
    // cookie-parser returns `false` for cookies with invalid signatures
    const sessionToken = typeof rawCookie === 'string' ? rawCookie : undefined;

    if (!sessionToken) {
      res.status(401).json(errorEnvelope(ErrorCode.UNAUTHENTICATED, 'No active session.'));
      return;
    }

    // Look up session by public token, include employee with master relations
    const session = await prisma.session.findUnique({
      where: { token: sessionToken },
      include: {
        employee: {
          include: {
            department: { select: { name: true } },
            designation: { select: { name: true } },
          },
        },
      },
    });

    if (!session || session.expiresAt < new Date()) {
      // Delete stale session if found
      if (session) {
        await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
      }
      res
        .clearCookie(COOKIE_NAME)
        .status(401)
        .json(errorEnvelope(ErrorCode.UNAUTHENTICATED, 'Session expired or invalid.'));
      return;
    }

    const { employee } = session;

    // SEC-002-P2: Exited (5) or Inactive (4) employees must not authenticate.
    if (employee.status === EmployeeStatus.Exited || employee.status === EmployeeStatus.Inactive) {
      await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
      res.clearCookie(COOKIE_NAME, { path: '/' });
      res
        .status(401)
        .json(errorEnvelope(ErrorCode.UNAUTHENTICATED, 'Session is no longer valid.'));
      return;
    }

    req.user = {
      id: employee.id,
      code: employee.code,
      email: employee.email,
      name: employee.name,
      roleId: employee.roleId,
      status: employee.status,
      department: employee.department?.name ?? null,
      designation: employee.designation?.name ?? null,
      reportingManagerId: employee.reportingManagerId ?? null,
      mustResetPassword: employee.mustResetPassword,
      sessionId: session.id,
    };

    req.sessionId = session.id;

    // Slide the session expiry (12h or 30-day depending on current TTL length)
    const now = new Date();
    const remaining = session.expiresAt.getTime() - now.getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const isLong = remaining > thirtyDaysMs - 5 * 60 * 1000; // was created with rememberMe
    const ttlMs = isLong ? thirtyDaysMs : 12 * 60 * 60 * 1000;
    const newExpiry = new Date(now.getTime() + ttlMs);

    // Fire-and-forget expiry slide
    prisma.session
      .update({ where: { id: session.id }, data: { expiresAt: newExpiry } })
      .catch(() => undefined);

    next();
  };
}
