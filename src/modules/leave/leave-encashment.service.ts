/**
 * Leave Encashment service — BL-LE-01..14, v2 schema (INT IDs, INT status codes).
 *
 * v2 schema notes:
 *   - All IDs are INT (number).
 *   - LeaveEncashment.status is INT (LeaveEncashmentStatus constants).
 *   - LeaveEncashment.routedToId (INT, not routedTo).
 *   - No paidInPayslipId on LeaveEncashment; encashment FK lives on Payslip.encashmentId.
 *   - employee.role → employee.roleId (INT).
 *
 * State machine:
 *   Pending → ManagerApproved → AdminFinalised → Paid
 *   Any pre-Paid state → Rejected
 *   Any pre-ManagerApproved state → Cancelled (employee-self)
 *   Admin can cancel any pre-Paid state
 */

import type { Prisma } from '@prisma/client';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notifications.js';
import { logger } from '../../lib/logger.js';
import { resolveRouting, findDefaultAdmin } from './leave.service.js';
import { generateEncashmentCode } from './encashmentCode.js';
import {
  LeaveEncashmentStatus,
  LeaveTypeId,
  RoleId,
  RoutedTo,
  EmployeeStatus,
  type AuditActorRoleValue,
} from '../../lib/statusInt.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EncashmentWindowConfig {
  windowStartMonth: number;
  windowEndMonth: number;
  windowEndDay: number;
  maxPercent: number;
}

// ── Config helper ─────────────────────────────────────────────────────────────

/**
 * Read encashment window config from the Configuration table.
 * Falls back to hard-coded defaults if rows are absent.
 */
export async function getEncashmentConfig(
  tx: Prisma.TransactionClient,
): Promise<EncashmentWindowConfig> {
  const keys = [
    'ENCASHMENT_WINDOW_START_MONTH',
    'ENCASHMENT_WINDOW_END_MONTH',
    'ENCASHMENT_WINDOW_END_DAY',
    'ENCASHMENT_MAX_PERCENT',
  ];

  const rows = await tx.configuration.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true },
  });

  const map = new Map(rows.map((r) => [r.key, r.value as number]));

  return {
    windowStartMonth: map.get('ENCASHMENT_WINDOW_START_MONTH') ?? 12,
    windowEndMonth: map.get('ENCASHMENT_WINDOW_END_MONTH') ?? 1,
    windowEndDay: map.get('ENCASHMENT_WINDOW_END_DAY') ?? 15,
    maxPercent: map.get('ENCASHMENT_MAX_PERCENT') ?? 50,
  };
}

// ── Window check (BL-LE-04) ───────────────────────────────────────────────────

/**
 * Returns true if the given date is inside the encashment window.
 *
 * Window: Dec 1 (year Y) → Jan 15 (year Y+1) by default.
 * Configurable via ENCASHMENT_WINDOW_START_MONTH / _END_MONTH / _END_DAY.
 *
 * Logic handles the year-crossing window (start > end in month number).
 */
export function isInsideEncashmentWindow(
  now: Date,
  cfg: EncashmentWindowConfig,
): boolean {
  const month = now.getMonth() + 1; // 1-12
  const day = now.getDate();

  const { windowStartMonth, windowEndMonth, windowEndDay } = cfg;

  if (windowStartMonth > windowEndMonth) {
    // Crosses year boundary (e.g. Dec → Jan)
    if (month === windowStartMonth) return true;
    if (month < windowStartMonth && month > windowEndMonth) return false;
    if (month === windowEndMonth) return day <= windowEndDay;
    if (month < windowEndMonth) return true;
    return false;
  } else {
    // Within same year (e.g. Nov → Dec)
    if (month < windowStartMonth) return false;
    if (month > windowEndMonth) return false;
    if (month === windowStartMonth) return true;
    if (month === windowEndMonth) return day <= windowEndDay;
    return true;
  }
}

// ── BL-LE-03: existing approved-or-better check ───────────────────────────────

/**
 * Returns an existing encashment for this employee/year that is in
 * ManagerApproved, AdminFinalised, or Paid status (the "quota-consuming" states).
 */
