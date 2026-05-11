/**
 * Attendance routes — Phase 3.
 *
 * Mounted at /api/v1/attendance
 *
 * Endpoints:
 *   POST  /check-in          requireSession — E-06 (BL-024/BL-027/BL-028)
 *   POST  /check-out         requireSession — E-06 (BL-025)
 *   GET   /me                requireSession — E-05 (own records, calendar month default)
 *   GET   /me/today          requireSession — E-05 (today's panel state)
 *   GET   /team              Manager        — M-05 (scoped to subordinates)
 *   GET   /                  Admin          — A-09 (org-wide, optional ?department)
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { requireSession } from '../../middleware/requireSession.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateQuery } from '../../middleware/validateQuery.js';
import { errorEnvelope, ErrorCode } from '@nexora/contracts/errors';
import { AttendanceListQuerySchema } from '@nexora/contracts/attendance';
import { getSubordinateIds } from '../employees/hierarchy.js';
import { logger } from '../../lib/logger.js';
import { getAttendanceConfig } from '../../lib/config.js';
import {
  recordCheckIn,
  recordCheckOut,
  undoCheckOutForEmployee,
  findOpenAttendance,
  formatAttendanceRecord,
  mapAttendanceStatusToDb,
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
        return recordCheckIn(user.id, now, tx, { role: user.role, ip: req.ip ?? null });
      });

      res.status(200).json({
        data: {
          record: formatAttendanceRecord(result.record),
          lateMarkDeductionApplied: result.lateMarkDeductionApplied,
          lateMonthCount: result.lateMonthCount,
        },
      });
    } catch (err: unknown) {
      logger.error({ err, userId: user.id }, 'attendance.check-in: error');
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
        return recordCheckOut(user.id, now, tx, { role: user.role, ip: req.ip ?? null });
      });

      if (!result) {
        // BL-024: no check-in for today
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
      logger.error({ err, userId: user.id }, 'attendance.check-out: error');
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
        return undoCheckOutForEmployee(user.id, now, tx, { role: user.role, ip: req.ip ?? null });
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
      logger.error({ err, userId: user.id }, 'attendance.check-out.undo: error');
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

      // Derive panel state
      let panelState: 'Ready' | 'Working' | 'Confirm' = 'Ready';
      if (record?.checkInTime && !record.checkOutTime) {
        panelState = 'Working';
      } else if (record?.checkInTime && record.checkOutTime) {
        panelState = 'Confirm';
      }

      // Get monthly late count
      const now = new Date();
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth() + 1;
      const lateLedger = await prisma.attendanceLateLedger.findUnique({
        where: { employeeId_year_month: { employeeId: user.id, year, month } },
      });

      res.status(200).json({
        data: {
          record: record ? formatAttendanceRecord(record) : null,
          panelState,
          lateThreshold,
          standardDailyHours,
          lateMonthCount: lateLedger?.count ?? 0,
        },
      });
    } catch (err: unknown) {
      logger.error({ err, userId: user.id }, 'attendance.me.today: error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to load today\'s attendance.'));
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
      status?: string;
      date?: string;
      cursor?: string;
      limit?: number;
    };

    try {
      const { from, to, statusFilter, dateFilter } = resolveListDateRange(q);
      const limit = Number(q.limit ?? 20);

      const where: Record<string, unknown> = {
        employeeId: user.id,
        source: 'system',
      };

      if (dateFilter) {
        where['date'] = dateFilter;
      } else {
        where['date'] = { gte: from, lte: to };
      }

      if (statusFilter) {
        where['status'] = statusFilter;
      }

      const rows = await prisma.attendanceRecord.findMany({
        where,
        orderBy: { date: 'asc' },
        take: limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        include: {
          employee: { select: { name: true, code: true } },
        },
      });

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? items[items.length - 1]!.id : null;

      res.status(200).json({
        data: items.map((r) => ({
          ...formatAttendanceCalendarItem(r),
          employeeId: r.employeeId,
          employeeName: r.employee.name,
          employeeCode: r.employee.code,
        })),
        nextCursor,
      });
    } catch (err: unknown) {
      logger.error({ err, userId: user.id }, 'attendance.me: error');
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
  requireRole('Manager', 'Admin'),
  validateQuery(AttendanceListQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const q = req.query as unknown as {
      from?: string;
      to?: string;
      status?: string;
      employeeId?: string;
      date?: string;
      cursor?: string;
      limit?: number;
    };

    try {
      // Scope: subordinates of the requesting manager
      const subIds = await getSubordinateIds(user.id);
      if (subIds.length === 0) {
        res.status(200).json({ data: [], nextCursor: null });
        return;
      }

      const { from, to, statusFilter, dateFilter } = resolveListDateRange(q);
      const limit = Number(q.limit ?? 20);

      // Optional: filter to a specific employee within the team
      const employeeFilter = q.employeeId && subIds.includes(q.employeeId)
        ? [q.employeeId]
        : subIds;

      const where: Record<string, unknown> = {
        employeeId: { in: employeeFilter },
        source: 'system',
      };

      if (dateFilter) {
        where['date'] = dateFilter;
      } else {
        where['date'] = { gte: from, lte: to };
      }

      if (statusFilter) {
        where['status'] = statusFilter;
      }

      const rows = await prisma.attendanceRecord.findMany({
        where,
        orderBy: [{ date: 'asc' }, { employeeId: 'asc' }],
        take: limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        include: {
          employee: { select: { name: true, code: true } },
        },
      });

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? items[items.length - 1]!.id : null;

      res.status(200).json({
        data: items.map((r) => ({
          ...formatAttendanceCalendarItem(r),
          employeeId: r.employeeId,
          employeeName: r.employee.name,
          employeeCode: r.employee.code,
        })),
        nextCursor,
      });
    } catch (err: unknown) {
      logger.error({ err, userId: user.id }, 'attendance.team: error');
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
  requireRole('Admin'),
  validateQuery(AttendanceListQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const q = req.query as unknown as {
      from?: string;
      to?: string;
      status?: string;
      employeeId?: string;
      department?: string;
      date?: string;
      cursor?: string;
      limit?: number;
    };

    try {
      const { from, to, statusFilter, dateFilter } = resolveListDateRange(q);
      const limit = Number(q.limit ?? 20);

      // Build employee filter
      const employeeWhere: Record<string, unknown> = {};
      if (q.department) {
        employeeWhere['department'] = q.department;
      }
      if (q.employeeId) {
        employeeWhere['id'] = q.employeeId;
      }

      const where: Record<string, unknown> = {
        source: 'system',
        employee: Object.keys(employeeWhere).length > 0 ? employeeWhere : undefined,
      };

      if (dateFilter) {
        where['date'] = dateFilter;
      } else {
        where['date'] = { gte: from, lte: to };
      }

      if (statusFilter) {
        where['status'] = statusFilter;
      }

      const rows = await prisma.attendanceRecord.findMany({
        where,
        orderBy: [{ date: 'asc' }, { employeeId: 'asc' }],
        take: limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        include: {
          employee: { select: { name: true, code: true } },
        },
      });

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? items[items.length - 1]!.id : null;

      res.status(200).json({
        data: items.map((r) => ({
          ...formatAttendanceCalendarItem(r),
          employeeId: r.employeeId,
          employeeName: r.employee.name,
          employeeCode: r.employee.code,
        })),
        nextCursor,
      });
    } catch (err: unknown) {
      logger.error({ err, userId: user.id }, 'attendance.org: error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to load attendance.'));
    }
  },
);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve the date range for list queries.
 * - If `?date` is provided, use that single day.
 * - If `?from` / `?to` are provided, use that range.
 * - Default: current calendar month.
 */
