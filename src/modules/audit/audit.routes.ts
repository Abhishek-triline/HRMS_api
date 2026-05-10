/**
 * Audit Log routes — Phase 7.
 *
 * Mounted at /api/v1/audit-logs.
 *
 * BL-047: append-only — there is NO POST, PUT, PATCH, or DELETE here.
 * BL-048: DB enforces append-only via REVOKE UPDATE/DELETE on audit_log.
 *
 * Endpoints:
 *   GET /api/v1/audit-logs   Admin only. Cursor-paginated list with filters.
 *
 * Filters (all optional):
 *   actorId, actorRole, module, action (substring), targetType, targetId,
 *   from (ISO datetime), to (ISO datetime), q (free-text substring on action).
 *
 * Pagination: keyset cursor — field `id` (ULID = lexicographically ordered by
 * creation time). Default sort is createdAt DESC, id DESC.
 * The cursor value is the `id` of the last item returned.
 * On the next page: WHERE id < :cursor (DESC ordering).
 *
 * Indexes backing this query (created in Phase 7 migration):
 *   idx_audit_log_created_at_id   (created_at DESC, id DESC)
 *   idx_audit_log_module_created_at (module, created_at DESC)
 *   idx_audit_log_actor_created_at  (actor_id, created_at DESC)
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { requireSession } from '../../middleware/requireSession.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateQuery } from '../../middleware/validateQuery.js';
import { errorEnvelope, ErrorCode } from '@nexora/contracts/errors';
import { AuditLogListQuerySchema } from '@nexora/contracts/audit';
import { logger } from '../../lib/logger.js';
import type { Prisma } from '@prisma/client';

export const auditRouter = Router();

// ── GET /audit-logs ───────────────────────────────────────────────────────────

auditRouter.get(
  '/',
  requireSession(),
  requireRole('Admin'),
  validateQuery(AuditLogListQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const query = req.query as unknown as {
        cursor?: string;
        limit: number;
        actorId?: string;
        actorRole?: string;
        module?: string;
        action?: string;
        targetType?: string;
        targetId?: string;
        from?: string;
        to?: string;
        q?: string;
      };

      const limit = Math.min(Number(query.limit) || 20, 100);

      // Build Prisma where clause from query filters
      const where: Prisma.AuditLogWhereInput = {};

      if (query.actorId) {
        where.actorId = query.actorId;
      }

      if (query.actorRole) {
        where.actorRole = query.actorRole;
      }

      if (query.module) {
        where.module = query.module;
      }

      if (query.targetType) {
        where.targetType = query.targetType;
      }

      if (query.targetId) {
        where.targetId = query.targetId;
      }

      // action filter — substring match OR q free-text (both map to the same field)
      const actionSearch = query.action ?? query.q;
      if (actionSearch) {
        where.action = { contains: actionSearch };
      }

      // Date range filters on createdAt
      if (query.from || query.to) {
        where.createdAt = {};
        if (query.from) {
          (where.createdAt as Prisma.DateTimeFilter).gte = new Date(query.from);
        }
        if (query.to) {
          (where.createdAt as Prisma.DateTimeFilter).lte = new Date(query.to);
        }
      }

      // Keyset cursor — id is a ULID (lexicographically monotonic)
      // DESC ordering: cursor = last id seen → next page has id < cursor
      if (query.cursor) {
        // Combine with any existing createdAt filter safely
        const cursorRow = await prisma.auditLog.findUnique({
          where: { id: query.cursor },
          select: { id: true, createdAt: true },
        });

        if (!cursorRow) {
          res.status(400).json(
            errorEnvelope(ErrorCode.VALIDATION_FAILED, 'Invalid cursor — row not found.'),
          );
          return;
        }

        // For DESC ordering by (createdAt, id): next page items have
        // createdAt < cursor.createdAt OR (createdAt = cursor.createdAt AND id < cursor.id)
        const cursorCondition: Prisma.AuditLogWhereInput = {
          OR: [
            { createdAt: { lt: cursorRow.createdAt } },
            {
              createdAt: { equals: cursorRow.createdAt },
              id: { lt: cursorRow.id },
            },
          ],
        };

        // Merge with existing where using AND
        const existingWhere = { ...where };
        where.AND = [existingWhere, cursorCondition];

        // Clear the top-level fields that we moved into AND
        delete where.actorId;
        delete where.actorRole;
        delete where.module;
        delete where.targetType;
        delete where.targetId;
        delete where.action;
        delete where.createdAt;
      }

      const rows = await prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1, // fetch one extra to determine if there's a next page
      });

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

      res.status(200).json({
        data: items.map((row) => ({
          id: row.id,
          actorId: row.actorId,
          actorRole: row.actorRole,
          actorIp: row.actorIp,
          action: row.action,
          module: row.module,
          targetType: row.targetType,
          targetId: row.targetId,
          before: row.before,
          after: row.after,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor,
      });
    } catch (err: unknown) {
      logger.error({ err }, 'audit-logs.list: unexpected error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred.'));
    }
  },
);
