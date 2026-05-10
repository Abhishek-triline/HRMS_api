/**
 * Idempotency-Key middleware — SEC-004-P3 close-out.
 *
 * Convention (docs/HRMS_API.md § 1):
 *   - Mutation endpoints accept an optional `Idempotency-Key` header.
 *   - Duplicates within 24h (scoped to userId + key) return the original
 *     response without re-applying any side effects.
 *   - The key is scoped to (userId, key): one user's key never collides
 *     with another user's identical key string.
 *
 * Behaviour:
 *   1. If no `Idempotency-Key` header → pass through unchanged.
 *   2. Cache hit (same userId + key, path matches, within 24h) → replay
 *      original status + body immediately.
 *   3. Cache miss → intercept the first successful 2xx response and
 *      persist it. Subsequent calls replay it.
 *   4. Error responses (4xx/5xx) are NEVER cached — repeat attempts should
 *      always be fresh (the client may be retrying after fixing the input).
 *
 * Applied to all payroll mutations:
 *   POST /payroll/runs
 *   POST /payroll/runs/:id/finalise
 *   POST /payroll/runs/:id/reverse
 *   PATCH /payslips/:id/tax
 *   PATCH /config/tax
 *
 * Cleanup: a daily cron at 03:00 IST deletes rows older than 24h.
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

    const userId = user.id;
    const path = req.path;
    const cutoff = new Date(Date.now() - TTL_MS);

    try {
      // Check for a cache hit
      const existing = await prisma.idempotencyKey.findFirst({
        where: {
          userId,
          key,
          path,
          createdAt: { gt: cutoff },
        },
      });

      if (existing) {
        // Replay the cached response
        logger.debug(
          { userId, key, path, status: existing.status },
          'idempotency-key: cache hit — replaying cached response',
        );
        res.status(existing.status).json(existing.responseBody);
        return;
      }
    } catch (err) {
      // Cache lookup failure — allow the request to proceed (fail-open)
      logger.warn({ err, key, userId }, 'idempotency-key: cache lookup failed, proceeding without cache');
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
              userId,
              key,
              path,
              status: statusCode,
              responseBody: body as never,
            },
          })
          .catch((cacheErr: unknown) => {
            logger.warn(
              { cacheErr, key, userId },
              'idempotency-key: failed to persist cache entry',
            );
          });
      }
      return originalJson(body);
    };

    next();
  };
}
