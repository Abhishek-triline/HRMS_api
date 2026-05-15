/**
 * Leave management routes — Phase 2 (v2 INT schema).
 *
 * Mounted at /api/v1/leave
 *
 * Endpoints:
 *   GET    /types                     — catalogue (all roles)
 *   GET    /balances/:employeeId      — balance for year (self / manager / admin)
 *   POST   /requests                  — create leave request (BL-009 / BL-010 / BL-014)
 *   GET    /requests                  — list (scoped by role)
 *   GET    /requests/:id              — detail (owner / approver / chain / admin)
 *   POST   /requests/:id/approve      — approve (BL-021)
 *   POST   /requests/:id/reject       — reject (note required)
 *   POST   /requests/:id/cancel       — cancel (BL-019 / BL-020)
 *   POST   /balances/adjust           — admin balance adjustment (A-07)
 *   GET    /config/types              — same as /types (sugar for admin config UI)
 *   PATCH  /config/types/:typeId      — update type config (A-08)
 *   PATCH  /config/quotas/:typeId     — update quota (A-08)
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { requireSession } from '../../middleware/requireSession.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateBody } from '../../middleware/validateBody.js';
import { validateQuery } from '../../middleware/validateQuery.js';
import { audit } from '../../lib/audit.js';
import { errorEnvelope, ErrorCode } from '@nexora/contracts/errors';
import {
  CreateLeaveRequestSchema,
  ApproveLeaveRequestSchema,
  RejectLeaveRequestSchema,
  CancelLeaveRequestSchema,
  LeaveListQuerySchema,
  AdjustBalanceRequestSchema,
  UpdateLeaveTypeRequestSchema,
  UpdateLeaveQuotaRequestSchema,
} from '@nexora/contracts/leave';
import {
  computeLeaveDays,
  resolveRouting,
  findOverlappingLeave,
  findOverlappingRegularisation,
  currentBalance,
  applyApproval,
  applyCancellation,
} from './leave.service.js';
import { generateLeaveCode } from './leaveCode.js';
import { getSubordinateIds } from '../employees/hierarchy.js';
import { logger } from '../../lib/logger.js';
import { notify } from '../../lib/notifications.js';
import {
  RoleId,
  EmployeeStatus,
  LeaveStatus,
  RoutedTo,
  LedgerReason,
  CancelledByRole,
  AttendanceSource,
  type RoleIdValue,
  type AuditActorRoleValue,
} from '../../lib/statusInt.js';

// ── Router ────────────────────────────────────────────────────────────────────

export const leaveRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Map a raw Prisma LeaveRequest row to the contract shape. */
function formatRequest(
  req: {
    id: number;
    code: string;
    employeeId: number;
    employee: { name: string; code: string };
    leaveTypeId: number;
    leaveType: { name: string };
    fromDate: Date;
    toDate: Date;
    days: number;
    reason: string;
    status: number;
    routedToId: number;
    approverId: number | null;
    approver?: { name: string } | null;
    decidedAt: Date | null;
    decidedBy: number | null;
    decisionNote: string | null;
    escalatedAt: Date | null;
    cancelledAt: Date | null;
    cancelledBy: number | null;
    cancelledAfterStart: boolean;
    deductedDays: number;
    restoredDays: number;
    createdAt: Date;
    updatedAt: Date;
    version: number;
  },
  cancelledByRoleId?: number | null,
  cancelledByName?: string | null,
) {
  return {
    id: req.id,
    code: req.code,
    employeeId: req.employeeId,
    employeeName: req.employee.name,
    employeeCode: req.employee.code,
    leaveTypeId: req.leaveTypeId,
    leaveTypeName: req.leaveType.name,
    fromDate: req.fromDate.toISOString().split('T')[0]!,
    toDate: req.toDate.toISOString().split('T')[0]!,
    days: req.days,
    reason: req.reason,
    status: req.status,
    routedToId: req.routedToId,
    approverId: req.approverId ?? null,
    approverName: req.approver?.name ?? null,
    decidedAt: req.decidedAt?.toISOString() ?? null,
    decidedBy: req.decidedBy ?? null,
    decisionNote: req.decisionNote ?? null,
    escalatedAt: req.escalatedAt?.toISOString() ?? null,
    cancelledAt: req.cancelledAt?.toISOString() ?? null,
    cancelledBy: req.cancelledBy ?? null,
    cancelledByName: cancelledByName ?? null,
    cancelledByRoleId: cancelledByRoleId ?? null,
    cancelledAfterStart: req.cancelledAfterStart,
    deductedDays: req.deductedDays,
    restoredDays: req.restoredDays,
    createdAt: req.createdAt.toISOString(),
    updatedAt: req.updatedAt.toISOString(),
    version: req.version,
  };
}

const requestInclude = {
  employee: { select: { name: true, code: true } },
  approver: { select: { name: true } },
  leaveType: { select: { id: true, name: true } },
} as const;

