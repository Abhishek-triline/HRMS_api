/**
 * Leave management routes — Phase 2.
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
 *   PATCH  /config/types/:type        — update type config (A-08)
 *   PATCH  /config/quotas/:type       — update quota (A-08)
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
  LeaveTypeSchema,
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

// ── Router ────────────────────────────────────────────────────────────────────

export const leaveRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Map a raw Prisma LeaveRequest row to the contract shape. */
function formatRequest(
  req: {
    id: string;
    code: string;
    employeeId: string;
    employee: { name: string; code: string };
    leaveType: { name: string };
    fromDate: Date;
    toDate: Date;
    days: number;
    reason: string;
    status: string;
    routedTo: string;
    approverId: string | null;
    approver?: { name: string } | null;
    decidedAt: Date | null;
    decidedBy: string | null;
    decisionNote: string | null;
    escalatedAt: Date | null;
    cancelledAt: Date | null;
    cancelledBy: string | null;
    cancelledAfterStart: boolean;
    deductedDays: number;
    restoredDays: number;
    createdAt: Date;
    updatedAt: Date;
    version: number;
  },
) {
  return {
    id: req.id,
    code: req.code,
    employeeId: req.employeeId,
    employeeName: req.employee.name,
    employeeCode: req.employee.code,
    type: req.leaveType.name as ReturnType<typeof LeaveTypeSchema.parse>,
    fromDate: req.fromDate.toISOString().split('T')[0]!,
    toDate: req.toDate.toISOString().split('T')[0]!,
    days: req.days,
    reason: req.reason,
    status: req.status as
      | 'Pending'
      | 'Approved'
      | 'Rejected'
      | 'Cancelled'
      | 'Escalated',
    routedTo: req.routedTo as 'Manager' | 'Admin',
    approverId: req.approverId,
    approverName: req.approver?.name ?? null,
    decidedAt: req.decidedAt?.toISOString() ?? null,
    decidedBy: req.decidedBy,
    decisionNote: req.decisionNote,
    escalatedAt: req.escalatedAt?.toISOString() ?? null,
    cancelledAt: req.cancelledAt?.toISOString() ?? null,
    cancelledBy: req.cancelledBy,
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
  leaveType: { select: { name: true } },
} as const;

/**
 * Check if the calling user can see a specific leave request.
 *
 * Returns true when the user is:
 *   - the owner (employeeId)
 *   - the current approverId
 *   - an Admin
 *   - a Manager whose subordinate tree contains the employee
 */
async function canSeeRequest(
  userId: string,
  userRole: string,
  request: { employeeId: string; approverId: string | null },
): Promise<boolean> {
  if (userRole === 'Admin') return true;
  if (request.employeeId === userId) return true;
  if (request.approverId === userId) return true;

  if (userRole === 'Manager') {
    const subordinates = await getSubordinateIds(userId);
    return subordinates.includes(request.employeeId);
  }

  return false;
}

// ── GET /leave/types ─────────────────────────────────────────────────────────

leaveRouter.get('/types', requireSession(), async (_req: Request, res: Response): Promise<void> => {
  const types = await prisma.leaveType.findMany({
    include: {
      quotas: { select: { employmentType: true, daysPerYear: true } },
    },
    orderBy: { name: 'asc' },
  });

  res.status(200).json({
    data: types.map((t) => ({
      type: t.name,
      isEventBased: t.isEventBased,
      requiresAdminApproval: t.requiresAdminApproval,
      carryForwardCap: t.carryForwardCap,
      maxDaysPerEvent: t.maxDaysPerEvent,
      quotas: t.quotas,
    })),
  });
});

// ── GET /leave/config/types (Admin-only mirror for the config UI) ───────────
// SEC-005-P2: this path was sharing the catalogue with everyone via just
// requireSession(). The /types endpoint above is the public catalogue;
// /config/types is for the admin Leave Config screen and gets locked down.

leaveRouter.get('/config/types', requireSession(), requireRole('Admin'), async (_req: Request, res: Response): Promise<void> => {
  const types = await prisma.leaveType.findMany({
    include: { quotas: { select: { employmentType: true, daysPerYear: true } } },
    orderBy: { name: 'asc' },
  });

  res.status(200).json({
    data: types.map((t) => ({
      type: t.name,
      isEventBased: t.isEventBased,
      requiresAdminApproval: t.requiresAdminApproval,
      carryForwardCap: t.carryForwardCap,
      maxDaysPerEvent: t.maxDaysPerEvent,
      quotas: t.quotas,
    })),
  });
});

// ── PATCH /leave/config/types/:type (Admin — A-08) ──────────────────────────

leaveRouter.patch(
  '/config/types/:type',
  requireSession(),
  requireRole('Admin'),
  validateBody(UpdateLeaveTypeRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { type } = req.params;
    const updates = req.body as { carryForwardCap?: number | null; maxDaysPerEvent?: number | null };

    const leaveType = await prisma.leaveType.findUnique({ where: { name: type } });
    if (!leaveType) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, `Leave type '${type}' not found.`));
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
      actorRole: req.user!.role,
      actorIp: req.ip ?? null,
      action: 'config.leave-type.update',
      targetType: 'LeaveType',
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
        type: updated.name,
        carryForwardCap: updated.carryForwardCap,
        maxDaysPerEvent: updated.maxDaysPerEvent,
      },
    });
  },
);

