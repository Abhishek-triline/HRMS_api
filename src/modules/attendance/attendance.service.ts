/**
 * Attendance service — v2 (INT codes throughout).
 *
 * Pure business-logic functions. All state-mutating functions accept a
 * Prisma.TransactionClient so they compose with the caller's transaction.
 *
 * Rules enforced here:
 *   BL-023  Midnight auto-generate (runMidnightGenerate)
 *   BL-024  Check-out mandatory after check-in
 *   BL-025  hoursWorkedMinutes = (checkOut − checkIn) in minutes
 *   BL-026  Status priority: OnLeave > WeeklyOff/Holiday > Present > Absent
 *   BL-027  Late mark = checkIn after configured LATE_THRESHOLD
 *   BL-028  3 late marks/month → 1 day deducted from Annual leave balance
 *   BL-029  Regularisation routing: ≤7d → Manager; >7d → Admin
 *   BL-010  Leave/reg conflict → LEAVE_REG_CONFLICT (409)
 *   BL-007  AttendanceRecord rows are NEVER deleted; corrections append
 *
 * v2 changes:
 *   - All IDs are INT.
 *   - status, sourceId, routedToId, reasonId are INT codes from statusInt.ts.
 *   - DB unique key: employeeId_date_sourceId (not employeeId_date_source).
 *   - No string enums in Prisma queries.
 */

import type { Prisma } from '@prisma/client';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notifications.js';
import { logger } from '../../lib/logger.js';
import { getAttendanceConfig } from '../../lib/config.js';
import { isHoliday, isWeeklyOff } from './holidays.js';
import {
  findOverlappingLeave,
  currentBalanceRow,
  findDefaultAdmin,
} from '../leave/leave.service.js';
import { generateRegCode } from './regCode.js';
import { ErrorCode } from '@nexora/contracts/errors';
import {
  AttendanceStatus,
  AttendanceSource,
  RegStatus,
  RoutedTo,
  EmployeeStatus,
  LeaveTypeId,
  LedgerReason,
  type AuditActorRoleValue,
} from '../../lib/statusInt.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * SEC-002-P3 — actor context threaded into service helpers so audit rows
 * carry the real `actorIp` and `actorRoleId` instead of hardcoded defaults.
 */
export interface AuditCtx {
  roleId?: number;
  ip?: string | null;
}

/**
 * SEC-003-P3 — conflict details now match `LeaveConflictDetailsSchema` from
 * `@nexora/contracts/leave`.
 */
export interface RegularisationConflictError {
  code: typeof ErrorCode.LEAVE_REG_CONFLICT;
  details: {
    conflictType: 'Leave';
    conflictId: number;
    conflictCode: string;
    conflictFrom: string;
    conflictTo: string | null;
    conflictStatus: number;
  };
}

/**
 * Parse "HH:MM" into { hours, minutes }.
 */
function parseHHMM(hhmm: string): { hours: number; minutes: number } {
  const [h, m] = hhmm.split(':').map(Number);
  return { hours: h ?? 10, minutes: m ?? 30 };
}

/**
 * Returns true if the given DateTime is after the late threshold on its day.
 * Threshold is compared as local Asia/Kolkata time hour:minute.
 */
function isLate(checkIn: Date, threshold: string): boolean {
  const { hours: thH, minutes: thM } = parseHHMM(threshold);
  // Convert UTC to IST (+5:30)
  const istOffset = 5 * 60 + 30; // minutes
  const istMs = checkIn.getTime() + istOffset * 60 * 1000;
  const istDate = new Date(istMs);
  const istHours = istDate.getUTCHours();
  const istMinutes = istDate.getUTCMinutes();
  // Late if check-in time is strictly after the threshold
  return istHours * 60 + istMinutes > thH * 60 + thM;
}

// ── Status derivation (BL-026) ────────────────────────────────────────────────

/**
 * Derive the attendance status for an employee on a given date, applying
 * BL-026 priority:
 *   1. Approved leave covering the date → OnLeave (3)
 *   2. Public holiday → Holiday (5)
 *   3. Weekly off → WeeklyOff (4)
 *   4. Otherwise → null (caller decides Present vs Absent based on check-in)
 *
 * Returns INT status code or null.
 */