async function findApprovedEncashment(
  employeeId: number,
  year: number,
  tx: Prisma.TransactionClient,
) {
  return tx.leaveEncashment.findFirst({
    where: {
      employeeId,
      year,
      status: {
        in: [
          LeaveEncashmentStatus.ManagerApproved,
          LeaveEncashmentStatus.AdminFinalised,
          LeaveEncashmentStatus.Paid,
        ],
      },
    },
  });
}

// ── Submit (POST /leave-encashments) ─────────────────────────────────────────

/**
 * Submit a new encashment request.
 *
 * Validates:
 *   - Window (BL-LE-04)
 *   - Annual leave type only (BL-LE-01)
 *   - Employee is Active (BL-LE-13)
 *   - No existing approved encashment for this year (BL-LE-03 — Pending is allowed)
 *   - Balance > 0 (soft check; hard clamp at adminFinalise)
 *
 * Creates a Pending row and notifies the assigned approver.
 */
export async function submitEncashmentRequest(
  employeeId: number,
  daysRequested: number,
  year: number,
  tx: Prisma.TransactionClient,
  actorIp: string | null = null,
): Promise<ReturnType<typeof formatEncashment>> {
  const now = new Date();

  // Check employee exists and is Active (BL-LE-13)
  const employee = await tx.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, status: true, roleId: true, name: true, code: true },
  });
  if (!employee) throw makeError(404, 'NOT_FOUND', 'Employee not found.');
  if (employee.status === EmployeeStatus.Exited) {
    throw makeError(409, 'VALIDATION_FAILED', 'Exited employees cannot submit encashment requests.', 'BL-LE-13');
  }

  // BL-LE-04: window check
  const cfg = await getEncashmentConfig(tx);
  if (!isInsideEncashmentWindow(now, cfg)) {
    throw makeError(
      409,
      'ENCASHMENT_OUT_OF_WINDOW',
      `Encashment requests can only be submitted between month ${cfg.windowStartMonth} day 1 and month ${cfg.windowEndMonth} day ${cfg.windowEndDay}.`,
      'BL-LE-04',
    );
  }

  // BL-LE-03: check for an existing approved encashment (before leave-type lookup — faster fail)
  const existing = await findApprovedEncashment(employeeId, year, tx);
  if (existing) {
    throw makeError(
      409,
      'ENCASHMENT_ALREADY_USED',
      `An approved encashment request already exists for year ${year} (code: ${existing.code}).`,
      'BL-LE-03',
      { conflictId: existing.id, conflictCode: existing.code },
    );
  }

  // BL-LE-01: Annual only (defensive — service-level guard)
  const annualLeaveTypeId = LeaveTypeId.Annual;

  // Soft balance check (hard clamp is at adminFinalise)
  const balance = await tx.leaveBalance.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: annualLeaveTypeId, year } },
  });
  if (!balance || balance.daysRemaining <= 0) {
    throw makeError(
      409,
      'ENCASHMENT_INSUFFICIENT_BALANCE',
      'No Annual leave balance remaining for this year.',
      'BL-LE-02',
    );
  }

  // Routing (BL-LE-05: mirrors leave routing — Annual goes to Manager or Admin)
  const routing = await resolveRouting(employeeId, annualLeaveTypeId, tx);

  // Generate code
  const code = await generateEncashmentCode(year, tx);

  // Create row
  const encashment = await tx.leaveEncashment.create({
    data: {
      code,
      employeeId,
      year,
      daysRequested,
      status: LeaveEncashmentStatus.Pending,
      routedToId: routing.routedToId,
      approverId: routing.approverId,
      version: 0,
    },
    include: {
      employee: { select: { name: true, code: true } },
      approver: { select: { name: true } },
    },
  });

  // Audit
  await audit({
    tx,
    actorId: employeeId,
    actorRole: employee.roleId as AuditActorRoleValue,
    actorIp,
    action: 'leave.encashment.request.create',
    targetType: 'LeaveEncashment',
    targetId: encashment.id,
    module: 'leave',
    before: null,
    after: {
      code: encashment.code,
      year,
      daysRequested,
      status: LeaveEncashmentStatus.Pending,
      routedToId: routing.routedToId,
      approverId: routing.approverId,
    },
  });

  // Notify approver(s)
  let recipientIds: number | number[] = routing.approverId;
  if (routing.routedToId === RoutedTo.Admin) {
    const activeAdmins = await tx.employee.findMany({
      where: { roleId: RoleId.Admin, status: EmployeeStatus.Active },
      select: { id: true },
    });
    recipientIds = activeAdmins.map((a) => a.id);
  }
  await notify({
    tx,
    recipientIds,
    category: 'Leave',
    title: `New encashment request from ${encashment.employee.name}`,
    body: `${encashment.employee.name} has requested ${daysRequested} day(s) of Annual leave encashment for ${year}.`,
    link: `/${routing.routedToId === RoutedTo.Manager ? 'manager' : 'admin'}/leave-encashment-queue/${encashment.id}`,
  });

  return formatEncashment(encashment);
}