// ── PATCH /leave/config/quotas/:type (Admin — A-08) ─────────────────────────

leaveRouter.patch(
  '/config/quotas/:type',
  requireSession(),
  requireRole('Admin'),
  validateBody(UpdateLeaveQuotaRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { type } = req.params;
    const { employmentType, daysPerYear } = req.body as {
      employmentType: string;
      daysPerYear: number;
    };

    const leaveType = await prisma.leaveType.findUnique({ where: { name: type } });
    if (!leaveType) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, `Leave type '${type}' not found.`));
      return;
    }

    const existing = await prisma.leaveQuota.findUnique({
      where: {
        leaveTypeId_employmentType: {
          leaveTypeId: leaveType.id,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          employmentType: employmentType as any,
        },
      },
    });

    const quota = await prisma.leaveQuota.upsert({
      where: {
        leaveTypeId_employmentType: {
          leaveTypeId: leaveType.id,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          employmentType: employmentType as any,
        },
      },
      create: {
        leaveTypeId: leaveType.id,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        employmentType: employmentType as any,
        daysPerYear,
      },
      update: { daysPerYear },
    });

    await audit({
      actorId: req.user!.id,
      actorRole: req.user!.role,
      actorIp: req.ip ?? null,
      action: 'config.leave-quota.update',
      targetType: 'LeaveQuota',
      targetId: quota.id,
      module: 'leave',
      before: existing ? { daysPerYear: existing.daysPerYear } : null,
      after: { daysPerYear },
    });

    res.status(200).json({ data: { leaveType: type, employmentType, daysPerYear } });
  },
);

// ── GET /leave/balances/:employeeId ──────────────────────────────────────────

leaveRouter.get(
  '/balances/:employeeId',
  requireSession(),
  async (req: Request, res: Response): Promise<void> => {
    const employeeId = req.params['employeeId'] as string;
    const user = req.user!;

    // Access control: SELF, or Manager-of-team, or Admin
    if (user.role !== 'Admin') {
      if (user.id !== employeeId) {
        if (user.role === 'Manager') {
          const subs = await getSubordinateIds(user.id);
          if (!subs.includes(employeeId)) {
            res
              .status(404)
              .json(
                errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found or outside your scope.'),
              );
            return;
          }
        } else {
          res
            .status(403)
            .json(errorEnvelope(ErrorCode.FORBIDDEN, 'You are not authorised for this action.'));
          return;
        }
      }
    }

    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, employmentType: true },
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
          // Event-based: show daysUsed (no remaining concept per standard balance)
          await prisma.leaveBalance.findUnique({
            where: {
              employeeId_leaveTypeId_year: { employeeId: employee.id, leaveTypeId: lt.id, year },
            },
          });
          return {
            type: lt.name,
            remaining: null as number | null,
            total: null as number | null,
            carryForwardCap: null as number | null,
            eligible: true, // Phase 2 stub — eligibility logic (gender etc.) is out of scope for v1
          };
        }

        const quota = lt.quotas.find((q) => q.employmentType === employee.employmentType);
        const total = quota?.daysPerYear ?? null;

        // Get or create balance row
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
          type: lt.name,
          remaining: balRow.daysRemaining,
          total,
          carryForwardCap: lt.carryForwardCap,
          eligible: null as boolean | null,
        };
      }),
    );

    res.status(200).json({ data: { employeeId, year, balances } });
  },
);