export async function deriveStatusForDay(
  employeeId: number,
  date: Date,
  tx: Prisma.TransactionClient,
): Promise<number | null> {
  // 1. Approved leave covering this date
  const dayStart = new Date(date);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCHours(23, 59, 59, 999);

  const approvedLeave = await tx.leaveRequest.findFirst({
    where: {
      employeeId,
      status: AttendanceStatus.OnLeave, // This uses leave request status=Approved=2 actually
      fromDate: { lte: dayEnd },
      toDate: { gte: dayStart },
    },
    select: { id: true },
  });

  // Use leave status Approved=2 not attendance OnLeave=3
  const leaveApproved = await tx.leaveRequest.findFirst({
    where: {
      employeeId,
      status: 2, // LeaveStatus.Approved
      fromDate: { lte: dayEnd },
      toDate: { gte: dayStart },
    },
    select: { id: true },
  });

  if (leaveApproved) return AttendanceStatus.OnLeave;

  // 2. Public holiday
  const holiday = await isHoliday(date, tx);
  if (holiday) return AttendanceStatus.Holiday;

  // 3. Weekly off
  if (await isWeeklyOff(date)) return AttendanceStatus.WeeklyOff;

  return null;
}

// ── Midnight generate (BL-023) ────────────────────────────────────────────────

/**
 * For each Active or OnNotice employee, upsert one AttendanceRecord row with
 * sourceId=system for the given date. Default status is Absent, overridden by
 * BL-026 priority.
 *
 * Idempotent: skips employees who already have a system row for that date.
 */
export async function runMidnightGenerate(
  date: Date,
  tx: Prisma.TransactionClient,
): Promise<{ employeesProcessed: number }> {
  const dateOnly = new Date(date);
  dateOnly.setUTCHours(0, 0, 0, 0);

  // All Active + OnNotice employees
  const employees = await tx.employee.findMany({
    where: { status: { in: [EmployeeStatus.Active, EmployeeStatus.OnNotice] } },
    select: { id: true },
  });

  let employeesProcessed = 0;

  for (const emp of employees) {
    // Idempotency guard: skip if a system row already exists for this date
    const existing = await tx.attendanceRecord.findUnique({
      where: {
        employeeId_date_sourceId: {
          employeeId: emp.id,
          date: dateOnly,
          sourceId: AttendanceSource.system,
        },
      },
      select: { id: true },
    });

    if (existing) continue;

    // Derive status per BL-026
    const derivedStatus = await deriveStatusForDay(emp.id, dateOnly, tx);
    const status = derivedStatus ?? AttendanceStatus.Absent;

    await tx.attendanceRecord.create({
      data: {
        employeeId: emp.id,
        date: dateOnly,
        status,
        checkInTime: null,
        checkOutTime: null,
        hoursWorkedMinutes: null,
        late: false,
        lateMonthCount: 0,
        lopApplied: false,
        sourceId: AttendanceSource.system,
        regularisationId: null,
        version: 0,
      },
    });

    employeesProcessed++;
  }

  // Single audit entry for the batch run (BL-047 / BL-048)
  await audit({
    tx,
    actorId: null,
    actorRole: 'system',
    actorIp: null,
    action: 'attendance.midnight-generate.run',
    targetType: 'AttendanceRecord',
    targetId: null,
    module: 'attendance',
    before: null,
    after: {
      date: dateOnly.toISOString().split('T')[0],
      employeesProcessed,
    },
  });

  logger.info(
    { date: dateOnly.toISOString().split('T')[0], employeesProcessed },
    'attendance.midnight-generate: completed',
  );

  return { employeesProcessed };
}

// ── Shared record type ────────────────────────────────────────────────────────