// ── Manager approve (BL-LE-05) ────────────────────────────────────────────────

/**
 * Transition Pending → ManagerApproved.
 * Verifies the actor is the assigned approver.
 * Reassigns approverId to Admin for the second step.
 */
export async function managerApproveEncashment(
  requestId: number,
  approverId: number,
  note: string | undefined,
  tx: Prisma.TransactionClient,
  actorRole: AuditActorRoleValue,
  actorIp: string | null = null,
): Promise<ReturnType<typeof formatEncashment>> {
  const enc = await tx.leaveEncashment.findUnique({
    where: { id: requestId },
    include: {
      employee: { select: { name: true, code: true } },
      approver: { select: { name: true } },
    },
  });
  if (!enc) throw makeError(404, 'NOT_FOUND', 'Encashment request not found.');

  // Ownership check
  if (enc.approverId !== approverId) {
    throw makeError(403, 'FORBIDDEN', 'You are not the assigned approver for this request.');
  }
  if (
    enc.status !== LeaveEncashmentStatus.Pending &&
    enc.status !== LeaveEncashmentStatus.ManagerApproved
  ) {
    throw makeError(409, 'VALIDATION_FAILED', `Cannot approve an encashment with this status.`);
  }

  // Find Admin for the next routing step
  const admin = await findDefaultAdmin(tx);

  const before = { status: enc.status, approverId: enc.approverId, version: enc.version };

  const updated = await tx.leaveEncashment.update({
    where: { id: requestId },
    data: {
      status: LeaveEncashmentStatus.ManagerApproved,
      decidedAt: new Date(),
      decidedBy: approverId,
      decisionNote: note ?? null,
      // Route to Admin for final step
      routedToId: RoutedTo.Admin,
      approverId: admin.id,
      version: { increment: 1 },
    },
    include: {
      employee: { select: { name: true, code: true } },
      approver: { select: { name: true } },
    },
  });

  await audit({
    tx,
    actorId: approverId,
    actorRole,
    actorIp,
    action: 'leave.encashment.approve',
    targetType: 'LeaveEncashment',
    targetId: requestId,
    module: 'leave',
    before,
    after: {
      status: LeaveEncashmentStatus.ManagerApproved,
      phase: 'manager',
      decidedBy: approverId,
      note: note ?? null,
    },
  });

  // Notify employee + all active Admins
  const activeAdmins = await tx.employee.findMany({
    where: { roleId: RoleId.Admin, status: EmployeeStatus.Active },
    select: { id: true },
  });

  await notify({
    tx,
    recipientIds: enc.employeeId,
    category: 'Leave',
    title: 'Your encashment request was approved by manager',
    body: `Your encashment request ${enc.code} for ${enc.year} has been approved by your manager and is now pending Admin finalisation.`,
    link: `/employee/leave-encashment/${enc.id}`,
  });

  if (activeAdmins.length > 0) {
    await notify({
      tx,
      recipientIds: activeAdmins.map((a) => a.id),
      category: 'Leave',
      title: `Encashment request ${enc.code} requires Admin finalisation`,
      body: `${enc.employee.name}'s leave encashment request for ${enc.year} has been approved by manager and is pending your finalisation.`,
      link: `/admin/leave-encashment-queue/${enc.id}`,
    });
  }

  return formatEncashment(updated);
}

// ── Admin finalise (BL-LE-02, BL-LE-06, BL-LE-07, BL-LE-08) ─────────────────

/**
 * Transition ManagerApproved → AdminFinalised.
 *
 * BL-LE-02: clamps daysApproved to floor(daysRemaining × maxPercent / 100).
 * BL-LE-06: deducts LeaveBalance.daysRemaining and increments daysEncashed.
 * BL-LE-07/08: locks ratePerDayPaise and amountPaise from current SalaryStructure.
 * BL-LE-13: refuses if employee is Exited.
 */
