/**
 * requireRole — role-based access control middleware factory (v2).
 *
 * Must be placed AFTER requireSession() so req.user is available.
 * v2: roles are INT IDs (RoleId constants). Accepts INT codes.
 *
 * Usage:
 *   router.post('/', requireSession(), requireRole(RoleId.Admin), handler)
 *   router.get('/',  requireSession(), requireRole(RoleId.Admin, RoleId.Manager), handler)
 *
 * Rejects with 403 FORBIDDEN when req.user.roleId is not in the allowed list.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { errorEnvelope, ErrorCode } from '@nexora/contracts/errors';
import type { RoleIdValue } from '../lib/statusInt.js';

export function requireRole(...roles: RoleIdValue[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;

    if (!user) {
      // requireSession should have already rejected; guard defensively.
      res
        .status(401)
        .json(errorEnvelope(ErrorCode.UNAUTHENTICATED, 'No active session.'));
      return;
    }

    if (!roles.includes(user.roleId as RoleIdValue)) {
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
