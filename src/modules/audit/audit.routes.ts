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
        where.actorId = Number(query.actorId) || null;
      }

      // actorRole filter: look up the INT role id by convention
      // RoleId constants: Admin=1, Manager=2, Employee=3, PayrollOfficer=4
      if (query.actorRole) {
        const roleNameToId: Record<string, number> = {
          Admin: RoleId.Admin,
          Manager: RoleId.Manager,
          Employee: RoleId.Employee,
          PayrollOfficer: RoleId.PayrollOfficer,
        };
        const roleId = roleNameToId[query.actorRole];
        if (roleId !== undefined) {
          where.actorRoleId = roleId;
        }
        // 'system' role — actorRoleId is 0 by convention (or skip filter if not mapped)
      }

      // module filter: look up moduleId by name
      if (query.module) {
        const mod = await prisma.auditModule.findUnique({
          where: { name: query.module },
          select: { id: true },
        });
        if (mod) {
          where.moduleId = mod.id;
        } else {
          // Unknown module — return empty
          res.status(200).json({ data: [], nextCursor: null });
          return;
        }
      }

      // targetType filter: map by name to INT code (§3.9 frozen codes)
      if (query.targetType) {
        const targetTypeNameToId: Record<string, number> = {
          Employee: 1,
          LeaveRequest: 2,
          LeaveEncashment: 3,
          AttendanceRecord: 4,
          RegularisationRequest: 5,
          PayrollRun: 6,
          Payslip: 7,
          PerformanceCycle: 8,
          PerformanceReview: 9,
          Goal: 10,
          Configuration: 11,
          SalaryStructure: 12,
          Holiday: 13,
          Notification: 14,
        };
        const ttId = targetTypeNameToId[query.targetType];
        if (ttId !== undefined) {
          where.targetTypeId = ttId;
        } else {
          res.status(200).json({ data: [], nextCursor: null });
          return;
        }
      }

      if (query.targetId) {
        where.targetId = Number(query.targetId) || null;
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
          module: row.module.name,
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