export async function adminFinaliseEncashment(
  requestId: number,
  adminId: number,
  daysApprovedInput: number | undefined,
  note: string | undefined,
  tx: Prisma.TransactionClient,
  actorRole: AuditActorRoleValue,
  actorIp: string | null = null,
): Promise<ReturnType<typeof formatEncashment>> {
  // Lock the row via SELECT FOR UPDATE (BL-LE-03 concurrent finalise guard)
  const rows = await tx.$queryRaw<Array<{ id: number }>>`
    SELECT id FROM leave_encashments WHERE id = ${requestId} FOR UPDATE
  `;
  if (!rows.length) throw makeError(404, 'NOT_FOUND', 'Encashment request not found.');

  const enc = await tx.leaveEncashment.findUnique({
    where: { id: requestId },
    include: {
      employee: { select: { name: true, code: true, status: true, roleId: true } },
    },
  });
  if (!enc) throw makeError(404, 'NOT_FOUND', 'Encashment request not found.');

  // Defence-in-depth: verify DB actor role
  const actor = await tx.employee.findUnique({
    where: { id: adminId },
    select: { id: true, roleId: true, status: true },
  });
  if (!actor || actor.roleId !== RoleId.Admin) {
    throw makeError(403, 'FORBIDDEN', 'Only Admin can finalise encashment requests.');
  }
  if (actor.status === EmployeeStatus.Exited) {
    throw makeError(403, 'FORBIDDEN', 'An exited admin cannot perform this action.');
  }

  // BL-LE-13: refuse if employee is Exited
  if (enc.employee.status === EmployeeStatus.Exited) {
    throw makeError(
      409,
      'VALIDATION_FAILED',
      'Employee has exited and cannot have an encashment finalised.',
      'BL-LE-13',
    );
  }

  // Two valid pre-finalise states:
  //   - ManagerApproved: normal two-step flow, manager already signed off.
  //   - Pending + routedToId=Admin: one-step flow used when the employee
  //     had no reporting manager (admins themselves, top-of-tree employees,
  //     or employees whose manager has exited). Without this branch the
  //     request would stay stuck in Pending — no manager exists to do the
  //     intermediate step, and the admin can't run /manager-approve either.
  const oneStepAdmin =
    enc.status === LeaveEncashmentStatus.Pending &&
    enc.routedToId === RoutedTo.Admin;
  if (
    enc.status !== LeaveEncashmentStatus.ManagerApproved &&
    !oneStepAdmin
  ) {
    throw makeError(409, 'VALIDATION_FAILED', `Cannot finalise encashment with this status.`);
  }

  // Get current balance using LeaveTypeId.Annual
  const annualLeaveTypeId = LeaveTypeId.Annual;
  const balance = await tx.leaveBalance.findUnique({
    where: {
      employeeId_leaveTypeId_year: {
        employeeId: enc.employeeId,
        leaveTypeId: annualLeaveTypeId,
        year: enc.year,
      },
    },
  });
  const daysRemaining = balance?.daysRemaining ?? 0;

  // BL-LE-02: clamp to floor(daysRemaining × maxPercent / 100)
  const cfg = await getEncashmentConfig(tx);
  const maxAllowed = Math.floor(daysRemaining * cfg.maxPercent / 100);

  let daysApproved: number;
  if (daysApprovedInput !== undefined) {
    daysApproved = Math.min(daysApprovedInput, maxAllowed);
  } else {
    daysApproved = Math.min(enc.daysRequested, maxAllowed);
  }

  if (daysApproved <= 0) {
    throw makeError(
      409,
      'ENCASHMENT_INSUFFICIENT_BALANCE',
      `Insufficient Annual leave balance for encashment. daysRemaining=${daysRemaining}, maxAllowed=${maxAllowed}.`,
      'BL-LE-02',
    );
  }

  // BL-LE-07: lock rate from current SalaryStructure
  const today = new Date();
  const salary = await tx.salaryStructure.findFirst({
    where: {
      employeeId: enc.employeeId,
      effectiveFrom: { lte: today },
    },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!salary) {
    throw makeError(
      409,
      'VALIDATION_FAILED',
      'No active salary structure found for this employee. Cannot compute encashment rate.',
    );
  }

  // Approximate rate using a standard 26 working days (refinement at payroll time)
  const APPROX_WORKING_DAYS = 26;
  const lockedRate = Math.floor((salary.basicPaise + (salary.daPaise ?? 0)) / APPROX_WORKING_DAYS);
  const lockedAmount = daysApproved * lockedRate;

  const before = {
    status: enc.status,
    daysApproved: enc.daysApproved,
    ratePerDayPaise: enc.ratePerDayPaise,
    amountPaise: enc.amountPaise,
    version: enc.version,
  };

  // BL-LE-06: deduct balance inside same transaction
  if (!balance) {
    // Create balance row at zero then update — handles edge case
    await tx.leaveBalance.upsert({
      where: { employeeId_leaveTypeId_year: { employeeId: enc.employeeId, leaveTypeId: annualLeaveTypeId, year: enc.year } },
      create: { employeeId: enc.employeeId, leaveTypeId: annualLeaveTypeId, year: enc.year, daysRemaining: 0, daysEncashed: daysApproved, version: 0 },
      update: {},
    });
  } else {
    await tx.leaveBalance.update({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: enc.employeeId,
          leaveTypeId: annualLeaveTypeId,
          year: enc.year,
        },
      },
      data: {
        daysRemaining: { decrement: daysApproved },
        daysEncashed: { increment: daysApproved },
        version: { increment: 1 },
      },
    });
  }

  const updated = await tx.leaveEncashment.update({
    where: { id: requestId },
    data: {
      status: LeaveEncashmentStatus.AdminFinalised,
      daysApproved,
      ratePerDayPaise: lockedRate,
      amountPaise: lockedAmount,
      decidedAt: new Date(),
      decidedBy: adminId,
      decisionNote: note ?? null,
      routedToId: RoutedTo.Admin,
      approverId: adminId,
      version: { increment: 1 },
    },
    include: {
      employee: { select: { name: true, code: true } },
      approver: { select: { name: true } },
    },
  });

  await audit({
    tx,
    actorId: adminId,
    actorRole,
    actorIp,
    action: 'leave.encashment.admin-finalise',
    targetType: 'LeaveEncashment',
    targetId: requestId,
    module: 'leave',
    before,
    after: {
      status: LeaveEncashmentStatus.AdminFinalised,
      phase: 'admin',
      daysApproved,
      ratePerDayPaise: lockedRate,
      amountPaise: lockedAmount,
      balanceDeducted: daysApproved,
      note: note ?? null,
      clampApplied: (daysApprovedInput !== undefined && daysApprovedInput > maxAllowed) ||
                    enc.daysRequested > maxAllowed,
    },
  });

  // Notify employee
  await notify({
    tx,
    recipientIds: enc.employeeId,
    category: 'Leave',
    title: 'Your leave encashment has been finalised',
    body: `Your encashment request ${enc.code} for ${enc.year} has been finalised. ${daysApproved} day(s) will be paid in the next payroll run.`,
    link: `/employee/leave-encashment/${enc.id}`,
  });

  // Notify all PayrollOfficers (BL-LE-14)
  const payrollOfficers = await tx.employee.findMany({
    where: { roleId: RoleId.PayrollOfficer, status: EmployeeStatus.Active },
    select: { id: true },
  });
  if (payrollOfficers.length > 0) {
    await notify({
      tx,
      recipientIds: payrollOfficers.map((p) => p.id),
      category: 'Payroll',
      title: `Encashment queued for payroll — ${enc.code}`,
      body: `${enc.employee.name}'s leave encashment (${daysApproved} day(s), ≈₹${Math.round(lockedAmount / 100)}) is queued for the next payroll run.`,
      link: `/payroll/leave-encashment/${enc.id}`,
    });
  }

  return formatEncashment(updated);
}

