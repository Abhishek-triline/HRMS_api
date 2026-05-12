/**
 * Idempotency-Key middleware — SEC-004-P3 (v2).
 *
 * v2 changes:
 *   - employeeId is INT (was userId string).
 *   - IdempotencyKey schema uses employeeId + key (no userId/path/status/responseBody).
 *   - responseSnapshot replaces responseBody.
 *   - No status column — replay always returns 200.
 *
 * Convention (docs/HRMS_API.md § 1):
 *   - Mutation endpoints accept an optional `Idempotency-Key` header.
 *   - Duplicates within 24h (scoped to employeeId + key) return the original
 *     response without re-applying any side effects.
 *   - The key is scoped to (employeeId, key): one user's key never collides
 *     with another user's identical key string.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Returns a middleware that implements idempotency for the calling endpoint.
 * Requires `req.user` to be populated (place after requireSession()).
 */
export function idempotencyKey(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = req.headers['idempotency-key'] as string | undefined;

    if (!key) {
      // No header — pass through
      next();
      return;
    }

    const user = req.user;
    if (!user) {
      // No session — let requireSession() handle this; just pass through
      next();
      return;
    }

    const employeeId = user.id; // INT
    const endpoint = req.path;
    const cutoff = new Date(Date.now() - TTL_MS);

    try {
      // Check for a cache hit
      const existing = await prisma.idempotencyKey.findFirst({
        where: {
          employeeId,
          key,
          endpoint,
          createdAt: { gt: cutoff },
        },
      });

      if (existing) {
        // Replay the cached response
        logger.debug(
          { employeeId, key, endpoint },
          'idempotency-key: cache hit — replaying cached response',
        );
        res.status(200).json(existing.responseSnapshot);
        return;
      }
    } catch (err) {
      // Cache lookup failure — allow the request to proceed (fail-open)
      logger.warn({ err, key, employeeId }, 'idempotency-key: cache lookup failed, proceeding without cache');
      next();
      return;
    }

    // Cache miss — wrap res.json() to capture the first successful response
    const originalJson = res.json.bind(res);
    let statusCode = 200;

    // Capture status code
    const originalStatus = res.status.bind(res);
    res.status = (code: number) => {
      statusCode = code;
      return originalStatus(code);
    };

    res.json = (body: unknown) => {
      // Only cache successful (2xx) responses
      if (statusCode >= 200 && statusCode < 300) {
        prisma.idempotencyKey
          .create({
            data: {
              employeeId,
              key,
              endpoint,
              responseSnapshot: body as never,
            },
          })
          .catch((cacheErr: unknown) => {
            logger.warn(
              { cacheErr, key, employeeId },
              'idempotency-key: failed to persist cache entry',
            );
          });
      }
      return originalJson(body);
    };

    next();
  };
}
