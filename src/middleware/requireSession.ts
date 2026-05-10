/**
 * requireSession — session authentication middleware.
 *
 * Reads the session cookie, loads the employee row, attaches req.user.
 * Rejects with 401 UNAUTHENTICATED on any miss or expired session.
 *
 * Usage:
 *   router.get('/me', requireSession(), handler)
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { errorEnvelope, ErrorCode } from '@nexora/contracts/errors';
import type { AuthUser } from '@nexora/contracts/auth';
import { prisma } from '../lib/prisma.js';

// Augment Express Request to carry the authenticated user.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser & { sessionId: string };
      sessionId?: string;
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
    const sessionId = typeof rawCookie === 'string' ? rawCookie : undefined;

    if (!sessionId) {
      res.status(401).json(errorEnvelope(ErrorCode.UNAUTHENTICATED, 'No active session.'));
      return;
    }

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { employee: true },
    });

    if (!session || session.expiresAt < new Date()) {
      // Delete stale session if found
      if (session) {
        await prisma.session.delete({ where: { id: sessionId } }).catch(() => undefined);
      }
      res
        .clearCookie(COOKIE_NAME)
        .status(401)
        .json(errorEnvelope(ErrorCode.UNAUTHENTICATED, 'Session expired or invalid.'));
      return;
    }

    const { employee } = session;

    // Map DB EmployeeStatus enum (no hyphens) → zod enum (with hyphens)
    const statusMap: Record<string, AuthUser['status']> = {
      Active: 'Active',
      OnNotice: 'On-Notice',
      Exited: 'Exited',
      OnLeave: 'On-Leave',
      Inactive: 'Inactive',
    };

    const mappedStatus = statusMap[employee.status] ?? 'Inactive';

    req.user = {
      id: employee.id,
      code: employee.code,
      email: employee.email,
      name: employee.name,
      role: employee.role,
      status: mappedStatus,
      department: employee.department ?? null,
      designation: employee.designation ?? null,
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