// ── Reject (BL-LE-05) ────────────────────────────────────────────────────────

/**
 * Reject an encashment request.
 * Manager OR Admin path. No balance change.
 */
export async function rejectEncashment(
  requestId: number,
  actorId: number,
  note: string,
  tx: Prisma.TransactionClient,
  actorRole: AuditActorRoleValue,
  actorIp: string | null = null,
): Promise<ReturnType<typeof formatEncashment>> {
  const enc = await tx.leaveEncashment.findUnique({
    where: { id: requestId },
    include: {
      employee: { select: { name: true, code: true } },
      approver: { select: { name: true } },
    },
  });
  if (!enc) throw makeError(404, 'NOT_FOUND', 'Encashment request not found.');

  const rejectableStatuses = [
    LeaveEncashmentStatus.Pending,
    LeaveEncashmentStatus.ManagerApproved,
  ];
  if (!(rejectableStatuses as number[]).includes(enc.status)) {
    throw makeError(409, 'VALIDATION_FAILED', `Cannot reject encashment with this status.`);
  }

  // Access: only the assigned approver OR any Admin
  if (actorRole !== RoleId.Admin && enc.approverId !== actorId) {
    throw makeError(403, 'FORBIDDEN', 'You are not authorised to reject this request.');
  }

  const before = { status: enc.status, version: enc.version };

  const updated = await tx.leaveEncashment.update({
    where: { id: requestId },
    data: {
      status: LeaveEncashmentStatus.Rejected,
      decidedAt: new Date(),
      decidedBy: actorId,
      decisionNote: note,
      version: { increment: 1 },
    },
    include: {
      employee: { select: { name: true, code: true } },
      approver: { select: { name: true } },
    },
  });

  await audit({
    tx,
    actorId,
    actorRole,
    actorIp,
    action: 'leave.encashment.reject',
    targetType: 'LeaveEncashment',
    targetId: requestId,
    module: 'leave',
    before,
    after: { status: LeaveEncashmentStatus.Rejected, note },
  });

  await notify({
    tx,
    recipientIds: enc.employeeId,
    category: 'Leave',
    title: 'Your leave encashment request was rejected',
    body: `Your encashment request ${enc.code} for ${enc.year} was rejected${note ? ` — ${note}` : ''}.`,
    link: `/employee/leave-encashment/${enc.id}`,
  });

  return formatEncashment(updated);
}