/**
 * Look up the canceller's name and compute their roleId tag.
 * CancelledByRole: 1=Self, 2=Manager, 3=Admin
 */
async function resolveCanceller(
  cancelledBy: number | null,
  employeeId: number,
): Promise<{ name: string; cancelledByRoleId: number } | null> {
  if (!cancelledBy) return null;

  const canceller = await prisma.employee.findUnique({
    where: { id: cancelledBy },
    select: { name: true, roleId: true },
  });

  if (!canceller) return null;

  let cancelledByRoleId: number;
  if (cancelledBy === employeeId) {
    cancelledByRoleId = CancelledByRole.Self;
  } else if (canceller.roleId === RoleId.Admin) {
    cancelledByRoleId = CancelledByRole.Admin;
  } else {
    cancelledByRoleId = CancelledByRole.Manager;
  }

  return { name: canceller.name, cancelledByRoleId };
}

/**
 * Check if the calling user can see a specific leave request.
 */
async function canSeeRequest(
  userId: number,
  userRoleId: number,
  request: { employeeId: number; approverId: number | null },
): Promise<boolean> {
  if (userRoleId === RoleId.Admin) return true;
  if (request.employeeId === userId) return true;
  if (request.approverId === userId) return true;

  if (userRoleId === RoleId.Manager) {
    const subordinates = await getSubordinateIds(userId);
    return subordinates.includes(request.employeeId);
  }

  return false;
}

// ── GET /leave/types ─────────────────────────────────────────────────────────

leaveRouter.get('/types', requireSession(), async (_req: Request, res: Response): Promise<void> => {
  try {
    const types = await prisma.leaveType.findMany({
      include: {
        quotas: { select: { employmentTypeId: true, daysPerYear: true } },
      },
      orderBy: { name: 'asc' },
    });

    res.status(200).json({
      data: types.map((t) => ({
        id: t.id,
        name: t.name,
        isEventBased: t.isEventBased,
        requiresAdminApproval: t.requiresAdminApproval,
        carryForwardCap: t.carryForwardCap,
        maxDaysPerEvent: t.maxDaysPerEvent,
        quotas: t.quotas,
      })),
    });
  } catch (err: unknown) {
    logger.error({ err }, 'leave.types.error');
    res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to fetch leave types.'));
  }
});

// ── GET /leave/config/types (Admin-only mirror for the config UI) ───────────

leaveRouter.get(
  '/config/types',
  requireSession(),
  requireRole(RoleId.Admin),
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const types = await prisma.leaveType.findMany({
        include: { quotas: { select: { employmentTypeId: true, daysPerYear: true } } },
        orderBy: { name: 'asc' },
      });

      res.status(200).json({
        data: types.map((t) => ({
          id: t.id,
          name: t.name,
          isEventBased: t.isEventBased,
          requiresAdminApproval: t.requiresAdminApproval,
          carryForwardCap: t.carryForwardCap,
          maxDaysPerEvent: t.maxDaysPerEvent,
          quotas: t.quotas,
        })),
      });
    } catch (err: unknown) {
      logger.error({ err }, 'leave.config.types.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to fetch leave config.'));
    }
  },
);

// ── PATCH /leave/config/types/:typeId (Admin — A-08) ──────────────────────

leaveRouter.patch(
  '/config/types/:typeId',
  requireSession(),
  requireRole(RoleId.Admin),
  validateBody(UpdateLeaveTypeRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const typeId = Number(req.params['typeId']);
    const updates = req.body as { carryForwardCap?: number | null; maxDaysPerEvent?: number | null };

    if (isNaN(typeId)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Leave type not found.'));
      return;
    }

    try {
      const leaveType = await prisma.leaveType.findUnique({ where: { id: typeId } });
      if (!leaveType) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, `Leave type ${typeId} not found.`));
        return;
      }

      const before = {
        carryForwardCap: leaveType.carryForwardCap,
        maxDaysPerEvent: leaveType.maxDaysPerEvent,
      };

      const updated = await prisma.leaveType.update({
        where: { id: leaveType.id },
        data: {
          ...(updates.carryForwardCap !== undefined ? { carryForwardCap: updates.carryForwardCap } : {}),
          ...(updates.maxDaysPerEvent !== undefined ? { maxDaysPerEvent: updates.maxDaysPerEvent } : {}),
        },
      });

      await audit({
        actorId: req.user!.id,
        actorRole: req.user!.roleId as AuditActorRoleValue,
        actorIp: req.ip ?? null,
        action: 'config.leave-type.update',
        targetType: 'LeaveRequest',
        targetId: leaveType.id,
        module: 'leave',
        before,
        after: {
          carryForwardCap: updated.carryForwardCap,
          maxDaysPerEvent: updated.maxDaysPerEvent,
        },
      });

      res.status(200).json({
        data: {
          id: updated.id,
          name: updated.name,
          carryForwardCap: updated.carryForwardCap,
          maxDaysPerEvent: updated.maxDaysPerEvent,
        },
      });
    } catch (err: unknown) {
      logger.error({ err }, 'leave.config.types.update.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to update leave type.'));
    }
  },
);

