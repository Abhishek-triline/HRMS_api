/**
 * Leave service — v2 (INT codes throughout).
 *
 * Pure business-logic functions. All functions that mutate state accept a
 * Prisma.TransactionClient so they compose with the caller's transaction.
 *
 * Rules enforced here:
 *   BL-009  Leave overlap detection → LEAVE_OVERLAP
 *   BL-010  Leave/regularisation conflict → LEAVE_REG_CONFLICT
 *   BL-011  Full-day units only
 *   BL-012  Sick leave resets to zero on Jan 1 carry-forward
 *   BL-013  Annual + Casual carry-forward caps applied
 *   BL-014  Maternity/Paternity: no annual balance; eligibility only
 *   BL-015/016 Maternity/Paternity route to Admin always
 *   BL-017  Manager with no reporting manager → Admin
 *   BL-018  5-working-day SLA → escalate to Admin
 *   BL-019  Cancellation rights per role
 *   BL-020  Balance restore: full before start, partial after
 *   BL-021  Balance deducted on APPROVAL (not submission)
 *   BL-022  Exited manager's pending requests → Admin
 */

import type { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../lib/prisma.js';
import { addWorkingDays } from './workingDays.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notifications.js';
import { getLeaveConfig } from '../../lib/config.js';
import {
  LeaveStatus,
  RoutedTo,
  EmployeeStatus,
  LeaveTypeId,
  isEventBasedLeaveTypeId,
  LedgerReason,
  RoleId,
} from '../../lib/statusInt.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RoutingResult {
  routedToId: number;
  approverId: number;
}

export interface BalanceSnapshot {
  remaining: number;
  total: number | null;
  carryForwardCap: number | null;
}

// ── Compute leave days (BL-011) ───────────────────────────────────────────────

export function computeLeaveDays(fromDate: Date, toDate: Date): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  const from = new Date(fromDate);
  from.setHours(0, 0, 0, 0);
  const to = new Date(toDate);
  to.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / msPerDay) + 1);
}

// ── Admin lookup ──────────────────────────────────────────────────────────────

export async function findDefaultAdmin(
  tx: Prisma.TransactionClient,
): Promise<{ id: number; name: string }> {
  const admin = await tx.employee.findFirst({
    where: { roleId: RoleId.Admin, status: EmployeeStatus.Active },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });

  if (!admin) {
    throw new Error('No active Admin found in the system — cannot route leave request.');
  }

  return admin;
}

// ── Routing (BL-015 / BL-016 / BL-017 / BL-022) ─────────────────────────────

export async function resolveRouting(
  employeeId: number,
  leaveTypeId: number,
  tx: Prisma.TransactionClient,
): Promise<RoutingResult> {
  // Rule 1: event-based leave always goes to Admin
  if (isEventBasedLeaveTypeId(leaveTypeId)) {
    const admin = await findDefaultAdmin(tx);
    return { routedToId: RoutedTo.Admin, approverId: admin.id };
  }

  const emp = await tx.employee.findUnique({
    where: { id: employeeId },
    select: { reportingManagerId: true },
  });

  if (!emp) throw new Error(`Employee ${employeeId} not found`);

  // Rule 2: no reporting manager → Admin
  if (!emp.reportingManagerId) {
    const admin = await findDefaultAdmin(tx);
    return { routedToId: RoutedTo.Admin, approverId: admin.id };
  }

  // Rule 3: check if the manager is Exited
  const manager = await tx.employee.findUnique({
    where: { id: emp.reportingManagerId },
    select: { id: true, status: true },
  });

  if (!manager || manager.status === EmployeeStatus.Exited) {
    const admin = await findDefaultAdmin(tx);
    return { routedToId: RoutedTo.Admin, approverId: admin.id };
  }

  return { routedToId: RoutedTo.Manager, approverId: manager.id };
}

// ── Overlap detection (BL-009) ────────────────────────────────────────────────