// ── Cancel ───────────────────────────────────────────────────────────────────

/**
 * Cancel an encashment request.
 *
 * Employee-self: only before ManagerApproved.
 * Admin: any time before Paid.
 * No balance change (balance was not yet deducted — deduction only at AdminFinalised).
 */
export async function cancelEncashment(
  requestId: number,
  actorId: number,
  actorRole: AuditActorRoleValue,
  tx: Prisma.TransactionClient,
  actorIp: string | null = null,
  note?: string,
): Promise<ReturnType<typeof formatEncashment>> {
  const enc = await tx.leaveEncashment.findUnique({
    where: { id: requestId },
    include: {
      employee: { select: { name: true, code: true } },
      approver: { select: { name: true } },
    },
  });
  if (!enc) throw makeError(404, 'NOT_FOUND', 'Encashment request not found.');

  const isAdmin = actorRole === RoleId.Admin;
  const isOwner = enc.employeeId === actorId;

  if (enc.status === LeaveEncashmentStatus.Paid) {
    throw makeError(409, 'VALIDATION_FAILED', 'Cannot cancel a Paid encashment. Use payslip reversal.');
  }

  // AdminFinalised can only be cancelled by Admin
  if (enc.status === LeaveEncashmentStatus.AdminFinalised && !isAdmin) {
    throw makeError(403, 'FORBIDDEN', 'Only Admin can cancel a finalised encashment.');
  }

  // Employee-self can only cancel Pending (before ManagerApproved)
  if (!isAdmin && isOwner && enc.status !== LeaveEncashmentStatus.Pending) {
    throw makeError(403, 'FORBIDDEN', 'You can only cancel your own encashment request while it is Pending.');
  }

  if (!isAdmin && !isOwner) {
    throw makeError(403, 'FORBIDDEN', 'You are not authorised to cancel this request.');
  }

  // If AdminFinalised, we need to RESTORE the balance (since deduction happened at AdminFinalised)
  if (enc.status === LeaveEncashmentStatus.AdminFinalised && enc.daysApproved) {
    const annualLeaveTypeId = LeaveTypeId.Annual;
    await tx.leaveBalance.update({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: enc.employeeId,
          leaveTypeId: annualLeaveTypeId,
          year: enc.year,
        },
      },
      data: {
        daysRemaining: { increment: enc.daysApproved },
        daysEncashed: { decrement: enc.daysApproved },
        version: { increment: 1 },
      },
    });
  }

  const before = { status: enc.status, version: enc.version };

  const updated = await tx.leaveEncashment.update({
    where: { id: requestId },
    data: {
      status: LeaveEncashmentStatus.Cancelled,
      cancelledAt: new Date(),
      cancelledBy: actorId,
      decisionNote: note ?? enc.decisionNote,
      version: { increment: 1 },
    },
    include: {
      employee: { select: { name: true, code: true } },
      approver: { select: { name: true } },
    },
  });

  await audit({
    tx,
    actorId,
    actorRole,
    actorIp,
    action: 'leave.encashment.cancel',
    targetType: 'LeaveEncashment',
    targetId: requestId,
    module: 'leave',
    before,
    after: {
      status: LeaveEncashmentStatus.Cancelled,
      cancelledBy: actorId,
      balanceRestored: enc.status === LeaveEncashmentStatus.AdminFinalised ? (enc.daysApproved ?? 0) : 0,
    },
  });

  await notify({
    tx,
    recipientIds: enc.employeeId,
    category: 'Leave',
    title: 'Your leave encashment request was cancelled',
    body: `Your encashment request ${enc.code} for ${enc.year} has been cancelled.`,
    link: `/employee/leave-encashment/${enc.id}`,
  });

  return formatEncashment(updated);
}