// ── PATCH /leave/config/quotas/:typeId (Admin — A-08) ─────────────────────

leaveRouter.patch(
  '/config/quotas/:typeId',
  requireSession(),
  requireRole(RoleId.Admin),
  validateBody(UpdateLeaveQuotaRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const typeId = Number(req.params['typeId']);
    const { employmentTypeId, daysPerYear } = req.body as {
      employmentTypeId: number;
      daysPerYear: number;
    };

    if (isNaN(typeId)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Leave type not found.'));
      return;
    }

    try {
      const leaveType = await prisma.leaveType.findUnique({ where: { id: typeId } });
      if (!leaveType) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, `Leave type ${typeId} not found.`));
        return;
      }

      const existing = await prisma.leaveQuota.findUnique({
        where: {
          leaveTypeId_employmentTypeId: {
            leaveTypeId: leaveType.id,
            employmentTypeId,
          },
        },
      });

      const quota = await prisma.leaveQuota.upsert({
        where: {
          leaveTypeId_employmentTypeId: {
            leaveTypeId: leaveType.id,
            employmentTypeId,
          },
        },
        create: {
          leaveTypeId: leaveType.id,
          employmentTypeId,
          daysPerYear,
        },
        update: { daysPerYear },
      });

      await audit({
        actorId: req.user!.id,
        actorRole: req.user!.roleId as AuditActorRoleValue,
        actorIp: req.ip ?? null,
        action: 'config.leave-quota.update',
        targetType: 'LeaveRequest',
        targetId: quota.id,
        module: 'leave',
        before: existing ? { daysPerYear: existing.daysPerYear } : null,
        after: { daysPerYear },
      });

      res.status(200).json({ data: { leaveTypeId: typeId, employmentTypeId, daysPerYear } });
    } catch (err: unknown) {
      logger.error({ err }, 'leave.config.quotas.update.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to update leave quota.'));
    }
  },
);

// ── GET /leave/balances/:employeeId ──────────────────────────────────────────

leaveRouter.get(
  '/balances/:employeeId',
  requireSession(),
  async (req: Request, res: Response): Promise<void> => {
    const employeeId = Number(req.params['employeeId']);
    const user = req.user!;

    if (isNaN(employeeId)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
      return;
    }

    try {
      // Access control: SELF, or Manager-of-team, or Admin
      if (user.roleId !== RoleId.Admin) {
        if (user.id !== employeeId) {
          if (user.roleId === RoleId.Manager) {
            const subs = await getSubordinateIds(user.id);
            if (!subs.includes(employeeId)) {
              res.status(404).json(
                errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found or outside your scope.'),
              );
              return;
            }
          } else {
            res.status(403).json(errorEnvelope(ErrorCode.FORBIDDEN, 'You are not authorised for this action.'));
            return;
          }
        }
      }

      const employee = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: { id: true, employmentTypeId: true },
      });

      if (!employee) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
        return;
      }

      const year = new Date().getFullYear();
      const leaveTypes = await prisma.leaveType.findMany({
        include: { quotas: true },
      });

      const balances = await Promise.all(
        leaveTypes.map(async (lt) => {
          if (lt.isEventBased) {
            return {
              leaveTypeId: lt.id,
              remaining: null as number | null,
              total: null as number | null,
              carryForwardCap: null as number | null,
              eligible: true,
            };
          }

          const quota = lt.quotas.find((q) => q.employmentTypeId === employee.employmentTypeId);
          const total = quota?.daysPerYear ?? null;

          const balRow = await prisma.leaveBalance.upsert({
            where: {
              employeeId_leaveTypeId_year: { employeeId: employee.id, leaveTypeId: lt.id, year },
            },
            create: {
              employeeId: employee.id,
              leaveTypeId: lt.id,
              year,
              daysRemaining: total ?? 0,
              daysUsed: 0,
              version: 0,
            },
            update: {},
          });

          return {
            leaveTypeId: lt.id,
            remaining: balRow.daysRemaining,
            total,
            carryForwardCap: lt.carryForwardCap,
            eligible: null as boolean | null,
          };
        }),
      );

      res.status(200).json({ data: { employeeId, year, balances } });
    } catch (err: unknown) {
      logger.error({ err }, 'leave.balances.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to fetch leave balances.'));
    }
  },
);

// ── POST /leave/balances/adjust (Admin — A-07) ───────────────────────────────