function resolveListDateRange(q: {
  from?: string;
  to?: string;
  status?: string;
  date?: string;
}): {
  from: Date;
  to: Date;
  statusFilter: string | undefined;
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
    : new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999),
      );

  const statusFilter = q.status
    ? mapAttendanceStatusToDb(q.status)
    : undefined;

  return {
    from: fromDate,
    to: toDate,
    statusFilter,
    dateFilter,
  };
}

/** Format a DB row to the AttendanceCalendarItem shape (without employee fields). */
function formatAttendanceCalendarItem(row: {
  date: Date;
  status: string;
  checkInTime: Date | null;
  checkOutTime: Date | null;
  hoursWorkedMinutes: number | null;
  late: boolean;
}) {
  return {
    date: row.date.toISOString().split('T')[0]!,
    status: (() => {
      const m: Record<string, string> = {
        Present: 'Present',
        Absent: 'Absent',
        OnLeave: 'On-Leave',
        WeeklyOff: 'Weekly-Off',
        Holiday: 'Holiday',
      };
      return (m[row.status] ?? 'Absent') as
        | 'Present'
        | 'Absent'
        | 'On-Leave'
        | 'Weekly-Off'
        | 'Holiday';
    })(),
    checkInTime: row.checkInTime?.toISOString() ?? null,
    checkOutTime: row.checkOutTime?.toISOString() ?? null,
    hoursWorkedMinutes: row.hoursWorkedMinutes ?? null,
    late: row.late,
  };
}