/** Shape of a raw AttendanceRecord row returned from Prisma (v2 INT fields). */
export interface RawAttendanceRecord {
  id: number;
  employeeId: number;
  date: Date;
  status: number;
  checkInTime: Date | null;
  checkOutTime: Date | null;
  hoursWorkedMinutes: number | null;
  late: boolean;
  lateMonthCount: number;
  lopApplied: boolean;
  sourceId: number;
  regularisationId: number | null;
  createdAt: Date;
  version: number;
}

// ── Check-in (BL-024 / BL-025 / BL-027 / BL-028) ─────────────────────────────

export interface CheckInResult {
  record: RawAttendanceRecord;
  lateMarkDeductionApplied: boolean;
  lateMonthCount: number;
}

/**
 * Record a check-in for today. Idempotent — a second call on the same day
 * returns the existing record (lateMarkDeductionApplied will be false on repeat).
 */
export async function recordCheckIn(
  employeeId: number,
  now: Date,
  tx: Prisma.TransactionClient,
  auditCtx: AuditCtx = {},
): Promise<CheckInResult> {
  const dateOnly = new Date(now);
  dateOnly.setUTCHours(0, 0, 0, 0);

  // Check for existing system row today (idempotency)
  const existing = await tx.attendanceRecord.findUnique({
    where: {
      employeeId_date_sourceId: {
        employeeId,
        date: dateOnly,
        sourceId: AttendanceSource.system,
      },
    },
  });

  // If already checked in, return idempotent response
  if (existing?.checkInTime) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const lateLedger = await tx.attendanceLateLedger.findUnique({
      where: { employeeId_year_month: { employeeId, year, month } },
    });
    return {
      record: existing as RawAttendanceRecord,
      lateMarkDeductionApplied: false,
      lateMonthCount: lateLedger?.count ?? 0,
    };
  }

  // Read the late threshold from the shared config cache (30 s TTL, BL-027).
  const { lateThresholdTime } = await getAttendanceConfig();
  const late = isLate(now, lateThresholdTime);

  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  let lateMonthCount = 0;
  let lateMarkDeductionApplied = false;

  if (late) {
    const lateLedger = await tx.attendanceLateLedger.upsert({
      where: { employeeId_year_month: { employeeId, year, month } },
      create: { employeeId, year, month, count: 1 },
      update: { count: { increment: 1 } },
    });
    lateMonthCount = lateLedger.count;

    // BL-028: fire on 3rd late mark and each subsequent
    if (lateMonthCount >= 3) {
      lateMarkDeductionApplied = await deductLateMarkPenalty(employeeId, year, now, tx);
    } else if (lateMonthCount === 2) {
      await notify({
        tx,
        recipientIds: employeeId,
        category: 'Attendance',
        title: 'Late check-in warning',
        body: 'You have 2 late check-ins this month. One more late will deduct 1 day from your leave balance.',
        link: `/employee/attendance`,
      });
    }
  } else {
    const lateLedger = await tx.attendanceLateLedger.findUnique({
      where: { employeeId_year_month: { employeeId, year, month } },
    });
    lateMonthCount = lateLedger?.count ?? 0;
  }

  // BL-026 status priority
  const priorityStatus = await deriveStatusForDay(employeeId, dateOnly, tx);
  const newStatus = priorityStatus ?? AttendanceStatus.Present;

  const record = await tx.attendanceRecord.upsert({
    where: {
      employeeId_date_sourceId: {
        employeeId,
        date: dateOnly,
        sourceId: AttendanceSource.system,
      },
    },
    create: {
      employeeId,
      date: dateOnly,
      status: newStatus,
      checkInTime: now,
      checkOutTime: null,
      hoursWorkedMinutes: null,
      late,
      lateMonthCount,
      lopApplied: false,
      sourceId: AttendanceSource.system,
      version: 0,
    },
    update: {
      status: newStatus,
      checkInTime: now,
      late,
      lateMonthCount,
      version: { increment: 1 },
    },
  });

  // Audit check-in
  await audit({
    tx,
    actorId: employeeId,
    actorRole: (auditCtx.roleId ?? 1) as AuditActorRoleValue,
    actorIp: auditCtx.ip ?? null,
    action: 'attendance.check-in',
    targetType: 'AttendanceRecord',
    targetId: record.id,
    module: 'attendance',
    before: null,
    after: {
      date: dateOnly.toISOString().split('T')[0],
      checkInTime: now.toISOString(),
      late,
      lateMonthCount,
      lateMarkDeductionApplied,
    },
  });

  return { record: record as RawAttendanceRecord, lateMarkDeductionApplied, lateMonthCount };
}