leaveRouter.post(
  '/balances/adjust',
  requireSession(),
  requireRole(RoleId.Admin),
  validateBody(AdjustBalanceRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { employeeId, leaveTypeId, delta, reason } = req.body as {
      employeeId: number;
      leaveTypeId: number;
      delta: number;
      reason: string;
    };

    try {
      const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
      if (!employee) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
        return;
      }

      const leaveType = await prisma.leaveType.findUnique({ where: { id: leaveTypeId } });
      if (!leaveType) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, `Leave type ${leaveTypeId} not found.`));
        return;
      }

      const year = new Date().getFullYear();

      const result = await prisma.$transaction(async (tx) => {
        const before = await tx.leaveBalance.findUnique({
          where: {
            employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year },
          },
        });

        const currentRemaining = before?.daysRemaining ?? 0;
        const target = Math.max(0, currentRemaining + delta);

        const balRow = await tx.leaveBalance.upsert({
          where: {
            employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year },
          },
          create: {
            employeeId,
            leaveTypeId,
            year,
            daysRemaining: target,
            daysUsed: 0,
            version: 0,
          },
          update: {
            daysRemaining: target,
            version: { increment: 1 },
          },
        });

        await tx.leaveBalanceLedger.create({
          data: {
            employeeId,
            leaveTypeId,
            year,
            delta,
            reasonId: LedgerReason.Adjustment,
            relatedRequestId: null,
            createdBy: req.user!.id,
          },
        });

        await audit({
          tx,
          actorId: req.user!.id,
          actorRole: req.user!.roleId as AuditActorRoleValue,
          actorIp: req.ip ?? null,
          action: 'leave.balance.adjust',
          targetType: 'LeaveRequest',
          targetId: balRow.id,
          module: 'leave',
          before: before ? { daysRemaining: before.daysRemaining } : null,
          after: { daysRemaining: balRow.daysRemaining, delta, reason },
        });

        return balRow;
      });

      const quota = await prisma.leaveQuota.findUnique({
        where: {
          leaveTypeId_employmentTypeId: {
            leaveTypeId,
            employmentTypeId: employee.employmentTypeId,
          },
        },
      });

      res.status(200).json({
        data: {
          balance: {
            leaveTypeId,
            remaining: result.daysRemaining,
            total: quota?.daysPerYear ?? null,
            carryForwardCap: leaveType.carryForwardCap,
            eligible: null,
          },
        },
      });
    } catch (err: unknown) {
      logger.error({ err }, 'leave.balance.adjust.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to adjust leave balance.'));
    }
  },
);

// ── POST /leave/requests ─────────────────────────────────────────────────────