// ── POST /leave/balances/adjust (Admin — A-07) ───────────────────────────────

leaveRouter.post(
  '/balances/adjust',
  requireSession(),
  requireRole('Admin'),
  validateBody(AdjustBalanceRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { employeeId, type, delta, reason } = req.body as {
      employeeId: string;
      type: string;
      delta: number;
      reason: string;
    };

    const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
      return;
    }

    const leaveType = await prisma.leaveType.findUnique({ where: { name: type } });
    if (!leaveType) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, `Leave type '${type}' not found.`));
      return;
    }

    const year = new Date().getFullYear();

    const result = await prisma.$transaction(async (tx) => {
      const before = await tx.leaveBalance.findUnique({
        where: {
          employeeId_leaveTypeId_year: { employeeId, leaveTypeId: leaveType.id, year },
        },
      });

      // SEC-003-P2: clamp the post-adjustment balance at 0. We pre-fetch
      // the existing remainder so we can compute the correct floor without
      // racing the increment.
      const existing = await tx.leaveBalance.findUnique({
        where: {
          employeeId_leaveTypeId_year: { employeeId, leaveTypeId: leaveType.id, year },
        },
        select: { daysRemaining: true },
      });
      const currentRemaining = existing?.daysRemaining ?? 0;
      const target = Math.max(0, currentRemaining + delta);

      const balRow = await tx.leaveBalance.upsert({
        where: {
          employeeId_leaveTypeId_year: { employeeId, leaveTypeId: leaveType.id, year },
        },
        create: {
          employeeId,
          leaveTypeId: leaveType.id,
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

      // Ledger entry
      await tx.leaveBalanceLedger.create({
        data: {
          employeeId,
          leaveTypeId: leaveType.id,
          year,
          delta,
          reason: 'Adjustment',
          relatedRequestId: null,
          createdBy: req.user!.id,
        },
      });

      await audit({
        tx,
        actorId: req.user!.id,
        actorRole: req.user!.role,
        actorIp: req.ip ?? null,
        action: 'leave.balance.adjust',
        targetType: 'LeaveBalance',
        targetId: balRow.id,
        module: 'leave',
        before: before ? { daysRemaining: before.daysRemaining } : null,
        after: { daysRemaining: balRow.daysRemaining, delta, reason },
      });

      return balRow;
    });

    // Find quota for total
    const quota = await prisma.leaveQuota.findUnique({
      where: {
        leaveTypeId_employmentType: {
          leaveTypeId: leaveType.id,
          employmentType: employee.employmentType,
        },
      },
    });

    res.status(200).json({
      data: {
        balance: {
          type,
          remaining: result.daysRemaining,
          total: quota?.daysPerYear ?? null,
          carryForwardCap: leaveType.carryForwardCap,
          eligible: null,
        },
      },
    });
  },
);

// ── POST /leave/requests ─────────────────────────────────────────────────────

leaveRouter.post(
  '/requests',
  requireSession(),
  validateBody(CreateLeaveRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const { type, fromDate: fromDateStr, toDate: toDateStr, reason } = req.body as {
      type: string;
      fromDate: string;
      toDate: string;
      reason: string;
    };

    const fromDate = new Date(fromDateStr + 'T00:00:00.000Z');
    const toDate = new Date(toDateStr + 'T00:00:00.000Z');

    // Validate dates
    if (fromDate > toDate) {
      res.status(400).json(
        errorEnvelope(ErrorCode.INVALID_DATE_RANGE, 'fromDate must be on or before toDate.'),
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
        // Load the leave type
        const leaveType = await tx.leaveType.findUnique({ where: { name: type } });
        if (!leaveType) {
          const e: TxError = new Error(`Leave type '${type}' not found.`);
          e.statusCode = 404;
          e.code = ErrorCode.NOT_FOUND;
          throw e;
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

        // BL-010: check overlap with regularisation (Phase 2 stub — always null).
        // SEC-004-P2: when Phase 3 wires this in, we MUST emit `details`
        // matching LeaveConflictDetailsSchema (DN-19 — never a generic error).
        // The shape below assumes the regularisation row exposes at least
        // { id, date, status, code? } — Phase 3 must align its return type.
        const regConflict = await findOverlappingRegularisation(user.id, fromDate, toDate, tx);
        if (regConflict) {
          const r = regConflict as {
            id: string;
            code?: string | null;
            date: Date;
            status: string;
          };
          const conflictDate = r.date.toISOString().split('T')[0]!;
          const e: TxError = new Error('Leave dates conflict with an approved regularisation.');
          e.statusCode = 409;
          e.code = ErrorCode.LEAVE_REG_CONFLICT;
          e.ruleId = 'BL-010';
          e.details = {
            conflictType: 'Regularisation',
            conflictId: r.id,
            conflictCode: r.code ?? '',
            conflictFrom: conflictDate,
            conflictTo: null,
            conflictStatus: r.status,
          };
          throw e;
        }

        // BL-014: balance check for accrual types
        if (!leaveType.isEventBased && type !== 'Unpaid') {
          const bal = await currentBalance(user.id, leaveType.id, year, tx);
          if (bal.remaining < days) {
            const e: TxError = new Error(
              `Insufficient ${type} leave balance. Requested: ${days}, Available: ${bal.remaining}`,
            );
            e.statusCode = 409;
            e.code = ErrorCode.INSUFFICIENT_BALANCE;
            e.ruleId = 'BL-014';
            e.details = { requested: days, available: bal.remaining };
            throw e;
          }
        }

        // Resolve routing (BL-015 / BL-016 / BL-017 / BL-022)
        const routing = await resolveRouting(user.id, type, tx);

        // Generate L-YYYY-NNNN code
        const code = await generateLeaveCode(year, tx);

        // Insert the request
        const created = await tx.leaveRequest.create({
          data: {
            code,
            employeeId: user.id,
            leaveTypeId: leaveType.id,
            fromDate,
            toDate,
            days,
            reason,
            status: 'Pending',
            routedTo: routing.routedTo,
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
          actorRole: user.role,
          actorIp: req.ip ?? null,
          action: 'leave.create',
          targetType: 'LeaveRequest',
          targetId: created.id,
          module: 'leave',
          before: null,
          after: {
            code: created.code,
            type,
            fromDate: fromDateStr,
            toDate: toDateStr,
            days,
            status: 'Pending',
            routedTo: routing.routedTo,
            approverId: routing.approverId,
          },
        });

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
      throw err; // re-throw unexpected errors to the global error handler
    }

    // Get balance snapshot for the response (balance NOT yet deducted — deduction on approval)
    const leaveType = await prisma.leaveType.findUnique({ where: { name: type } });
    let balanceAfterSubmit = null;

    if (leaveType && !leaveType.isEventBased && type !== 'Unpaid') {
      const snapshot = await currentBalance(user.id, leaveType.id, year, prisma);
      const quota = await prisma.leaveQuota.findFirst({
        where: {
          leaveTypeId: leaveType.id,
          employmentType: (
            await prisma.employee.findUnique({
              where: { id: user.id },
              select: { employmentType: true },
            })
          )?.employmentType,
        },
      });
      balanceAfterSubmit = {
        type,
        remaining: snapshot.remaining,
        total: quota?.daysPerYear ?? null,
        carryForwardCap: leaveType.carryForwardCap,
        eligible: null,
      };
    }

    // result is guaranteed to be set here — catch block either returns or re-throws
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
      status?: string;
      type?: string;
      fromDate?: string;
      toDate?: string;
      employeeId?: string;
      routedTo?: string;
      cursor?: string;
      limit?: string;
      sort?: string;
    };

    const limit = Number(query.limit ?? 20);
    const cursor = query.cursor as string | undefined;

    // Build where clause based on role
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: Record<string, any> = {};

    if (user.role === 'Employee') {
      // Employee: only own requests
      where['employeeId'] = user.id;
    } else if (user.role === 'Manager') {
      // Manager: own requests + subordinates' requests where they are the approver
      if (query.employeeId) {
        const subs = await getSubordinateIds(user.id);
        if (subs.includes(query.employeeId) || query.employeeId === user.id) {
          where['employeeId'] = query.employeeId;
        } else {
          // No access to that employee
          res.status(200).json({ data: [], nextCursor: null });
          return;
        }
      } else {
        // Own requests + requests assigned to them as approver in their subordinate tree
        const subs = await getSubordinateIds(user.id);
        where['OR'] = [
          { employeeId: user.id },
          {
            employeeId: { in: subs },
            approverId: user.id,
          },
        ];
      }
    } else if (user.role === 'Admin') {
      // Admin sees all; apply optional filters
      if (query.employeeId) where['employeeId'] = query.employeeId;
      if (query.routedTo) where['routedTo'] = query.routedTo;
    } else if (user.role === 'PayrollOfficer') {
      // SEC-001-P2: PayrollOfficer is scoped to own leave only (BL-004 —
      // every role is also an employee; SRS § 3.5 P-09 lists "My Leave"
      // and the leave queue is NOT a PO route).
      where['employeeId'] = user.id;
    }

    // Common filters
    if (query.status) where['status'] = query.status;
    if (query.type) {
      const lt = await prisma.leaveType.findUnique({ where: { name: query.type } });
      if (lt) where['leaveTypeId'] = lt.id;
    }
    if (query.fromDate) where['fromDate'] = { gte: new Date(query.fromDate) };
    if (query.toDate) where['toDate'] = { lte: new Date(query.toDate) };

    // Cursor pagination
    if (cursor) {
      where['id'] = { gt: cursor };
    }

    const requests = await prisma.leaveRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      include: requestInclude,
    });

    const hasMore = requests.length > limit;
    const page = hasMore ? requests.slice(0, limit) : requests;
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

    res.status(200).json({
      data: page.map(formatRequest),
      nextCursor,
    });
  },
);

// ── GET /leave/requests/:id ──────────────────────────────────────────────────

leaveRouter.get(
  '/requests/:id',
  requireSession(),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const id = req.params['id'] as string;

    const request = await prisma.leaveRequest.findUnique({
      where: { id },
      include: requestInclude,
    });

    if (!request) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Leave request not found.'));
      return;
    }

    const visible = await canSeeRequest(user.id, user.role, request);
    if (!visible) {
      // Do not leak existence
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Leave request not found.'));
      return;
    }

    res.status(200).json({ data: formatRequest(request) });
  },
);

