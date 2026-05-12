/**
 * Notifications routes — v2 schema (INT IDs, INT categoryId).
 *
 * Mounted at /api/v1/notifications
 *
 * Endpoints:
 *   GET  /                   — own notification feed (BL-044: recipientId = user.id)
 *   POST /mark-read          — mark { ids } or { all: true } as read
 *   GET  /unread-count       — lightweight count for the bell icon
 *
 * Business rules enforced:
 *   BL-043  No public creation — system-generated only (enforced by absence of POST /)
 *   BL-044  Every query is scoped to recipientId = req.user.id — never cross-user
 *   BL-045  Retention handled by the daily cron (not here)
 *   BL-046  In-app only — no external delivery
 *   DN-26   No user-authored notifications
 *   DN-27   No external delivery in v1
 *
 * Audit: mark-read is a read-state toggle, NOT a business state change.
 * No audit entries are written for these routes (per spec).
 *
 * v2 schema notes:
 *   - Notification.id is INT (not cuid)
 *   - Notification.categoryId is INT FK
 *   - cursor is String(id) / Number(cursor)
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { requireSession } from '../../middleware/requireSession.js';
import { validateBody } from '../../middleware/validateBody.js';
import { validateQuery } from '../../middleware/validateQuery.js';
import { errorEnvelope, ErrorCode } from '@nexora/contracts/errors';
import {
  NotificationListQuerySchema,
  MarkReadRequestSchema,
} from '@nexora/contracts/notifications';
import type {
  NotificationListQuery,
  MarkReadRequest,
} from '@nexora/contracts/notifications';
import { logger } from '../../lib/logger.js';

export const notificationsRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format a Notification row to the contract shape. */
function formatNotification(n: {
  id: number;
  recipientId: number;
  categoryId: number;
  title: string;
  body: string;
  link: string | null;
  unread: boolean;
  auditLogId: number | null;
  createdAt: Date;
}) {
  return {
    id: n.id,
    recipientId: n.recipientId,
    categoryId: n.categoryId,
    title: n.title,
    body: n.body,
    link: n.link,
    unread: n.unread,
    auditLogId: n.auditLogId,
    createdAt: n.createdAt.toISOString(),
  };
}

// ── GET /notifications ────────────────────────────────────────────────────────
// Own feed — cursor-paginated, newest first. BL-044: recipientId = user.id always.

notificationsRouter.get(
  '/',
  requireSession(),
  validateQuery(NotificationListQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const query = req.query as unknown as NotificationListQuery;

    try {
      const limit = Math.min(Number(query.limit ?? 20), 100);

      // BL-044: ALWAYS scope to the authenticated user's own feed.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: Record<string, any> = {
        recipientId: user.id, // INVARIANT — never remove this
      };

      // Optional: filter by categoryId (single or multi-value INT)
      if (query.categoryId !== undefined) {
        const cats = Array.isArray(query.categoryId) ? query.categoryId : [query.categoryId];
        where['categoryId'] = { in: cats };
      }

      // Optional: show only unread
      if (query.unread !== undefined) {
        where['unread'] = query.unread;
      }

      // Optional: newer than a given timestamp
      if (query.since !== undefined) {
        where['createdAt'] = { gte: new Date(query.since) };
      }

      // Cursor-based pagination (cursor is String(id) of the last seen row).
      // BUG-NOT-005: use keyset (createdAt, id) so same-millisecond fan-out rows
      // (e.g. payroll finalise) are never dropped at page boundaries.
      if (query.cursor) {
        const cursorId = Number(query.cursor);
        if (!isNaN(cursorId)) {
          const cursorRow = await prisma.notification.findFirst({
            where: { id: cursorId, recipientId: user.id }, // BL-044 scoped
            select: { createdAt: true, id: true },
          });
          if (cursorRow) {
            // Items strictly older than the cursor row, OR same createdAt but smaller id.
            where['OR'] = [
              { createdAt: { lt: cursorRow.createdAt } },
              { createdAt: cursorRow.createdAt, id: { lt: cursorRow.id } },
            ];
          }
        }
      }

      const rows = await prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const lastId = items[items.length - 1]?.id ?? null;
      const nextCursor = hasMore && lastId !== null ? String(lastId) : null;

      res.status(200).json({
        data: items.map(formatNotification),
        nextCursor,
      });
    } catch (err: unknown) {
      logger.error({ err, userId: user.id }, 'notifications.list: error');
      res.status(500).json(
        errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to load notifications.'),
      );
    }
  },
);

// ── POST /notifications/mark-read ─────────────────────────────────────────────
// Mark specific IDs or ALL unread as read. BL-044: intersection with recipientId.

notificationsRouter.post(
  '/mark-read',
  requireSession(),
  validateBody(MarkReadRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const body = req.body as MarkReadRequest;

    try {
      let updated: number;

      if ('all' in body && body.all === true) {
        // Mark all unread notifications for this user as read
        const result = await prisma.notification.updateMany({
          where: {
            recipientId: user.id, // BL-044: INVARIANT
            unread: true,
          },
          data: { unread: false },
        });
        updated = result.count;
      } else if ('ids' in body && Array.isArray(body.ids)) {
        // ids from contract are numbers in v2
        const numericIds = body.ids.map(Number).filter((n) => !isNaN(n));

        // Mark specific IDs as read — intersect with recipientId so a caller
        // can NEVER affect another user's notifications (BL-044).
        const result = await prisma.notification.updateMany({
          where: {
            id: { in: numericIds },
            recipientId: user.id, // BL-044: INVARIANT — cross-user ids silently ignored
            unread: true,
          },
          data: { unread: false },
        });
        updated = result.count;

        // SEC-002-P6: Detect and log possible IDOR attempts.
        if (result.count < numericIds.length) {
          logger.warn(
            {
              userId: user.id,
              requestedIds: numericIds.length,
              updatedCount: result.count,
              missingCount: numericIds.length - result.count,
            },
            'notifications.mark-read: some IDs did not match caller — possible IDOR attempt',
          );
        }
      } else {
        updated = 0;
      }

      res.status(200).json({ data: { updated } });
    } catch (err: unknown) {
      logger.error({ err, userId: user.id }, 'notifications.mark-read: error');
      res.status(500).json(
        errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to mark notifications as read.'),
      );
    }
  },
);

// ── GET /notifications/unread-count ──────────────────────────────────────────
// Lightweight count(*) for the header bell. BL-044: recipientId = user.id.

notificationsRouter.get(
  '/unread-count',
  requireSession(),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;

    try {
      const count = await prisma.notification.count({
        where: {
          recipientId: user.id, // BL-044: INVARIANT
          unread: true,
        },
      });

      res.status(200).json({ data: { count } });
    } catch (err: unknown) {
      logger.error({ err, userId: user.id }, 'notifications.unread-count: error');
      res.status(500).json(
        errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to get unread count.'),
      );
    }
  },
);