leaveRouter.post(
  '/requests',
  requireSession(),
  validateBody(CreateLeaveRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const { leaveTypeId, fromDate: fromDateStr, toDate: toDateStr, reason } = req.body as {
      leaveTypeId: number;
      fromDate: string;
      toDate: string;
      reason: string;
    };

    const fromDate = new Date(fromDateStr + 'T00:00:00.000Z');
    const toDate = new Date(toDateStr + 'T00:00:00.000Z');

    if (fromDate > toDate) {
      res.status(400).json(
        errorEnvelope(ErrorCode.INVALID_DATE_RANGE, 'fromDate must be on or before toDate.'),
      );
      return;
    }

    // ── Self-apply guardrails ──────────────────────────────────────────
    // Compute "today" in the server's local TZ (Asia/Kolkata per the
    // .env contract). Server uses local-date arithmetic for BL rules
    // anchored to the calendar day; the leave dates are stored as UTC
    // midnight, but the YYYY-MM-DD string comparison below is timezone-
    // safe because both sides are extracted as local calendar strings.
    const now = new Date();
    const todayYmd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const currentYear = now.getFullYear();

    // Guard 1 — past dates are not allowed via the leave form. The
    // proper path for "I was absent yesterday for a reason" is the
    // Regularisation flow (BL-029), which has its own age-based
    // routing. Allowing past leave here would bypass that.
    if (fromDateStr < todayYmd) {
      res.status(409).json(
        errorEnvelope(
          ErrorCode.LEAVE_FROM_DATE_IN_PAST,
          "Past dates can't be applied as leave. Use the Regularisation form to correct a past attendance record.",
          { ruleId: 'BL-LEAVE-PAST' },
        ),
      );
      return;
    }

    // Guard 2 — both dates must fall within the current calendar year
    // for non-event-based leaves. Quotas reset on Jan 1 and the
    // carry-forward / new-accrual job hasn't run for future years yet,
    // so the server can't reliably debit balances across the boundary.
    // Maternity (5) / Paternity (6) are event-based and can span any
    // year — they have separate entitlement rules and don't deduct
    // from yearly quotas, so we exempt them here.
    const isEventBased = leaveTypeId === 5 || leaveTypeId === 6;
    const fromYear = Number(fromDateStr.slice(0, 4));
    const toYear = Number(toDateStr.slice(0, 4));
    if (!isEventBased && (fromYear !== currentYear || toYear !== currentYear)) {
      res.status(409).json(
        errorEnvelope(
          ErrorCode.LEAVE_CROSSES_YEAR_BOUNDARY,
          `Leave dates must fall within the current calendar year (${currentYear}). For year-end breaks, file separate requests for each year.`,
          { ruleId: 'BL-LEAVE-YEAR', details: { currentYear } },
        ),
      );
      return;
    }

    const days = computeLeaveDays(fromDate, toDate);
    const year = fromDate.getFullYear();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type TxError = Error & { statusCode?: number; code?: string; ruleId?: string; details?: Record<string, any> };

    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        const leaveType = await tx.leaveType.findUnique({ where: { id: leaveTypeId } });
        if (!leaveType) {
          const e: TxError = new Error(`Leave type ${leaveTypeId} not found.`);
          e.statusCode = 404;
          e.code = ErrorCode.NOT_FOUND;
          throw e;
        }

        // Guard 3 — if the leave starts TODAY and the employee has
        // already checked in, block. Today's attendance row already
        // reads status=Present with a real checkInTime; approving a
        // same-day leave would leave the system holding two
        // contradictory truths about today (Present + OnLeave). The
        // intended path for "I came in then had to leave" is a
        // Regularisation request, which overlays the attendance row
        // cleanly. fromDate is parsed as UTC midnight; the row key is
        // also stored as a date-only column at UTC midnight, so the
        // findUnique below is exact.
        if (fromDateStr === todayYmd) {
          const todaysRow = await tx.attendanceRecord.findUnique({
            where: {
              employeeId_date_sourceId: {
                employeeId: user.id,
                date: fromDate,
                sourceId: AttendanceSource.system,
              },
            },
            select: { checkInTime: true },
          });
          if (todaysRow?.checkInTime) {
            const e: TxError = new Error(
              "You've already checked in today. Submit a Regularisation request to convert today into a leave day.",
            );
            e.statusCode = 409;
            e.code = ErrorCode.LEAVE_SAME_DAY_ALREADY_CHECKED_IN;
            e.ruleId = 'BL-LEAVE-SAME-DAY';
            throw e;
          }
        }

        // BL-009: check overlap with existing leave
        const overlap = await findOverlappingLeave(user.id, fromDate, toDate, tx);
        if (overlap) {
          const conflictFrom = overlap.fromDate.toISOString().split('T')[0]!;
          const conflictTo = overlap.toDate.toISOString().split('T')[0]!;
          const e: TxError = new Error('Leave dates overlap with an existing request.');
          e.statusCode = 409;
          e.code = ErrorCode.LEAVE_OVERLAP;
          e.ruleId = 'BL-009';
          e.details = {
            conflictType: 'Leave',
            conflictId: overlap.id,
            conflictCode: overlap.code,
            conflictFrom,
            conflictTo,
            conflictStatus: overlap.status,
          };
          throw e;
        }

        // BL-010: check overlap with regularisation
        const regConflict = await findOverlappingRegularisation(user.id, fromDate, toDate, tx);
        if (regConflict) {
          const conflictDate = regConflict.date.toISOString().split('T')[0]!;
          const e: TxError = new Error('Leave dates conflict with an approved regularisation.');
          e.statusCode = 409;
          e.code = ErrorCode.LEAVE_REG_CONFLICT;
          e.ruleId = 'BL-010';
          e.details = {
            conflictType: 'Regularisation',
            conflictId: regConflict.id,
            conflictCode: regConflict.code ?? '',
            conflictFrom: conflictDate,
            conflictTo: null,
            conflictStatus: regConflict.status,
          };
          throw e;
        }

        // BL-014: balance check for accrual types
        if (!leaveType.isEventBased && leaveTypeId !== 4 /* Unpaid */) {
          const bal = await currentBalance(user.id, leaveType.id, year, tx);
          if (bal.remaining < days) {
            const e: TxError = new Error(
              `Insufficient leave balance. Requested: ${days}, Available: ${bal.remaining}`,
            );
            e.statusCode = 409;
            e.code = ErrorCode.INSUFFICIENT_BALANCE;
            e.ruleId = 'BL-014';
            e.details = { requested: days, available: bal.remaining };
            throw e;
          }
        }

        // Resolve routing (BL-015 / BL-016 / BL-017 / BL-022)
        const routing = await resolveRouting(user.id, leaveTypeId, tx);

        // Generate L-YYYY-NNNN code
        const code = await generateLeaveCode(year, tx);

        const created = await tx.leaveRequest.create({
          data: {
            code,
            employeeId: user.id,
            leaveTypeId: leaveType.id,
            fromDate,
            toDate,
            days,
            reason,
            status: LeaveStatus.Pending,
            routedToId: routing.routedToId,
            approverId: routing.approverId,
            deductedDays: 0,
            restoredDays: 0,
            version: 0,
          },
          include: requestInclude,
        });

        await audit({
          tx,
          actorId: user.id,
          actorRole: user.roleId as AuditActorRoleValue,
          actorIp: req.ip ?? null,
          action: 'leave.create',
          targetType: 'LeaveRequest',
          targetId: created.id,
          module: 'leave',
          before: null,
          after: {
            code: created.code,
            leaveTypeId,
            fromDate: fromDateStr,
            toDate: toDateStr,
            days,
            status: LeaveStatus.Pending,
            routedToId: routing.routedToId,
            approverId: routing.approverId,
          },
        });

        // Notify the approver(s)
        let recipientIds: number | number[] = routing.approverId ?? 0;
        if (routing.routedToId === RoutedTo.Admin || !routing.approverId) {
          const activeAdmins = await tx.employee.findMany({
            where: { roleId: RoleId.Admin, status: EmployeeStatus.Active },
            select: { id: true },
          });
          recipientIds = activeAdmins.map((a) => a.id);
        }
        if (Array.isArray(recipientIds) ? recipientIds.length > 0 : recipientIds > 0) {
          await notify({
            tx,
            recipientIds,
            category: 'Leave',
            title: `New leave request from ${created.employee.name}`,
            body: `${leaveType.name} leave for ${days} day(s) (${fromDateStr} to ${toDateStr}) is pending your approval.`,
            link: `/${routing.routedToId === RoutedTo.Manager ? 'manager' : 'admin'}/leave-queue/${created.id}`,
          });
        }

        return created;
      });
    } catch (err: unknown) {
      const txErr = err as TxError;
      if (txErr.statusCode && txErr.code) {
        res
          .status(txErr.statusCode)
          .json(errorEnvelope(txErr.code, txErr.message, { details: txErr.details, ruleId: txErr.ruleId }));
        return;
      }
      logger.error({ err }, 'leave.create.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to create leave request.'));
      return;
    }

    // Balance snapshot for the response
    const leaveType = await prisma.leaveType.findUnique({ where: { id: leaveTypeId } });
    let balanceAfterSubmit = null;

    if (leaveType && !leaveType.isEventBased && leaveTypeId !== 4) {
      const snapshot = await currentBalance(user.id, leaveType.id, year, prisma);
      const emp = await prisma.employee.findUnique({ where: { id: user.id }, select: { employmentTypeId: true } });
      const quota = emp ? await prisma.leaveQuota.findFirst({
        where: { leaveTypeId: leaveType.id, employmentTypeId: emp.employmentTypeId },
      }) : null;
      balanceAfterSubmit = {
        leaveTypeId,
        remaining: snapshot.remaining,
        total: quota?.daysPerYear ?? null,
        carryForwardCap: leaveType.carryForwardCap,
        eligible: null,
      };
    }

    res.status(201).json({
      data: {
        leaveRequest: formatRequest(result!),
        balanceAfterSubmit,
      },
    });
  },
);