// ── POST /leave/requests/:id/approve ────────────────────────────────────────

leaveRouter.post(
  '/requests/:id/approve',
  requireSession(),
  validateBody(ApproveLeaveRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const id = req.params['id'] as string;
    const { note, version } = req.body as { note?: string; version: number };

    const request = await prisma.leaveRequest.findUnique({
      where: { id },
      include: { leaveType: true },
    });

    if (!request) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Leave request not found.'));
      return;
    }

    // Access check: (Manager AND approverId == self) OR Admin
    if (user.role !== 'Admin') {
      if (user.role !== 'Manager' || request.approverId !== user.id) {
        res.status(403).json(errorEnvelope(ErrorCode.FORBIDDEN, 'You are not authorised to approve this request.'));
        return;
      }
    }

    // Must be Pending or Escalated
    if (request.status !== 'Pending' && request.status !== 'Escalated') {
      res.status(409).json(
        errorEnvelope(ErrorCode.VALIDATION_FAILED, `Cannot approve a request with status '${request.status}'.`),
      );
      return;
    }

    // Optimistic concurrency
    if (request.version !== version) {
      res.status(409).json(
        errorEnvelope(ErrorCode.VERSION_MISMATCH, 'The request has been modified by another action. Please refresh and retry.'),
      );
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await applyApproval(id, user.id, note, tx);

      await audit({
        tx,
        actorId: user.id,
        actorRole: user.role,
        actorIp: req.ip ?? null,
        action: 'leave.approve',
        targetType: 'LeaveRequest',
        targetId: id,
        module: 'leave',
        before: { status: request.status, version: request.version },
        after: { status: 'Approved', deductedDays: result.deductedDays },
      });

      return result;
    });

    res.status(200).json({ data: formatRequest(updated) });
  },
);