export async function findOverlappingLeave(
  employeeId: number,
  fromDate: Date,
  toDate: Date,
  tx: Prisma.TransactionClient,
  excludeId?: number,
) {
  const conflict = await tx.leaveRequest.findFirst({
    where: {
      employeeId,
      status: { in: [LeaveStatus.Pending, LeaveStatus.Approved, LeaveStatus.Escalated] },
      fromDate: { lte: toDate },
      toDate: { gte: fromDate },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    include: { leaveType: { select: { name: true } } },
  });

  return conflict ?? null;
}

// ── Regularisation conflict (BL-010) ─────────────────────────────────────────

export async function findOverlappingRegularisation(
  employeeId: number,
  fromDate: Date,
  toDate: Date,
  tx: Prisma.TransactionClient,
) {
  return await tx.regularisationRequest.findFirst({
    where: {
      employeeId,
      status: 2, // RegStatus.Approved
      date: { gte: fromDate, lte: toDate },
    },
    select: { id: true, code: true, date: true, status: true },
  });
}

// ── Balance helpers ───────────────────────────────────────────────────────────

export async function currentBalanceRow(
  employeeId: number,
  leaveTypeId: number,
  year: number,
  tx: Prisma.TransactionClient,
) {
  const existing = await tx.leaveBalance.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
  });

  if (existing) return existing;

  return tx.leaveBalance.upsert({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
    create: { employeeId, leaveTypeId, year, daysRemaining: 0, daysUsed: 0, version: 0 },
    update: {},
  });
}

export async function currentBalance(
  employeeId: number,
  leaveTypeId: number,
  year: number,
  tx: Prisma.TransactionClient,
): Promise<BalanceSnapshot & { leaveTypeId: number; version: number }> {
  const row = await currentBalanceRow(employeeId, leaveTypeId, year, tx);

  const leaveType = await tx.leaveType.findUnique({
    where: { id: leaveTypeId },
    select: { carryForwardCap: true, isEventBased: true },
  });

  const emp = await tx.employee.findUnique({
    where: { id: employeeId },
    select: { employmentTypeId: true },
  });

  let total: number | null = null;
  if (!leaveType?.isEventBased && emp) {
    const quota = await tx.leaveQuota.findUnique({
      where: {
        leaveTypeId_employmentTypeId: {
          leaveTypeId,
          employmentTypeId: emp.employmentTypeId,
        },
      },
      select: { daysPerYear: true },
    });
    total = quota?.daysPerYear ?? null;
  }

  return {
    leaveTypeId,
    remaining: row.daysRemaining,
    total,
    carryForwardCap: leaveType?.carryForwardCap ?? null,
    version: row.version,
  };
}

// ── Approval (BL-021) ─────────────────────────────────────────────────────────

export async function applyApproval(
  requestId: number,
  approverId: number,
  note: string | undefined,
  tx: Prisma.TransactionClient,
) {
  const request = await tx.leaveRequest.findUnique({
    where: { id: requestId },
    include: { leaveType: true, employee: { select: { employmentTypeId: true } } },
  });

  if (!request) throw new Error(`LeaveRequest ${requestId} not found`);

  const year = request.fromDate.getFullYear();
  const isEventBased = request.leaveType.isEventBased;
  const isUnpaid = request.leaveTypeId === LeaveTypeId.Unpaid;

  let deductedDays = 0;

  if (isEventBased) {
    await tx.leaveBalance.upsert({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: request.employeeId,
          leaveTypeId: request.leaveTypeId,
          year,
        },
      },
      create: {
        employeeId: request.employeeId,
        leaveTypeId: request.leaveTypeId,
        year,
        daysRemaining: 0,
        daysUsed: request.days,
        version: 0,
      },
      update: { daysUsed: { increment: request.days } },
    });
  } else if (!isUnpaid) {
    await currentBalanceRow(request.employeeId, request.leaveTypeId, year, tx);

    await tx.leaveBalance.update({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: request.employeeId,
          leaveTypeId: request.leaveTypeId,
          year,
        },
      },
      data: {
        daysRemaining: { decrement: request.days },
        daysUsed: { increment: request.days },
        version: { increment: 1 },
      },
    });

    deductedDays = request.days;

    await tx.leaveBalanceLedger.create({
      data: {
        employeeId: request.employeeId,
        leaveTypeId: request.leaveTypeId,
        year,
        delta: -request.days,
        reasonId: LedgerReason.Approval,
        relatedRequestId: requestId,
        createdBy: approverId,
      },
    });
  }

  const updated = await tx.leaveRequest.update({
    where: { id: requestId },
    data: {
      status: LeaveStatus.Approved,
      decidedAt: new Date(),
      decidedBy: approverId,
      decisionNote: note ?? null,
      deductedDays,
      version: { increment: 1 },
    },
    include: {
      employee: { select: { name: true, code: true } },
      approver: { select: { name: true } },
      leaveType: { select: { name: true } },
    },
  });

  return updated;
}

// ── Cancellation (BL-019 / BL-020) ───────────────────────────────────────────