// ── Payroll engine helpers ────────────────────────────────────────────────────

/**
 * Find an AdminFinalised (not yet Paid) encashment for the given employee/year.
 * Used by the payroll engine (BL-LE-09).
 * Note: In v2 schema, "paid" is tracked via Payslip.encashmentId (FK on Payslip side).
 * We filter by status=AdminFinalised.
 */
export async function findUnpaidAdminFinalisedForEmployee(
  employeeId: number,
  year: number,
  tx: Prisma.TransactionClient,
) {
  return tx.leaveEncashment.findFirst({
    where: {
      employeeId,
      year,
      status: LeaveEncashmentStatus.AdminFinalised,
    },
  });
}

/**
 * Mark an encashment as Paid.
 * Called by the payroll engine inside the run transaction (BL-LE-09).
 *
 * Also updates ratePerDayPaise and amountPaise to reflect the actual
 * paying-month values (BL-LE-07: paying month wins over locked snapshot).
 * Note: In v2 schema, the Payslip.encashmentId FK tracks the association.
 */
export async function markEncashmentPaid(
  encashmentId: number,
  payslipId: number,
  actualRatePerDay: number,
  actualAmount: number,
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.leaveEncashment.update({
    where: { id: encashmentId },
    data: {
      status: LeaveEncashmentStatus.Paid,
      paidAt: new Date(),
      // BL-LE-07: update with actual paying-month rate so audit trail is accurate
      ratePerDayPaise: actualRatePerDay,
      amountPaise: actualAmount,
      version: { increment: 1 },
    },
  });

  await audit({
    tx,
    actorId: null,
    actorRole: 'system',
    actorIp: null,
    action: 'leave.encashment.payment.paid',
    targetType: 'LeaveEncashment',
    targetId: encashmentId,
    module: 'payroll',
    before: { status: LeaveEncashmentStatus.AdminFinalised },
    after: {
      status: LeaveEncashmentStatus.Paid,
      paidInPayslipId: payslipId,
      actualRatePerDay,
      actualAmount,
    },
  });
}

/**
 * Record that a payslip carrying this encashment was reversed (BL-LE-11).
 * Does NOT restore leave balance.
 * Called by the reversal handler.
 */
export async function markEncashmentReversed(
  encashmentId: number,
  reversalPayslipId: number,
  tx: Prisma.TransactionClient,
): Promise<void> {
  // We do NOT change status back from Paid — the encashment stays Paid.
  // The reversal is tracked via audit only (BL-LE-11).
  await audit({
    tx,
    actorId: null,
    actorRole: 'system',
    actorIp: null,
    action: 'leave.encashment.payment.reverse',
    targetType: 'LeaveEncashment',
    targetId: encashmentId,
    module: 'payroll',
    before: { status: LeaveEncashmentStatus.Paid },
    after: {
      reversalPayslipId,
      note: 'Payment reversed via payslip reversal. Leave balance NOT restored (BL-LE-11).',
    },
  });
}