// ── GET /leave/requests ──────────────────────────────────────────────────────

leaveRouter.get(
  '/requests',
  requireSession(),
  validateQuery(LeaveListQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const query = req.query as {
      status?: number;
      leaveTypeId?: number;
      fromDate?: string;
      toDate?: string;
      employeeId?: number;
      routedToId?: number;
      cursor?: string;
      limit?: string;
      sort?: string;
    };

    const limit = Number(query.limit ?? 20);
    const cursor = query.cursor as string | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: Record<string, any> = {};

    try {
      if (user.roleId === RoleId.Employee) {
        where['employeeId'] = user.id;
      } else if (user.roleId === RoleId.Manager) {
        if (query.employeeId) {
          const subs = await getSubordinateIds(user.id);
          const empId = Number(query.employeeId);
          if (subs.includes(empId) || empId === user.id) {
            where['employeeId'] = empId;
          } else {
            res.status(200).json({ data: [], nextCursor: null });
            return;
          }
        } else {
          const subs = await getSubordinateIds(user.id);
          where['OR'] = [
            { employeeId: user.id },
            { employeeId: { in: subs }, approverId: user.id },
          ];
        }
      } else if (user.roleId === RoleId.Admin) {
        if (query.employeeId) where['employeeId'] = Number(query.employeeId);
        if (query.routedToId) where['routedToId'] = Number(query.routedToId);
      } else if (user.roleId === RoleId.PayrollOfficer) {
        where['employeeId'] = user.id;
      }

      if (query.status) where['status'] = Number(query.status);
      if (query.leaveTypeId) where['leaveTypeId'] = Number(query.leaveTypeId);
      if (query.fromDate) where['fromDate'] = { gte: new Date(query.fromDate) };
      if (query.toDate) where['toDate'] = { lte: new Date(query.toDate) };

      if (cursor) {
        const cursorId = Number(cursor);
        if (!isNaN(cursorId)) {
          where['id'] = { gt: cursorId };
        }
      }

      const requests = await prisma.leaveRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        include: requestInclude,
      });

      const hasMore = requests.length > limit;
      const page = hasMore ? requests.slice(0, limit) : requests;
      const nextCursor = hasMore ? String(page[page.length - 1]?.id ?? '') : null;

      res.status(200).json({
        data: page.map((r) => formatRequest(r)),
        nextCursor,
      });
    } catch (err: unknown) {
      logger.error({ err }, 'leave.list.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to list leave requests.'));
    }
  },
);

// ── GET /leave/requests/:id ──────────────────────────────────────────────────