export async function applyCancellation(
  requestId: number,
  cancelledById: number,
  cancelDate: Date,
  note: string | undefined,
  tx: Prisma.TransactionClient,
) {
  const request = await tx.leaveRequest.findUnique({
    where: { id: requestId },
    include: { leaveType: true },
  });

  if (!request) throw new Error(`LeaveRequest ${requestId} not found`);

  const year = request.fromDate.getFullYear();
  const isEventBased = request.leaveType.isEventBased;
  const isUnpaid = request.leaveTypeId === LeaveTypeId.Unpaid;

  const cancelDay = new Date(cancelDate);
  cancelDay.setHours(0, 0, 0, 0);
  const fromDay = new Date(request.fromDate);
  fromDay.setHours(0, 0, 0, 0);
  const toDay = new Date(request.toDate);
  toDay.setHours(0, 0, 0, 0);

  const cancelledAfterStart = cancelDay >= fromDay;
  let restoredDays = 0;

  if (request.status === LeaveStatus.Approved && request.deductedDays > 0) {
    if (!cancelledAfterStart) {
      restoredDays = request.deductedDays;
    } else {
      const effectiveEnd = cancelDay < toDay ? cancelDay : toDay;
      const msPerDay = 1000 * 60 * 60 * 24;
      const completedDays = Math.max(
        0,
        Math.round((effectiveEnd.getTime() - fromDay.getTime()) / msPerDay) + 1,
      );
      restoredDays = Math.max(0, request.deductedDays - completedDays);
    }

    if (restoredDays > 0 && !isUnpaid) {
      if (isEventBased) {
        await tx.leaveBalance.updateMany({
          where: {
            employeeId: request.employeeId,
            leaveTypeId: request.leaveTypeId,
            year,
          },
          data: { daysUsed: { decrement: restoredDays } },
        });
      } else {
        await tx.leaveBalance.update({
          where: {
            employeeId_leaveTypeId_year: {
              employeeId: request.employeeId,
              leaveTypeId: request.leaveTypeId,
              year,
            },
          },
          data: {
            daysRemaining: { increment: restoredDays },
            daysUsed: { decrement: restoredDays },
            version: { increment: 1 },
          },
        });

        await tx.leaveBalanceLedger.create({
          data: {
            employeeId: request.employeeId,
            leaveTypeId: request.leaveTypeId,
            year,
            delta: restoredDays,
            reasonId: LedgerReason.Cancellation,
            relatedRequestId: requestId,
            createdBy: cancelledById,
          },
        });
      }
    }
  }

  const updated = await tx.leaveRequest.update({
    where: { id: requestId },
    data: {
      status: LeaveStatus.Cancelled,
      cancelledAt: cancelDate,
      cancelledBy: cancelledById,
      cancelledAfterStart,
      restoredDays,
      decisionNote: note ?? request.decisionNote,
      version: { increment: 1 },
    },
    include: {
      employee: { select: { name: true, code: true } },
      approver: { select: { name: true } },
      leaveType: { select: { name: true } },
    },
  });

  return { request: updated, restoredDays };
}

// ── Escalation sweep (BL-018) ─────────────────────────────────────────────────

export async function escalateStaleRequests(
  tx: Prisma.TransactionClient,
): Promise<number> {
  const now = new Date();

  const { escalationPeriodDays } = await getLeaveConfig();

  const pending = await tx.leaveRequest.findMany({
    where: {
      status: LeaveStatus.Pending,
      routedToId: RoutedTo.Manager,
    },
    include: {
      approver: { select: { id: true, status: true } },
    },
  });

  const admin = await findDefaultAdmin(tx);
  let escalatedCount = 0;

  for (const req of pending) {
    const slaDeadline = addWorkingDays(req.createdAt, escalationPeriodDays);
    const slaBreach = now > slaDeadline;
    const approverExited = req.approver?.status === EmployeeStatus.Exited;

    if (!slaBreach && !approverExited) continue;

    await tx.leaveRequest.update({
      where: { id: req.id },
      data: {
        status: LeaveStatus.Escalated,
        escalatedAt: now,
        routedToId: RoutedTo.Admin,
        approverId: admin.id,
        version: { increment: 1 },
      },
    });

    await audit({
      tx,
      actorId: null,
      actorRole: 'system',
      actorIp: null,
      action: 'leave.escalated',
      targetType: 'LeaveRequest',
      targetId: req.id,
      module: 'leave',
      before: {
        status: req.status,
        routedToId: req.routedToId,
        approverId: req.approverId,
        escalatedAt: req.escalatedAt,
      },
      after: {
        status: LeaveStatus.Escalated,
        routedToId: RoutedTo.Admin,
        approverId: admin.id,
        escalatedAt: now.toISOString(),
        reason: approverExited ? 'approver_exited' : 'sla_breach',
      },
    });

    const activeAdmins = await tx.employee.findMany({
      where: { roleId: RoleId.Admin, status: EmployeeStatus.Active },
      select: { id: true },
    });
    const adminIds = activeAdmins.map((a) => a.id);
    const recipientIds = Array.from(new Set([...adminIds, req.employeeId]));

    await notify({
      tx,
      recipientIds,
      category: 'Leave',
      title: 'Leave request escalated to Admin (5-working-day SLA)',
      body: `Leave request ${req.code} has been escalated to Admin because the 5-working-day SLA was breached.`,
      link: `/admin/leave-queue/${req.id}`,
    });

    logger.info(
      { requestId: req.id, code: req.code, reason: approverExited ? 'approver_exited' : 'sla_breach' },
      'leave.escalation-sweep: escalated request',
    );

    escalatedCount++;
  }

  return escalatedCount;
}