// ── POST /leave/requests/:id/reject ─────────────────────────────────────────

leaveRouter.post(
  '/requests/:id/reject',
  requireSession(),
  validateBody(RejectLeaveRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const id = req.params['id'] as string;
    const { note, version } = req.body as { note: string; version: number };

    const request = await prisma.leaveRequest.findUnique({
      where: { id },
      include: requestInclude,
    });

    if (!request) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Leave request not found.'));
      return;
    }

    // Access check: (Manager AND approverId == self) OR Admin
    if (user.role !== 'Admin') {
      if (user.role !== 'Manager' || request.approverId !== user.id) {
        res.status(403).json(errorEnvelope(ErrorCode.FORBIDDEN, 'You are not authorised to reject this request.'));
        return;
      }
    }

    if (request.status !== 'Pending' && request.status !== 'Escalated') {
      res.status(409).json(
        errorEnvelope(ErrorCode.VALIDATION_FAILED, `Cannot reject a request with status '${request.status}'.`),
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
          status: 'Rejected',
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
        actorRole: user.role,
        actorIp: req.ip ?? null,
        action: 'leave.reject',
        targetType: 'LeaveRequest',
        targetId: id,
        module: 'leave',
        before: { status: request.status, version: request.version },
        after: { status: 'Rejected', decisionNote: note },
      });

      return result;
    });

    res.status(200).json({ data: formatRequest(updated) });
  },
);