/**
 * Deduct 1 day from the employee's Annual leave balance as a late-mark penalty.
 * BL-028: fires on the 3rd+ late mark in a calendar month.
 */
async function deductLateMarkPenalty(
  employeeId: number,
  year: number,
  now: Date,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const balanceRow = await currentBalanceRow(employeeId, LeaveTypeId.Annual, year, tx);

  if (balanceRow.daysRemaining <= 0) {
    logger.warn(
      { employeeId, year },
      'BL-028: late-mark penalty skipped — Annual leave balance is already 0',
    );
    return false;
  }

  // Deduct 1 day
  await tx.leaveBalance.update({
    where: {
      employeeId_leaveTypeId_year: {
        employeeId,
        leaveTypeId: LeaveTypeId.Annual,
        year,
      },
    },
    data: {
      daysRemaining: { decrement: 1 },
      daysUsed: { increment: 1 },
      version: { increment: 1 },
    },
  });

  // Ledger entry for the late-mark penalty deduction
  await tx.leaveBalanceLedger.create({
    data: {
      employeeId,
      leaveTypeId: LeaveTypeId.Annual,
      year,
      delta: -1,
      reasonId: LedgerReason.LateMarkPenalty,
      relatedRequestId: null,
      createdBy: null,
    },
  });

  // Audit the deduction
  await audit({
    tx,
    actorId: null,
    actorRole: 'system',
    actorIp: null,
    action: 'attendance.late-mark.deducted',
    targetType: 'AttendanceRecord',
    targetId: null,
    module: 'attendance',
    before: { daysRemaining: balanceRow.daysRemaining },
    after: {
      daysRemaining: balanceRow.daysRemaining - 1,
      reason: 'BL-028 late-mark penalty',
      date: now.toISOString(),
    },
  });

  // Notify the employee
  await notify({
    tx,
    recipientIds: employeeId,
    category: 'Attendance',
    title: 'Late-mark deduction applied',
    body: '1 day has been deducted from your Annual leave balance due to repeated late check-ins this month (BL-028).',
    link: '/employee/attendance',
  });

  return true;
}

// ── Check-out (BL-025) ────────────────────────────────────────────────────────

export interface CheckOutResult {
  record: RawAttendanceRecord;
  hoursWorkedMinutes: number;
}

/**
 * Record a check-out for today. Returns null if no check-in exists (caller returns 400).
 */
export async function recordCheckOut(
  employeeId: number,
  now: Date,
  tx: Prisma.TransactionClient,
  auditCtx: AuditCtx = {},
): Promise<CheckOutResult | null> {
  const dateOnly = new Date(now);
  dateOnly.setUTCHours(0, 0, 0, 0);

  const existing = await tx.attendanceRecord.findUnique({
    where: {
      employeeId_date_sourceId: {
        employeeId,
        date: dateOnly,
        sourceId: AttendanceSource.system,
      },
    },
  });

  // No check-in for today
  if (!existing || !existing.checkInTime) {
    return null;
  }

  // Idempotent: already checked out
  if (existing.checkOutTime) {
    const hoursWorkedMinutes = existing.hoursWorkedMinutes ?? 0;
    return { record: existing as RawAttendanceRecord, hoursWorkedMinutes };
  }

  const checkInTime = existing.checkInTime;
  const hoursWorkedMinutes = Math.max(
    0,
    Math.round((now.getTime() - checkInTime.getTime()) / 60000),
  );

  const record = await tx.attendanceRecord.update({
    where: { id: existing.id },
    data: {
      checkOutTime: now,
      hoursWorkedMinutes,
      version: { increment: 1 },
    },
  });

  // Audit check-out
  await audit({
    tx,
    actorId: employeeId,
    actorRole: (auditCtx.roleId ?? 1) as AuditActorRoleValue,
    actorIp: auditCtx.ip ?? null,
    action: 'attendance.check-out',
    targetType: 'AttendanceRecord',
    targetId: record.id,
    module: 'attendance',
    before: { checkOutTime: null },
    after: {
      checkOutTime: now.toISOString(),
      hoursWorkedMinutes,
    },
  });

  return { record: record as RawAttendanceRecord, hoursWorkedMinutes };
}