leaveRouter.get(
  '/requests/:id',
  requireSession(),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    // Accept either numeric id ("42") or the human-readable code
    // ("L-2026-0018") in the same path slot. Notifications use the code
    // because it survives in shareable URLs; the FE list pages link by
    // id. Both must resolve to the same row.
    const raw = req.params['id'] ?? '';
    const asNum = Number(raw);
    const isNumericId = Number.isInteger(asNum) && asNum > 0;
    const isCodeLike = /^L-\d{4}-\d{4}$/i.test(raw);

    if (!isNumericId && !isCodeLike) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Leave request not found.'));
      return;
    }

    try {
      const request = await prisma.leaveRequest.findUnique({
        where: isNumericId ? { id: asNum } : { code: raw.toUpperCase() },
        include: requestInclude,
      });

      if (!request) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Leave request not found.'));
        return;
      }

      const visible = await canSeeRequest(user.id, user.roleId, request);
      if (!visible) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Leave request not found.'));
        return;
      }

      const canceller = await resolveCanceller(request.cancelledBy, request.employeeId);
      res.status(200).json({
        data: formatRequest(request, canceller?.cancelledByRoleId, canceller?.name),
      });
    } catch (err: unknown) {
      logger.error({ err }, 'leave.getById.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to fetch leave request.'));
    }
  },
);

// ── POST /leave/requests/:id/approve ────────────────────────────────────────

leaveRouter.post(
  '/requests/:id/approve',
  requireSession(),
  validateBody(ApproveLeaveRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const id = Number(req.params['id']);
    const { note, version } = req.body as { note?: string; version: number };

    if (isNaN(id)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Leave request not found.'));
      return;
    }

    try {
      const request = await prisma.leaveRequest.findUnique({
        where: { id },
        include: { leaveType: true },
      });

      if (!request) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Leave request not found.'));
        return;
      }

      // Access check: (Manager AND approverId == self) OR Admin
      if (user.roleId !== RoleId.Admin) {
        if (user.roleId !== RoleId.Manager || request.approverId !== user.id) {
          res.status(403).json(errorEnvelope(ErrorCode.FORBIDDEN, 'You are not authorised to approve this request.'));
          return;
        }
      }

      if (request.status !== LeaveStatus.Pending && request.status !== LeaveStatus.Escalated) {
        res.status(409).json(
          errorEnvelope(ErrorCode.VALIDATION_FAILED, `Cannot approve a request with status ${request.status}.`),
        );
        return;
      }

      if (request.version !== version) {
        res.status(409).json(
          errorEnvelope(ErrorCode.VERSION_MISMATCH, 'The request has been modified. Please refresh and retry.'),
        );
        return;
      }

      const updated = await prisma.$transaction(async (tx) => {
        const result = await applyApproval(id, user.id, note, tx);

        await audit({
          tx,
          actorId: user.id,
          actorRole: user.roleId as AuditActorRoleValue,
          actorIp: req.ip ?? null,
          action: 'leave.approve',
          targetType: 'LeaveRequest',
          targetId: id,
          module: 'leave',
          before: { status: request.status, version: request.version },
          after: { status: LeaveStatus.Approved, deductedDays: result.deductedDays },
        });

        await notify({
          tx,
          recipientIds: result.employeeId,
          category: 'Leave',
          title: 'Your leave request was approved',
          body: `${result.leaveType.name} leave for ${result.days} day(s) (${result.fromDate.toISOString().split('T')[0]} to ${result.toDate.toISOString().split('T')[0]}) was approved.`,
          link: `/employee/leave/${id}`,
        });

        return result;
      });

      res.status(200).json({ data: formatRequest(updated) });
    } catch (err: unknown) {
      logger.error({ err }, 'leave.approve.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to approve leave request.'));
    }
  },
);

// ── POST /leave/requests/:id/reject ─────────────────────────────────────────

leaveRouter.post(
  '/requests/:id/reject',
  requireSession(),
  validateBody(RejectLeaveRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const id = Number(req.params['id']);
    const { note, version } = req.body as { note: string; version: number };

    if (isNaN(id)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Leave request not found.'));
      return;
    }

    try {
      const request = await prisma.leaveRequest.findUnique({
        where: { id },
        include: requestInclude,
      });

      if (!request) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Leave request not found.'));
        return;
      }

      if (user.roleId !== RoleId.Admin) {
        if (user.roleId !== RoleId.Manager || request.approverId !== user.id) {
          res.status(403).json(errorEnvelope(ErrorCode.FORBIDDEN, 'You are not authorised to reject this request.'));
          return;
        }
      }

      if (request.status !== LeaveStatus.Pending && request.status !== LeaveStatus.Escalated) {
        res.status(409).json(
          errorEnvelope(ErrorCode.VALIDATION_FAILED, `Cannot reject a request with status ${request.status}.`),
        );
        return;
      }

      if (request.version !== version) {
        res.status(409).json(
          errorEnvelope(ErrorCode.VERSION_MISMATCH, 'The request has been modified. Please refresh and retry.'),
        );
        return;
      }

      const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.leaveRequest.update({
          where: { id },
          data: {
            status: LeaveStatus.Rejected,
            decidedAt: new Date(),
            decidedBy: user.id,
            decisionNote: note,
            version: { increment: 1 },
          },
          include: requestInclude,
        });

        await audit({
          tx,
          actorId: user.id,
          actorRole: user.roleId as AuditActorRoleValue,
          actorIp: req.ip ?? null,
          action: 'leave.reject',
          targetType: 'LeaveRequest',
          targetId: id,
          module: 'leave',
          before: { status: request.status, version: request.version },
          after: { status: LeaveStatus.Rejected, decisionNote: note },
        });

        await notify({
          tx,
          recipientIds: result.employeeId,
          category: 'Leave',
          title: 'Your leave request was rejected',
          body: `${result.leaveType.name} leave request (${result.fromDate.toISOString().split('T')[0]} to ${result.toDate.toISOString().split('T')[0]}) was rejected${note ? ` — ${note}` : ''}.`,
          link: `/employee/leave/${id}`,
        });

        return result;
      });

      res.status(200).json({ data: formatRequest(updated) });
    } catch (err: unknown) {
      logger.error({ err }, 'leave.reject.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to reject leave request.'));
    }
  },
);