// ── POST /leave/requests/:id/cancel ─────────────────────────────────────────

leaveRouter.post(
  '/requests/:id/cancel',
  requireSession(),
  validateBody(CancelLeaveRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const id = req.params['id'] as string;
    const { note, version } = req.body as { note?: string; version: number };

    const request = await prisma.leaveRequest.findUnique({
      where: { id },
      include: requestInclude,
    });

    if (!request) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Leave request not found.'));
      return;
    }

    // Visibility check
    const visible = await canSeeRequest(user.id, user.role, request);
    if (!visible) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Leave request not found.'));
      return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const fromDay = new Date(request.fromDate);
    fromDay.setHours(0, 0, 0, 0);

    // BL-019 cancellation rights:
    //   - Owner: if Pending OR (Approved AND today < fromDate)
    //   - Manager-in-chain: any time (as long as they can see it)
    //   - Admin: always
    const isOwner = request.employeeId === user.id;
    const isAdmin = user.role === 'Admin';

    let canCancel = false;

    if (isAdmin) {
      canCancel = true;
    } else if (user.role === 'Manager') {
      const subs = await getSubordinateIds(user.id);
      if (subs.includes(request.employeeId)) {
        canCancel = true;
      }
    }

    if (!canCancel && isOwner) {
      if (request.status === 'Pending') {
        canCancel = true;
      } else if (request.status === 'Approved' && today < fromDay) {
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

    // Optimistic concurrency
    if (request.version !== version) {
      res.status(409).json(
        errorEnvelope(ErrorCode.VERSION_MISMATCH, 'The request has been modified. Please refresh and retry.'),
      );
      return;
    }

    // Can only cancel Pending, Approved, or Escalated requests
    if (!['Pending', 'Approved', 'Escalated'].includes(request.status)) {
      res.status(409).json(
        errorEnvelope(ErrorCode.VALIDATION_FAILED, `Cannot cancel a request with status '${request.status}'.`),
      );
      return;
    }

    const { request: updated, restoredDays } = await prisma.$transaction(async (tx) => {
      const result = await applyCancellation(id, user.id, today, note, tx);

      await audit({
        tx,
        actorId: user.id,
        actorRole: user.role,
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
          status: 'Cancelled',
          restoredDays: result.restoredDays,
          cancelledAfterStart: result.request.cancelledAfterStart,
        },
      });

      return result;
    });

    res.status(200).json({
      data: {
        leaveRequest: formatRequest(updated),
        restoredDays,
      },
    });
  },
);