// ── Undo check-out ────────────────────────────────────────────────────────────

export async function undoCheckOutForEmployee(
  employeeId: number,
  now: Date,
  tx: Prisma.TransactionClient,
  auditCtx: AuditCtx = {},
): Promise<CheckInResult> {
  const dateOnly = new Date(now);
  dateOnly.setUTCHours(0, 0, 0, 0);

  const existing = await tx.attendanceRecord.findUnique({
    where: {
      employeeId_date_sourceId: {
        employeeId,
        date: dateOnly,
        sourceId: AttendanceSource.system,
      },
    },
  });

  if (!existing || !existing.checkInTime) {
    const err = Object.assign(new Error('No check-in to undo'), {
      httpStatus: 409,
      code: 'NOT_CHECKED_IN',
    });
    throw err;
  }

  if (!existing.checkOutTime) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const lateLedger = await tx.attendanceLateLedger.findUnique({
      where: { employeeId_year_month: { employeeId, year, month } },
    });
    return {
      record: existing as RawAttendanceRecord,
      lateMarkDeductionApplied: false,
      lateMonthCount: lateLedger?.count ?? 0,
    };
  }

  const recordDateMs = existing.date.getTime();
  const todayMs = dateOnly.getTime();
  if (recordDateMs !== todayMs) {
    const err = Object.assign(new Error('Cannot undo check-out from a previous day.'), {
      httpStatus: 409,
      code: 'UNDO_OUTSIDE_DAY',
    });
    throw err;
  }

  const minutesSinceCheckOut = (now.getTime() - existing.checkOutTime.getTime()) / 60_000;
  if (minutesSinceCheckOut > 5) {
    const err = Object.assign(
      new Error('Undo window expired — contact your manager for a regularisation.'),
      { httpStatus: 409, code: 'UNDO_WINDOW_EXPIRED' },
    );
    throw err;
  }

  const prevCheckOutTime = existing.checkOutTime;
  const prevHoursWorkedMinutes = existing.hoursWorkedMinutes;

  const record = await tx.attendanceRecord.update({
    where: { id: existing.id },
    data: {
      checkOutTime: null,
      hoursWorkedMinutes: null,
      version: { increment: 1 },
    },
  });

  await audit({
    tx,
    actorId: employeeId,
    actorRole: (auditCtx.roleId ?? 1) as AuditActorRoleValue,
    actorIp: auditCtx.ip ?? null,
    action: 'attendance.check-out.undo',
    targetType: 'AttendanceRecord',
    targetId: record.id,
    module: 'attendance',
    before: {
      checkOutTime: prevCheckOutTime.toISOString(),
      hoursWorkedMinutes: prevHoursWorkedMinutes,
    },
    after: {
      checkOutTime: null,
      hoursWorkedMinutes: null,
    },
  });

  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const lateLedger = await tx.attendanceLateLedger.findUnique({
    where: { employeeId_year_month: { employeeId, year, month } },
  });

  return {
    record: record as RawAttendanceRecord,
    lateMarkDeductionApplied: false,
    lateMonthCount: lateLedger?.count ?? 0,
  };
}

// ── Today's open attendance ────────────────────────────────────────────────────

export async function findOpenAttendance(
  employeeId: number,
  today: Date,
  tx: Prisma.TransactionClient,
) {
  const dateOnly = new Date(today);
  dateOnly.setUTCHours(0, 0, 0, 0);

  return tx.attendanceRecord.findUnique({
    where: {
      employeeId_date_sourceId: {
        employeeId,
        date: dateOnly,
        sourceId: AttendanceSource.system,
      },
    },
  });
}