// ── POST /leave/requests/:id/cancel ─────────────────────────────────────────

leaveRouter.post(
  '/requests/:id/cancel',
  requireSession(),
  validateBody(CancelLeaveRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const id = Number(req.params['id']);
    const { note, version } = req.body as { note?: string; version: number };

    if (isNaN(id)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Leave request not found.'));
      return;
    }

    try {
      const request = await prisma.leaveRequest.findUnique({
        where: { id },
        include: requestInclude,
      });

      if (!request) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Leave request not found.'));
        return;
      }

      const visible = await canSeeRequest(user.id, user.roleId, request);
      if (!visible) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Leave request not found.'));
        return;
      }

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const fromDay = new Date(request.fromDate);
      fromDay.setHours(0, 0, 0, 0);

      const isOwner = request.employeeId === user.id;
      const isAdmin = user.roleId === RoleId.Admin;

      let canCancel = false;

      if (isAdmin) {
        canCancel = true;
      } else if (user.roleId === RoleId.Manager) {
        const subs = await getSubordinateIds(user.id);
        if (subs.includes(request.employeeId)) {
          canCancel = true;
        }
      }

      if (!canCancel && isOwner) {
        if (request.status === LeaveStatus.Pending) {
          canCancel = true;
        } else if (request.status === LeaveStatus.Approved && today < fromDay) {
          canCancel = true;
        }
      }

      if (!canCancel) {
        res.status(403).json(
          errorEnvelope(
            ErrorCode.FORBIDDEN,
            'You are not authorised to cancel this request, or it cannot be cancelled in its current state.',
          ),
        );
        return;
      }

      if (request.version !== version) {
        res.status(409).json(
          errorEnvelope(ErrorCode.VERSION_MISMATCH, 'The request has been modified. Please refresh and retry.'),
        );
        return;
      }

      const cancellableStatuses: number[] = [LeaveStatus.Pending, LeaveStatus.Approved, LeaveStatus.Escalated];
      if (!cancellableStatuses.includes(request.status)) {
        res.status(409).json(
          errorEnvelope(ErrorCode.VALIDATION_FAILED, `Cannot cancel a request with status ${request.status}.`),
        );
        return;
      }

      const { request: updated, restoredDays } = await prisma.$transaction(async (tx) => {
        const result = await applyCancellation(id, user.id, today, note, tx);

        await audit({
          tx,
          actorId: user.id,
          actorRole: user.roleId as AuditActorRoleValue,
          actorIp: req.ip ?? null,
          action: 'leave.cancel',
          targetType: 'LeaveRequest',
          targetId: id,
          module: 'leave',
          before: {
            status: request.status,
            deductedDays: request.deductedDays,
            version: request.version,
          },
          after: {
            status: LeaveStatus.Cancelled,
            restoredDays: result.restoredDays,
            cancelledAfterStart: result.request.cancelledAfterStart,
          },
        });

        const restoredMsg = result.restoredDays > 0
          ? ` ${result.restoredDays} day(s) restored to your balance.`
          : '';
        await notify({
          tx,
          recipientIds: result.request.employeeId,
          category: 'Leave',
          title: 'Your leave was cancelled',
          body: `${result.request.leaveType.name} leave (${result.request.fromDate.toISOString().split('T')[0]} to ${result.request.toDate.toISOString().split('T')[0]}) has been cancelled.${restoredMsg}`,
          link: `/employee/leave/${result.request.id}`,
        });

        return result;
      });

      const canceller = await resolveCanceller(updated.cancelledBy, updated.employeeId);
      res.status(200).json({
        data: {
          leaveRequest: formatRequest(updated, canceller?.cancelledByRoleId, canceller?.name),
          restoredDays,
        },
      });
    } catch (err: unknown) {
      logger.error({ err }, 'leave.cancel.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to cancel leave request.'));
    }
  },
);
