/**
 * Attendance routes — v2 (INT IDs, INT status codes).
 *
 * Mounted at /api/v1/attendance
 *
 * Endpoints:
 *   POST  /check-in          requireSession
 *   POST  /check-out         requireSession
 *   POST  /check-out/undo    requireSession
 *   GET   /me/today          requireSession
 *   GET   /me                requireSession
 *   GET   /team              Manager / Admin
 *   GET   /                  Admin
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { requireSession } from '../../middleware/requireSession.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateQuery } from '../../middleware/validateQuery.js';
import { errorEnvelope, ErrorCode } from '@nexora/contracts/errors';
import { AttendanceListQuerySchema, AttendanceStatsQuerySchema } from '@nexora/contracts/attendance';
import { getSubordinateIds } from '../employees/hierarchy.js';
import { logger } from '../../lib/logger.js';
import { getAttendanceConfig } from '../../lib/config.js';
import { RoleId, AttendanceSource, AttendanceStatus } from '../../lib/statusInt.js';
import {
  recordCheckIn,
  recordCheckOut,
  undoCheckOutForEmployee,
  findOpenAttendance,
  formatAttendanceRecord,
} from './attendance.service.js';

export const attendanceRouter = Router();

// ── POST /attendance/check-in ─────────────────────────────────────────────────

attendanceRouter.post(
  '/check-in',
  requireSession(),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const now = new Date();

    try {
      const result = await prisma.$transaction(async (tx) => {
        return recordCheckIn(user.id, now, tx, { roleId: user.roleId, ip: req.ip ?? null });
      });

      res.status(200).json({
        data: {
          record: formatAttendanceRecord(result.record),
          lateMarkDeductionApplied: result.lateMarkDeductionApplied,
          lateMonthCount: result.lateMonthCount,
        },
      });
    } catch (err: unknown) {
      logger.error({ err, employeeId: user.id }, 'attendance.check-in: error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to record check-in.'));
    }
  },
);

// ── POST /attendance/check-out ────────────────────────────────────────────────

attendanceRouter.post(
  '/check-out',
  requireSession(),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const now = new Date();

    try {
      const result = await prisma.$transaction(async (tx) => {
        return recordCheckOut(user.id, now, tx, { roleId: user.roleId, ip: req.ip ?? null });
      });

      if (!result) {
        res.status(400).json(
          errorEnvelope(
            ErrorCode.VALIDATION_FAILED,
            'No check-in found for today. Please check in before checking out.',
            { ruleId: 'BL-024' },
          ),
        );
        return;
      }

      res.status(200).json({
        data: {
          record: formatAttendanceRecord(result.record),
          hoursWorkedMinutes: result.hoursWorkedMinutes,
        },
      });
    } catch (err: unknown) {
      logger.error({ err, employeeId: user.id }, 'attendance.check-out: error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to record check-out.'));
    }
  },
);

// ── POST /attendance/check-out/undo ──────────────────────────────────────────

attendanceRouter.post(
  '/check-out/undo',
  requireSession(),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const now = new Date();

    try {
      const result = await prisma.$transaction(async (tx) => {
        return undoCheckOutForEmployee(user.id, now, tx, { roleId: user.roleId, ip: req.ip ?? null });
      });

      res.status(200).json({
        data: {
          record: formatAttendanceRecord(result.record),
          lateMarkDeductionApplied: result.lateMarkDeductionApplied,
          lateMonthCount: result.lateMonthCount,
        },
      });
    } catch (err: unknown) {
      const e = err as { httpStatus?: number; code?: string; message?: string };
      if (e.httpStatus === 409 && e.code) {
        res.status(409).json(errorEnvelope(e.code, e.message ?? 'Conflict'));
        return;
      }
      logger.error({ err, employeeId: user.id }, 'attendance.check-out.undo: error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to undo check-out.'));
    }
  },
);

// ── GET /attendance/me/today ──────────────────────────────────────────────────

attendanceRouter.get(
  '/me/today',
  requireSession(),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const today = new Date();

    try {
      const [record, attendanceCfg] = await Promise.all([
        prisma.$transaction((tx) => findOpenAttendance(user.id, today, tx)),
        getAttendanceConfig(),
      ]);

      const lateThreshold = attendanceCfg.lateThresholdTime;
      const standardDailyHours = attendanceCfg.standardDailyHours;

      // Derive panel state: 1=Ready, 2=Working, 3=Confirm
      let panelStateId = 1;
      if (record?.checkInTime && !record.checkOutTime) {
        panelStateId = 2;
      } else if (record?.checkInTime && record.checkOutTime) {
        panelStateId = 3;
      }

      const now = new Date();
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth() + 1;
      const lateLedger = await prisma.attendanceLateLedger.findUnique({
        where: { employeeId_year_month: { employeeId: user.id, year, month } },
      });

      res.status(200).json({
        data: {
          record: record ? formatAttendanceRecord(record as Parameters<typeof formatAttendanceRecord>[0]) : null,
          panelStateId,
          lateThreshold,
          standardDailyHours,
          lateMonthCount: lateLedger?.count ?? 0,
          undoWindowMinutes: attendanceCfg.undoWindowMinutes,
        },
      });
    } catch (err: unknown) {
      logger.error({ err, employeeId: user.id }, 'attendance.me.today: error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, "Failed to load today's attendance."));
    }
  },
);

// ── GET /attendance/me ────────────────────────────────────────────────────────

attendanceRouter.get(
  '/me',
  requireSession(),
  validateQuery(AttendanceListQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const q = req.query as unknown as {
      from?: string;
      to?: string;
      status?: number;
      date?: string;
      cursor?: string;
      limit?: number;
    };

    try {
      const { from, to, statusFilter, dateFilter } = resolveListDateRange(q);
      const limit = Number(q.limit ?? 20);

      const where: Record<string, unknown> = {
        employeeId: user.id,
        sourceId: AttendanceSource.system,
      };

      if (dateFilter) {
        where['date'] = dateFilter;
      } else {
        where['date'] = { gte: from, lte: to };
      }

      if (statusFilter !== undefined) {
        where['status'] = statusFilter;
      }

      const rows = await prisma.attendanceRecord.findMany({
        where,
        orderBy: { date: 'asc' },
        take: limit + 1,
        ...(q.cursor ? { cursor: { id: Number(q.cursor) }, skip: 1 } : {}),
        include: {
          employee: { select: { name: true, code: true } },
        },
      });

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? String(items[items.length - 1]!.id) : null;

      res.status(200).json({
        data: items.map((r) => ({
          ...formatAttendanceCalendarItem(r),
          employeeId: r.employeeId,
          employeeName: r.employee?.name,
          employeeCode: r.employee?.code,
        })),
        nextCursor,
      });
    } catch (err: unknown) {
      logger.error({ err, employeeId: user.id }, 'attendance.me: error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to load attendance.'));
    }
  },
);

// ── GET /attendance/team ──────────────────────────────────────────────────────

attendanceRouter.get(
  '/team',
  requireSession(),
  requireRole(RoleId.Manager, RoleId.Admin),
  validateQuery(AttendanceListQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const q = req.query as unknown as {
      from?: string;
      to?: string;
      status?: number;
      employeeId?: number;
      date?: string;
      cursor?: string;
      limit?: number;
    };

    try {
      const subIds = await getSubordinateIds(user.id);
      if (subIds.length === 0) {
        res.status(200).json({ data: [], nextCursor: null });
        return;
      }

      const { from, to, statusFilter, dateFilter } = resolveListDateRange(q);
      const limit = Number(q.limit ?? 20);

      const employeeFilter =
        q.employeeId && subIds.includes(q.employeeId) ? [q.employeeId] : subIds;

      const where: Record<string, unknown> = {
        employeeId: { in: employeeFilter },
        sourceId: AttendanceSource.system,
      };

      if (dateFilter) {
        where['date'] = dateFilter;
      } else {
        where['date'] = { gte: from, lte: to };
      }

      if (statusFilter !== undefined) {
        where['status'] = statusFilter;
      }

      const rows = await prisma.attendanceRecord.findMany({
        where,
        orderBy: [{ date: 'asc' }, { employeeId: 'asc' }],
        take: limit + 1,
        ...(q.cursor ? { cursor: { id: Number(q.cursor) }, skip: 1 } : {}),
        include: {
          employee: { select: { name: true, code: true } },
        },
      });

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? String(items[items.length - 1]!.id) : null;

      res.status(200).json({
        data: items.map((r) => ({
          ...formatAttendanceCalendarItem(r),
          employeeId: r.employeeId,
          employeeName: r.employee?.name,
          employeeCode: r.employee?.code,
        })),
        nextCursor,
      });
    } catch (err: unknown) {
      logger.error({ err, employeeId: user.id }, 'attendance.team: error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to load team attendance.'));
    }
  },
);

// ── GET /attendance (org-wide, Admin) ────────────────────────────────────────

attendanceRouter.get(
  '/',
  requireSession(),
  requireRole(RoleId.Admin),
  validateQuery(AttendanceListQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const q = req.query as unknown as {
      from?: string;
      to?: string;
      status?: number;
      employeeId?: number;
      departmentId?: number;
      date?: string;
      cursor?: string;
      limit?: number;
    };

    try {
      const { from, to, statusFilter, dateFilter } = resolveListDateRange(q);
      const limit = Number(q.limit ?? 20);

      const where: Record<string, unknown> = {
        sourceId: AttendanceSource.system,
      };

      if (q.employeeId) {
        where['employeeId'] = q.employeeId;
      }

      if (q.departmentId) {
        where['employee'] = { departmentId: q.departmentId };
      }

      if (dateFilter) {
        where['date'] = dateFilter;
      } else {
        where['date'] = { gte: from, lte: to };
      }

      if (statusFilter !== undefined) {
        where['status'] = statusFilter;
      }

      const rows = await prisma.attendanceRecord.findMany({
        where,
        orderBy: [{ date: 'asc' }, { employeeId: 'asc' }],
        take: limit + 1,
        ...(q.cursor ? { cursor: { id: Number(q.cursor) }, skip: 1 } : {}),
        include: {
          employee: {
            select: {
              name: true,
              code: true,
              department: { select: { name: true } },
            },
          },
        },
      });

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? String(items[items.length - 1]!.id) : null;

      res.status(200).json({
        data: items.map((r) => ({
          ...formatAttendanceCalendarItem(r),
          employeeId: r.employeeId,
          employeeName: r.employee?.name,
          employeeCode: r.employee?.code,
          department: (r.employee as { department?: { name: string } | null } | undefined)
            ?.department?.name ?? null,
        })),
        nextCursor,
      });
    } catch (err: unknown) {
      logger.error({ err, employeeId: user.id }, 'attendance.org: error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to load attendance.'));
    }
  },
);

// ── GET /attendance/stats ────────────────────────────────────────────────────
// Aggregate KPI counts for a single date (or date range). Admin-only org-wide.
// Used by the org dashboard so KPI tiles don't have to fetch all rows.

attendanceRouter.get(
  '/stats',
  requireSession(),
  requireRole(RoleId.Admin),
  validateQuery(AttendanceStatsQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    const q = req.query as unknown as {
      date?: string;
      from?: string;
      to?: string;
      departmentId?: number;
    };

    try {
      const where: Record<string, unknown> = { sourceId: AttendanceSource.system };
      if (q.date) {
        const d = new Date(q.date + 'T00:00:00.000Z');
        where['date'] = d;
      } else if (q.from || q.to) {
        where['date'] = {
          ...(q.from ? { gte: new Date(q.from + 'T00:00:00.000Z') } : {}),
          ...(q.to ? { lte: new Date(q.to + 'T00:00:00.000Z') } : {}),
        };
      }
      if (q.departmentId) {
        where['employee'] = { departmentId: q.departmentId };
      }

      const [byStatus, lateCount, yetToCheckIn, total] = await Promise.all([
        prisma.attendanceRecord.groupBy({
          by: ['status'],
          where,
          _count: { _all: true },
        }),
        prisma.attendanceRecord.count({ where: { ...where, late: true } }),
        prisma.attendanceRecord.count({
          where: { ...where, status: AttendanceStatus.Absent, checkInTime: null },
        }),
        prisma.attendanceRecord.count({ where }),
      ]);

      const counts: Record<number, number> = {};
      for (const row of byStatus) counts[row.status] = row._count._all;

      res.status(200).json({
        data: {
          total,
          present:   counts[AttendanceStatus.Present]   ?? 0,
          absent:    counts[AttendanceStatus.Absent]    ?? 0,
          onLeave:   counts[AttendanceStatus.OnLeave]   ?? 0,
          weeklyOff: counts[AttendanceStatus.WeeklyOff] ?? 0,
          holiday:   counts[AttendanceStatus.Holiday]   ?? 0,
          late: lateCount,
          yetToCheckIn,
        },
      });
    } catch (err: unknown) {
      logger.error({ err }, 'attendance.stats: error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to load attendance stats.'));
    }
  },
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveListDateRange(q: {
  from?: string;
  to?: string;
  status?: number;
  date?: string;
}): {
  from: Date;
  to: Date;
  statusFilter: number | undefined;
  dateFilter: { gte: Date; lte: Date } | undefined;
} {
  const now = new Date();
  let dateFilter: { gte: Date; lte: Date } | undefined;

  if (q.date) {
    const d = new Date(q.date);
    d.setUTCHours(0, 0, 0, 0);
    const end = new Date(d);
    end.setUTCHours(23, 59, 59, 999);
    dateFilter = { gte: d, lte: end };
  }

  const fromDate = q.from
    ? new Date(q.from)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const toDate = q.to
    ? new Date(q.to)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));

  // status is already an INT from the coerce schema
  const statusFilter = q.status !== undefined ? q.status : undefined;

  return { from: fromDate, to: toDate, statusFilter, dateFilter };
}

/** Format a DB row to the AttendanceCalendarItem shape (v2 INT status). */
function formatAttendanceCalendarItem(row: {
  date: Date;
  status: number;
  checkInTime: Date | null;
  checkOutTime: Date | null;
  hoursWorkedMinutes: number | null;
  late: boolean;
  targetHours: number;
}) {
  return {
    date: row.date.toISOString().split('T')[0]!,
    status: row.status,
    checkInTime: row.checkInTime?.toISOString() ?? null,
    checkOutTime: row.checkOutTime?.toISOString() ?? null,
    hoursWorkedMinutes: row.hoursWorkedMinutes ?? null,
    late: row.late,
    targetHours: row.targetHours,
  };
}