// ── Submit regularisation (BL-010 / BL-029) ───────────────────────────────────

export interface SubmitRegularisationInput {
  date: Date;
  proposedCheckIn: Date | null;
  proposedCheckOut: Date | null;
  reason: string;
}

export async function submitRegularisation(
  employeeId: number,
  input: SubmitRegularisationInput,
  tx: Prisma.TransactionClient,
  auditCtx: AuditCtx = {},
) {
  const { date, proposedCheckIn, proposedCheckOut, reason } = input;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const dateOnly = new Date(date);
  dateOnly.setUTCHours(0, 0, 0, 0);

  // BL-010: check for approved leave on that date.
  const conflictingLeave = await findOverlappingLeave(employeeId, dateOnly, dateOnly, tx);
  if (conflictingLeave) {
    const err: RegularisationConflictError = {
      code: ErrorCode.LEAVE_REG_CONFLICT,
      details: {
        conflictType: 'Leave',
        conflictId: conflictingLeave.id,
        conflictCode: conflictingLeave.code,
        conflictFrom: conflictingLeave.fromDate.toISOString().split('T')[0]!,
        conflictTo: conflictingLeave.toDate.toISOString().split('T')[0]!,
        conflictStatus: conflictingLeave.status,
      },
    };
    throw err;
  }

  const msPerDay = 1000 * 60 * 60 * 24;
  const ageDaysAtSubmit = Math.round((today.getTime() - dateOnly.getTime()) / msPerDay);

  // BL-029 routing
  let routedToId: number = RoutedTo.Admin;
  let approverId: number | null = null;

  if (ageDaysAtSubmit <= 7) {
    const emp = await tx.employee.findUnique({
      where: { id: employeeId },
      select: { reportingManagerId: true },
    });

    if (emp?.reportingManagerId) {
      const manager = await tx.employee.findUnique({
        where: { id: emp.reportingManagerId },
        select: { id: true, status: true },
      });

      if (manager && manager.status !== EmployeeStatus.Exited) {
        routedToId = RoutedTo.Manager;
        approverId = manager.id;
      }
    }
  }

  if (routedToId === RoutedTo.Admin || !approverId) {
    const admin = await findDefaultAdmin(tx);
    routedToId = RoutedTo.Admin;
    approverId = admin.id;
  }

  const year = today.getUTCFullYear();
  const code = await generateRegCode(year, tx);

  const reg = await tx.regularisationRequest.create({
    data: {
      code,
      employeeId,
      date: dateOnly,
      proposedCheckIn,
      proposedCheckOut,
      reason,
      status: RegStatus.Pending,
      routedToId,
      ageDaysAtSubmit,
      approverId,
      correctedRecordId: null,
      version: 0,
    },
    include: {
      employee: { select: { name: true, code: true } },
      approver: { select: { name: true } },
    },
  });

  await audit({
    tx,
    actorId: employeeId,
    actorRole: (auditCtx.roleId ?? 1) as AuditActorRoleValue,
    actorIp: auditCtx.ip ?? null,
    action: 'regularisation.create',
    targetType: 'RegularisationRequest',
    targetId: reg.id,
    module: 'attendance',
    before: null,
    after: {
      code,
      date: dateOnly.toISOString().split('T')[0],
      routedToId,
      approverId,
      ageDaysAtSubmit,
    },
  });

  if (approverId) {
    await notify({
      tx,
      recipientIds: approverId,
      category: 'Attendance',
      title: `Regularisation request from ${reg.employee.name}`,
      body: `Regularisation request ${code} for ${dateOnly.toISOString().split('T')[0]} is pending your approval.`,
      link: `/${routedToId === RoutedTo.Manager ? 'manager' : 'admin'}/regularisations/${reg.id}`,
    });
  }

  return reg;
}

// ── Approve regularisation ─────────────────────────────────────────────────────