// ── Carry-forward (BL-012 / BL-013) ─────────────────────────────────────────

export async function runCarryForward(
  newYear: number,
  tx: Prisma.TransactionClient,
): Promise<number> {
  const prevYear = newYear - 1;
  const db = tx ?? defaultPrisma;

  const employees = await db.employee.findMany({
    where: { status: { in: [EmployeeStatus.Active, EmployeeStatus.OnLeave, EmployeeStatus.OnNotice] } },
    select: { id: true, employmentTypeId: true },
  });

  const leaveTypes = await db.leaveType.findMany();

  let processed = 0;

  for (const emp of employees) {
    for (const lt of leaveTypes) {
      if (lt.isEventBased) continue;

      const existingNewYear = await tx.leaveBalance.findUnique({
        where: {
          employeeId_leaveTypeId_year: {
            employeeId: emp.id,
            leaveTypeId: lt.id,
            year: newYear,
          },
        },
      });

      if (existingNewYear) continue;

      const prevBalance = await tx.leaveBalance.findUnique({
        where: {
          employeeId_leaveTypeId_year: {
            employeeId: emp.id,
            leaveTypeId: lt.id,
            year: prevYear,
          },
        },
      });

      const prevRemaining = prevBalance?.daysRemaining ?? 0;

      const quota = await tx.leaveQuota.findUnique({
        where: {
          leaveTypeId_employmentTypeId: {
            leaveTypeId: lt.id,
            employmentTypeId: emp.employmentTypeId,
          },
        },
      });
      const annualQuota = quota?.daysPerYear ?? 0;

      let carryForward = 0;

      // Sick (id=2) and Unpaid (id=4) reset to zero
      if (lt.id === LeaveTypeId.Sick || lt.id === LeaveTypeId.Unpaid) {
        carryForward = 0;
      } else {
        const cap = lt.carryForwardCap ?? 0;
        carryForward = Math.min(prevRemaining, cap);
      }

      const newBalance = annualQuota + carryForward;

      await tx.leaveBalance.create({
        data: {
          employeeId: emp.id,
          leaveTypeId: lt.id,
          year: newYear,
          daysRemaining: newBalance,
          daysUsed: 0,
          version: 0,
        },
      });

      if (carryForward > 0) {
        await tx.leaveBalanceLedger.create({
          data: {
            employeeId: emp.id,
            leaveTypeId: lt.id,
            year: newYear,
            delta: carryForward,
            reasonId: LedgerReason.CarryForward,
            relatedRequestId: null,
            createdBy: null,
          },
        });
      }

      if (annualQuota > 0) {
        await tx.leaveBalanceLedger.create({
          data: {
            employeeId: emp.id,
            leaveTypeId: lt.id,
            year: newYear,
            delta: annualQuota,
            reasonId: LedgerReason.Initial,
            relatedRequestId: null,
            createdBy: null,
          },
        });
      }

      await audit({
        tx,
        actorId: null,
        actorRole: 'system',
        actorIp: null,
        action: 'leave.carry-forward',
        targetType: 'AttendanceRecord', // use Employee as closest available
        targetId: null,
        module: 'leave',
        before: { year: prevYear, leaveTypeId: lt.id, daysRemaining: prevRemaining },
        after: { year: newYear, leaveTypeId: lt.id, daysRemaining: newBalance, carryForward, annualQuota },
      });

      processed++;
    }
  }

  return processed;
}
