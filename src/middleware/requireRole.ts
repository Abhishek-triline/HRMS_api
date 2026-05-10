/**
 * requireRole — role-based access control middleware factory.
 *
 * Must be placed AFTER requireSession() so req.user is available.
 *
 * Usage:
 *   router.post('/', requireSession(), requireRole('Admin'), handler)
 *   router.get('/',  requireSession(), requireRole('Admin', 'Manager'), handler)
 *
 * Rejects with 403 FORBIDDEN when req.user.role is not in the allowed list.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { errorEnvelope, ErrorCode } from '@nexora/contracts/errors';
import type { Role } from '@nexora/contracts/common';

export function requireRole(...roles: Role[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;

    if (!user) {
      // requireSession should have already rejected; guard defensively.
      res
        .status(401)
        .json(errorEnvelope(ErrorCode.UNAUTHENTICATED, 'No active session.'));
      return;
    }

    if (!roles.includes(user.role as Role)) {
      // SEC-004-P1: do not echo the caller's role or the required role in the
      // response body. The role is already discoverable via /auth/me for the
      // legitimate user; we don't need to advertise the role-policy map to
      // unauthorised callers (DN-18 — no role leakage).
      res
        .status(403)
        .json(errorEnvelope(ErrorCode.FORBIDDEN, 'You are not authorised for this action.'));
      return;
    }

    next();
  };
}