export async function approveRegularisation(
  reg: {
    id: number;
    employeeId: number;
    date: Date;
    proposedCheckIn: Date | null;
    proposedCheckOut: Date | null;
    version: number;
    approverId: number | null;
  },
  approverId: number,
  note: string | undefined,
  tx: Prisma.TransactionClient,
  auditCtx: AuditCtx = {},
) {
  const dateOnly = new Date(reg.date);
  dateOnly.setUTCHours(0, 0, 0, 0);

  const derivedStatus = await deriveStatusForDay(reg.employeeId, dateOnly, tx);
  const status = derivedStatus ?? (reg.proposedCheckIn ? AttendanceStatus.Present : AttendanceStatus.Absent);

  let hoursWorkedMinutes: number | null = null;
  let late = false;

  if (reg.proposedCheckIn) {
    const { lateThresholdTime } = await getAttendanceConfig();
    late = isLate(reg.proposedCheckIn, lateThresholdTime);

    if (reg.proposedCheckOut) {
      hoursWorkedMinutes = Math.max(
        0,
        Math.round((reg.proposedCheckOut.getTime() - reg.proposedCheckIn.getTime()) / 60000),
      );
    }
  }

  const now = new Date();
  const year = reg.date.getUTCFullYear();
  const month = reg.date.getUTCMonth() + 1;
  const lateLedger = await tx.attendanceLateLedger.findUnique({
    where: { employeeId_year_month: { employeeId: reg.employeeId, year, month } },
  });
  const lateMonthCount = lateLedger?.count ?? 0;

  const correctedRecord = await tx.attendanceRecord.create({
    data: {
      employeeId: reg.employeeId,
      date: dateOnly,
      status,
      checkInTime: reg.proposedCheckIn,
      checkOutTime: reg.proposedCheckOut,
      hoursWorkedMinutes,
      late,
      lateMonthCount,
      lopApplied: false,
      sourceId: AttendanceSource.regularisation,
      regularisationId: reg.id,
      version: 0,
    },
  });

  const updated = await tx.regularisationRequest.update({
    where: { id: reg.id },
    data: {
      status: RegStatus.Approved,
      decidedAt: now,
      decidedBy: approverId,
      decisionNote: note ?? null,
      correctedRecordId: correctedRecord.id,
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
    actorRole: (auditCtx.roleId ?? 2) as AuditActorRoleValue,
    actorIp: auditCtx.ip ?? null,
    action: 'regularisation.approve',
    targetType: 'RegularisationRequest',
    targetId: reg.id,
    module: 'attendance',
    before: { status: RegStatus.Pending },
    after: {
      status: RegStatus.Approved,
      correctedRecordId: correctedRecord.id,
      decidedAt: now.toISOString(),
      note: note ?? null,
    },
  });

  await notify({
    tx,
    recipientIds: reg.employeeId,
    category: 'Attendance',
    title: 'Your regularisation request was approved',
    body: `Regularisation for ${dateOnly.toISOString().split('T')[0]} has been approved. Your attendance record has been corrected.`,
    link: `/employee/regularisations/${reg.id}`,
  });

  return updated;
}

// ── Reject regularisation ─────────────────────────────────────────────────────

export async function rejectRegularisation(
  reg: {
    id: number;
    version: number;
  },
  rejecterId: number,
  note: string,
  tx: Prisma.TransactionClient,
  auditCtx: AuditCtx = {},
) {
  const now = new Date();

  const updated = await tx.regularisationRequest.update({
    where: { id: reg.id },
    data: {
      status: RegStatus.Rejected,
      decidedAt: now,
      decidedBy: rejecterId,
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
    actorId: rejecterId,
    actorRole: (auditCtx.roleId ?? 2) as AuditActorRoleValue,
    actorIp: auditCtx.ip ?? null,
    action: 'regularisation.reject',
    targetType: 'RegularisationRequest',
    targetId: reg.id,
    module: 'attendance',
    before: { status: RegStatus.Pending },
    after: {
      status: RegStatus.Rejected,
      decidedAt: now.toISOString(),
      note,
    },
  });

  await notify({
    tx,
    recipientIds: updated.employeeId,
    category: 'Attendance',
    title: 'Your regularisation request was rejected',
    body: `Regularisation for ${updated.date.toISOString().split('T')[0]} was rejected${note ? ` — ${note}` : ''}.`,
    link: `/employee/regularisations/${reg.id}`,
  });

  return updated;
}

// ── Visibility check ──────────────────────────────────────────────────────────

export async function canSeeRegularisation(
  userId: number,
  userRoleId: number,
  reg: {
    employeeId: number;
    approverId: number | null;
  },
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  // Admin sees all
  if (userRoleId === 4) return true; // RoleId.Admin

  // Owner
  if (reg.employeeId === userId) return true;

  // Current approver
  if (reg.approverId === userId) return true;

  // Chain manager
  if (userRoleId === 2) { // RoleId.Manager
    let current: number | null = reg.employeeId;
    const visited = new Set<number>();

    while (current && !visited.has(current)) {
      visited.add(current);
      const emp: { reportingManagerId: number | null } | null = await tx.employee.findUnique({
        where: { id: current },
        select: { reportingManagerId: true },
      });
      if (!emp?.reportingManagerId) break;
      if (emp.reportingManagerId === userId) return true;
      current = emp.reportingManagerId;
    }
  }

  return false;
}

// ── Map DB records to contract shape ─────────────────────────────────────────

/** Format a DB AttendanceRecord to the contract AttendanceRecord shape (v2 INT). */
export function formatAttendanceRecord(row: {
  id: number;
  employeeId: number;
  date: Date;
  status: number;
  checkInTime: Date | null;
  checkOutTime: Date | null;
  hoursWorkedMinutes: number | null;
  late: boolean;
  lateMonthCount: number;
  lopApplied: boolean;
  sourceId: number;
  regularisationId: number | null;
  createdAt: Date;
  version: number;
}) {
  return {
    id: row.id,
    employeeId: row.employeeId,
    date: row.date.toISOString().split('T')[0]!,
    status: row.status,
    checkInTime: row.checkInTime?.toISOString() ?? null,
    checkOutTime: row.checkOutTime?.toISOString() ?? null,
    hoursWorkedMinutes: row.hoursWorkedMinutes ?? null,
    late: row.late,
    lateMonthCount: row.lateMonthCount,
    lopApplied: row.lopApplied,
    sourceId: row.sourceId,
    regularisationId: row.regularisationId ?? null,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

/** Format a DB RegularisationRequest to the contract shape (v2 INT). */
export function formatRegularisation(row: {
  id: number;
  code: string;
  employeeId: number;
  employee: { name: string; code: string };
  date: Date;
  proposedCheckIn: Date | null;
  proposedCheckOut: Date | null;
  reason: string;
  status: number;
  routedToId: number;
  ageDaysAtSubmit: number;
  approverId: number | null;
  approver?: { name: string } | null;
  decidedAt: Date | null;
  decidedBy: number | null;
  decisionNote: string | null;
  correctedRecordId: number | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}) {
  return {
    id: row.id,
    code: row.code,
    employeeId: row.employeeId,
    employeeName: row.employee.name,
    employeeCode: row.employee.code,
    date: row.date.toISOString().split('T')[0]!,
    proposedCheckIn: row.proposedCheckIn?.toISOString() ?? null,
    proposedCheckOut: row.proposedCheckOut?.toISOString() ?? null,
    reason: row.reason,
    status: row.status,
    routedToId: row.routedToId,
    ageDaysAtSubmit: row.ageDaysAtSubmit,
    approverId: row.approverId ?? null,
    approverName: row.approver?.name ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedBy: row.decidedBy ?? null,
    decisionNote: row.decisionNote ?? null,
    correctedRecordId: row.correctedRecordId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}

// Legacy export kept for any remaining string-based callers (attendance routes still use this)
export function mapAttendanceStatusToDb(s: string): number {
  const m: Record<string, number> = {
    Present: AttendanceStatus.Present,
    Absent: AttendanceStatus.Absent,
    'On-Leave': AttendanceStatus.OnLeave,
    'Weekly-Off': AttendanceStatus.WeeklyOff,
    Holiday: AttendanceStatus.Holiday,
  };
  return m[s] ?? AttendanceStatus.Absent;
}