// ── Escalation sweep for encashments (mirrors leave.service.ts) ───────────────

/**
 * Escalate stale Pending encashments where:
 *   - routedToId = Manager AND createdAt + 5 working days < now()
 *   - OR the approver is Exited
 * Re-routes to Admin. Returns the count escalated.
 */
export async function escalateStaleEncashments(
  tx: Prisma.TransactionClient,
): Promise<number> {
  const now = new Date();

  // Import addWorkingDays from workingDays.ts
  const { addWorkingDays } = await import('./workingDays.js');

  const pending = await tx.leaveEncashment.findMany({
    where: { status: LeaveEncashmentStatus.Pending, routedToId: RoutedTo.Manager },
    include: { approver: { select: { id: true, status: true } } },
  });

  const admin = await findDefaultAdmin(tx);
  let count = 0;

  for (const enc of pending) {
    const slaDeadline = addWorkingDays(enc.createdAt, 5);
    const slaBreach = now > slaDeadline;
    const approverExited = enc.approver?.status === EmployeeStatus.Exited;

    if (!slaBreach && !approverExited) continue;

    await tx.leaveEncashment.update({
      where: { id: enc.id },
      data: {
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
      action: 'leave.encashment.escalate',
      targetType: 'LeaveEncashment',
      targetId: enc.id,
      module: 'leave',
      before: { routedToId: enc.routedToId, approverId: enc.approverId, escalatedAt: null },
      after: {
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
    await notify({
      tx,
      recipientIds: [...activeAdmins.map((a) => a.id), enc.employeeId],
      category: 'Leave',
      title: 'Encashment request escalated to Admin',
      body: `Encashment request ${enc.code} has been escalated to Admin (SLA breach or approver exited).`,
      link: `/admin/leave-encashment-queue/${enc.id}`,
    });

    logger.info({ encashmentId: enc.id, code: enc.code }, 'leave-encashment.escalate');
    count++;
  }

  return count;
}

// ── Format helper ─────────────────────────────────────────────────────────────

export function formatEncashment(enc: {
  id: number;
  code: string;
  employeeId: number;
  employee: { name: string; code: string };
  year: number;
  daysRequested: number;
  daysApproved: number | null;
  ratePerDayPaise: number | null;
  amountPaise: number | null;
  status: number;
  routedToId: number;
  approverId: number | null;
  approver?: { name: string } | null;
  decidedAt: Date | null;
  decidedBy: number | null;
  decisionNote: string | null;
  escalatedAt: Date | null;
  paidAt: Date | null;
  cancelledAt: Date | null;
  cancelledBy: number | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}) {
  return {
    id: enc.id,
    code: enc.code,
    employeeId: enc.employeeId,
    employeeName: enc.employee.name,
    employeeCode: enc.employee.code,
    year: enc.year,
    daysRequested: enc.daysRequested,
    daysApproved: enc.daysApproved,
    ratePerDayPaise: enc.ratePerDayPaise,
    amountPaise: enc.amountPaise,
    status: enc.status,
    routedToId: enc.routedToId,
    approverId: enc.approverId,
    approverName: enc.approver?.name ?? null,
    decidedAt: enc.decidedAt?.toISOString() ?? null,
    decidedBy: enc.decidedBy,
    decisionNote: enc.decisionNote,
    escalatedAt: enc.escalatedAt?.toISOString() ?? null,
    paidAt: enc.paidAt?.toISOString() ?? null,
    cancelledAt: enc.cancelledAt?.toISOString() ?? null,
    cancelledBy: enc.cancelledBy,
    createdAt: enc.createdAt.toISOString(),
    updatedAt: enc.updatedAt.toISOString(),
    version: enc.version,
  };
}

// ── Error factory ────────────────────────────────────────────────────────────

function makeError(
  statusCode: number,
  code: string,
  message: string,
  ruleId?: string,
  details?: Record<string, unknown>,
): Error & { statusCode: number; code: string; ruleId?: string; details?: Record<string, unknown> } {
  const e = new Error(message) as Error & {
    statusCode: number;
    code: string;
    ruleId?: string;
    details?: Record<string, unknown>;
  };
  e.statusCode = statusCode;
  e.code = code;
  if (ruleId) e.ruleId = ruleId;
  if (details) e.details = details;
  return e;
}
