/**
 * Audit Log routes — v2 schema (INT IDs, master table FKs).
 *
 * Mounted at /api/v1/audit-logs.
 *
 * BL-047: append-only — there is NO POST, PUT, PATCH, or DELETE here.
 * BL-048: DB enforces append-only via REVOKE UPDATE/DELETE on audit_log.
 *
 * Endpoints:
 *   GET /api/v1/audit-logs   Admin only. Cursor-paginated list with filters.
 *
 * v2 schema notes:
 *   - AuditLog.actorRoleId: INT FK (not string actorRole)
 *   - AuditLog.moduleId: INT FK to AuditModule.id
 *   - AuditLog.targetTypeId: INT FK to AuditTargetType.id
 *   - Filters by module/targetType/actorRole use name→id lookups on master tables
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
import { RoleId } from '../../lib/statusInt.js';

export const auditRouter = Router();

// ── GET /audit-logs ───────────────────────────────────────────────────────────

auditRouter.get(
  '/',
  requireSession(),
  requireRole(RoleId.Admin),
  validateQuery(AuditLogListQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      // After validateQuery(AuditLogListQuerySchema) zod coerces numeric params
      // to actual numbers — but the local coercion below is a defence-in-depth
      // belt-and-braces (also helps in unit tests that mock the validator).
      const raw = req.query as Record<string, string | number | undefined>;
      const toInt = (v: unknown): number | undefined => {
        if (v === undefined || v === null || v === '') return undefined;
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) ? n : undefined;
      };
      const query = {
        cursor: raw['cursor'] as string | undefined,
        limit: toInt(raw['limit']) ?? 20,
        actorId: toInt(raw['actorId']),
        actorRoleId: toInt(raw['actorRoleId']),
        moduleId: toInt(raw['moduleId']),
        targetTypeId: toInt(raw['targetTypeId']),
        targetId: toInt(raw['targetId']),
        action: raw['action'] as string | undefined,
        from: raw['from'] as string | undefined,
        to: raw['to'] as string | undefined,
        q: raw['q'] as string | undefined,
      };

      const limit = Math.min(query.limit, 100);

      // Build Prisma where clause from query filters. All filter values are
      // INT codes per HRMS_Schema_v2_Plan §3 — no name→id lookup needed.
      const where: Prisma.AuditLogWhereInput = {};

      if (query.actorId !== undefined) {
        where.actorId = query.actorId;
      }
      if (query.actorRoleId !== undefined) {
        where.actorRoleId = query.actorRoleId;
      }
      if (query.moduleId !== undefined) {
        where.moduleId = query.moduleId;
      }
      if (query.targetTypeId !== undefined) {
        where.targetTypeId = query.targetTypeId;
      }
      if (query.targetId !== undefined) {
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

      // Keyset cursor — id is an INT (auto-increment), DESC ordering
      if (query.cursor) {
        const cursorId = Number(query.cursor);
        if (isNaN(cursorId)) {
          res.status(400).json(
            errorEnvelope(ErrorCode.VALIDATION_FAILED, 'Invalid cursor.'),
          );
          return;
        }

        // Merge cursor condition with existing where
        const existingWhere = { ...where };
        // Clear top-level fields moved into AND
        delete where.actorId;
        delete where.actorRoleId;
        delete where.moduleId;
        delete where.targetTypeId;
        delete where.targetId;
        delete where.action;
        delete where.createdAt;

        where.AND = [existingWhere, { id: { lt: cursorId } }];
      }

      const rows = await prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        include: {
          module: { select: { name: true } },
        },
      });

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? String(items[items.length - 1]?.id ?? null) : null;

      res.status(200).json({
        data: items.map((row) => ({
          id: row.id,
          actorId: row.actorId,
          actorRoleId: row.actorRoleId,
          actorIp: row.actorIp,
          action: row.action,
          moduleId: row.moduleId,
          moduleName: row.module.name,
          targetTypeId: row.targetTypeId,
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

// ── GET /audit-logs/export ────────────────────────────────────────────────────
// Returns every audit row that matches the same filter set as /audit-logs in
// a single JSON response. Used by the admin Audit Log page to drive a "real"
// CSV export instead of dumping only the rows that happened to be loaded into
// the infinite-scroll buffer. Hard-capped at 20,000 rows server-side as a
// DoS / runaway guard; the client surfaces a "narrow your filter" hint when
// `truncated` is true.

const AUDIT_EXPORT_CAP = 20000;

auditRouter.get(
  '/export',
  requireSession(),
  requireRole(RoleId.Admin),
  validateQuery(AuditLogListQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const raw = req.query as Record<string, string | number | undefined>;
      const toInt = (v: unknown): number | undefined => {
        if (v === undefined || v === null || v === '') return undefined;
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) ? n : undefined;
      };
      const query = {
        actorId: toInt(raw['actorId']),
        actorRoleId: toInt(raw['actorRoleId']),
        moduleId: toInt(raw['moduleId']),
        targetTypeId: toInt(raw['targetTypeId']),
        targetId: toInt(raw['targetId']),
        action: raw['action'] as string | undefined,
        from: raw['from'] as string | undefined,
        to: raw['to'] as string | undefined,
        q: raw['q'] as string | undefined,
      };

      const where: Prisma.AuditLogWhereInput = {};
      if (query.actorId !== undefined) where.actorId = query.actorId;
      if (query.actorRoleId !== undefined) where.actorRoleId = query.actorRoleId;
      if (query.moduleId !== undefined) where.moduleId = query.moduleId;
      if (query.targetTypeId !== undefined) where.targetTypeId = query.targetTypeId;
      if (query.targetId !== undefined) where.targetId = query.targetId;
      const actionSearch = query.action ?? query.q;
      if (actionSearch) where.action = { contains: actionSearch };
      if (query.from || query.to) {
        where.createdAt = {};
        if (query.from) (where.createdAt as Prisma.DateTimeFilter).gte = new Date(query.from);
        if (query.to) (where.createdAt as Prisma.DateTimeFilter).lte = new Date(query.to);
      }

      const rows = await prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: AUDIT_EXPORT_CAP + 1,
        include: { module: { select: { name: true } } },
      });

      const truncated = rows.length > AUDIT_EXPORT_CAP;
      const items = truncated ? rows.slice(0, AUDIT_EXPORT_CAP) : rows;

      res.status(200).json({
        data: items.map((row) => ({
          id: row.id,
          actorId: row.actorId,
          actorRoleId: row.actorRoleId,
          actorIp: row.actorIp,
          action: row.action,
          moduleId: row.moduleId,
          moduleName: row.module.name,
          targetTypeId: row.targetTypeId,
          targetId: row.targetId,
          before: row.before,
          after: row.after,
          createdAt: row.createdAt.toISOString(),
        })),
        total: items.length,
        truncated,
      });
    } catch (err: unknown) {
      logger.error({ err }, 'audit-logs.export: unexpected error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to export audit log.'));
    }
  },
);
