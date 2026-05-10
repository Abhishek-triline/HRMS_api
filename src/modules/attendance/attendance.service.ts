/**
 * Attendance service — Phase 3.
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
 */

import type { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notifications.js';
import { logger } from '../../lib/logger.js';
import { isHoliday, isWeeklyOff } from './holidays.js';
import {
  findOverlappingLeave,
  currentBalanceRow,
  findDefaultAdmin,
} from '../leave/leave.service.js';
import { generateRegCode } from './regCode.js';
import { ErrorCode } from '@nexora/contracts/errors';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * SEC-002-P3 — actor context threaded into service helpers so audit rows
 * carry the real `actorIp` and `actorRole` instead of hardcoded defaults.
 * All fields are optional; callers are expected to populate from `req.ip`
 * and `req.user.role` at the route boundary.
 */
export interface AuditCtx {
  role?: string;
  ip?: string | null;
}

/**
 * SEC-003-P3 — conflict details now match `LeaveConflictDetailsSchema` from
 * `@nexora/contracts/leave` so the front-end can render a single typed
 * block for both directions of the BL-010 conflict.
 */
export interface RegularisationConflictError {
  code: typeof ErrorCode.LEAVE_REG_CONFLICT;
  details: {
    conflictType: 'Leave';
    conflictId: string;
    conflictCode: string;
    conflictFrom: string;
    conflictTo: string | null;
    conflictStatus: string;
  };
}

// ── Configuration helpers ─────────────────────────────────────────────────────

/**
 * Read a configuration value from the DB.
 * Falls back to the provided default if the key is missing.
 */
async function getConfig(
  key: string,
  defaultValue: string,
  tx: Prisma.TransactionClient,
): Promise<string> {
  const row = await tx.configuration.findUnique({ where: { key } });
  if (!row) return defaultValue;
  // config values are stored as JSON; unwrap string values
  const val = row.value;
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  return defaultValue;
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
 * We use UTC+5:30 offset directly since Node.js doesn't always have a tz database.
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
 *   1. Approved leave covering the date → OnLeave
 *   2. Public holiday → Holiday
 *   3. Weekly off (Sat/Sun) → WeeklyOff
 *   4. Otherwise → null (caller decides Present vs Absent based on check-in)
 *
 * Returns the DB enum value (no hyphens).
 */
export async function deriveStatusForDay(
  employeeId: string,
  date: Date,
  tx: Prisma.TransactionClient,
): Promise<'OnLeave' | 'Holiday' | 'WeeklyOff' | null> {
  // 1. Approved leave covering this date
  const dayStart = new Date(date);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCHours(23, 59, 59, 999);

  const approvedLeave = await tx.leaveRequest.findFirst({
    where: {
      employeeId,
      status: 'Approved',
      fromDate: { lte: dayEnd },
      toDate: { gte: dayStart },
    },
    select: { id: true },
  });

  if (approvedLeave) return 'OnLeave';

  // 2. Public holiday
  const holiday = await isHoliday(date, tx);
  if (holiday) return 'Holiday';

  // 3. Weekly off
  if (isWeeklyOff(date)) return 'WeeklyOff';

  return null;
}

// ── Midnight generate (BL-023) ────────────────────────────────────────────────

/**
 * For each Active or OnNotice employee, upsert one AttendanceRecord row with
 * source='system' for the given date. Default status is Absent, overridden by
 * BL-026 priority (Holiday/WeeklyOff/OnLeave when applicable).
 *
 * Idempotent: skips employees who already have a system row for that date.
 * Writes a single audit entry at function level.
 *
 * Called by the daily midnight cron job.
 */
export async function runMidnightGenerate(
  date: Date,
  tx: Prisma.TransactionClient,
): Promise<{ employeesProcessed: number }> {
  const dateOnly = new Date(date);
  dateOnly.setUTCHours(0, 0, 0, 0);

  // All Active + OnNotice employees
  const employees = await tx.employee.findMany({
    where: { status: { in: ['Active', 'OnNotice'] } },
    select: { id: true },
  });

  let employeesProcessed = 0;

  for (const emp of employees) {
    // Idempotency guard: skip if a system row already exists for this date
    const existing = await tx.attendanceRecord.findUnique({
      where: {
        employeeId_date_source: {
          employeeId: emp.id,
          date: dateOnly,
          source: 'system',
        },
      },
      select: { id: true },
    });

    if (existing) continue;

    // Derive status per BL-026
    const derivedStatus = await deriveStatusForDay(emp.id, dateOnly, tx);
    const status = derivedStatus ?? 'Absent';

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
        source: 'system',
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

/** Shape of a raw AttendanceRecord row returned from Prisma. */
export interface RawAttendanceRecord {
  id: string;
  employeeId: string;
  date: Date;
  status: string;
  checkInTime: Date | null;
  checkOutTime: Date | null;
  hoursWorkedMinutes: number | null;
  late: boolean;
  lateMonthCount: number;
  lopApplied: boolean;
  source: string;
  regularisationId: string | null;
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
 *
 * Logic:
 *   1. Upsert the system row with status=Present, checkInTime=now.
 *   2. Compute lateness against LATE_THRESHOLD config.
 *   3. Increment AttendanceLateLedger.count for the month.
 *   4. If new count is a multiple of 3 → deduct 1 day from Annual leave (BL-028).
 *   5. Audit attendance.check-in (and attendance.late-mark.deducted if penalty fired).
 *
 * Returns the updated record, the deduction flag, and the new monthly late count.
 */
export async function recordCheckIn(
  employeeId: string,
  now: Date,
  tx: Prisma.TransactionClient,
  auditCtx: AuditCtx = {},
): Promise<CheckInResult> {
  const dateOnly = new Date(now);
  dateOnly.setUTCHours(0, 0, 0, 0);

  // Check for existing system row today (idempotency)
  const existing = await tx.attendanceRecord.findUnique({
    where: {
      employeeId_date_source: {
        employeeId,
        date: dateOnly,
        source: 'system',
      },
    },
  });

  // If already checked in, return idempotent response
  if (existing?.checkInTime) {
    // Get the current month late count for the response
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const lateLedger = await tx.attendanceLateLedger.findUnique({
      where: { employeeId_year_month: { employeeId, year, month } },
    });
    return {
      record: existing,
      lateMarkDeductionApplied: false,
      lateMonthCount: lateLedger?.count ?? 0,
    };
  }

  // Read the late threshold from configuration
  const lateThreshold = await getConfig('LATE_THRESHOLD', '10:30', tx);
  const late = isLate(now, lateThreshold);

  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  // Get current monthly late count (before this check-in)
  let lateMonthCount = 0;
  let lateMarkDeductionApplied = false;

  if (late) {
    // Upsert the late ledger and increment
    const lateLedger = await tx.attendanceLateLedger.upsert({
      where: { employeeId_year_month: { employeeId, year, month } },
      create: { employeeId, year, month, count: 1 },
      update: { count: { increment: 1 } },
    });
    lateMonthCount = lateLedger.count;

    // BL-028 (BUG-ATT-001 fix): the spec deducts 1 Annual leave day on the
    // 3rd late mark of the month AND on EACH ADDITIONAL late beyond that.
    // Earlier code only fired on multiples of 3 (3, 6, 9, …) — that's wrong
    // for the 4th, 5th, 7th, 8th, 10th… etc. Now: fire at every count >= 3.
    if (lateMonthCount >= 3) {
      lateMarkDeductionApplied = await deductLateMarkPenalty(employeeId, year, now, tx);
    }
  } else {
    const lateLedger = await tx.attendanceLateLedger.findUnique({
      where: { employeeId_year_month: { employeeId, year, month } },
    });
    lateMonthCount = lateLedger?.count ?? 0;
  }

  // BUG-ATT-002 fix — BL-026 status priority must hold on check-in. The
  // priority is On-Leave > Weekly-Off / Holiday > Present > Absent. We
  // still record the check-in time (so the audit trail keeps it) but the
  // displayed status reflects the higher-priority reason. `deriveStatusForDay`
  // returns one of On-Leave / Holiday / Weekly-Off / null; null means no
  // higher priority applies and the row should be Present.
  const priorityStatus = await deriveStatusForDay(employeeId, dateOnly, tx);
  const newStatus = priorityStatus ?? 'Present';

  const record = await tx.attendanceRecord.upsert({
    where: {
      employeeId_date_source: {
        employeeId,
        date: dateOnly,
        source: 'system',
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
      source: 'system',
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
    actorRole: auditCtx.role ?? 'Employee',
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

  return { record, lateMarkDeductionApplied, lateMonthCount };
}

/**
 * Deduct 1 day from the employee's Annual leave balance as a late-mark penalty.
 * BL-028: fires on the 3rd, 6th, 9th, ... late mark in a calendar month.
 *
 * Returns true if the deduction was applied, false if balance was already 0
 * (in which case no deduction is written — no negative balances).
 */
async function deductLateMarkPenalty(
  employeeId: string,
  year: number,
  now: Date,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  // Find the Annual leave type
  const annualType = await tx.leaveType.findUnique({ where: { name: 'Annual' } });
  if (!annualType) return false;

  const balanceRow = await currentBalanceRow(employeeId, annualType.id, year, tx);

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
        leaveTypeId: annualType.id,
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
      leaveTypeId: annualType.id,
      year,
      delta: -1,
      reason: 'LateMarkPenalty',
      relatedRequestId: null,
      createdBy: null, // system-triggered
    },
  });

  // Audit the deduction
  await audit({
    tx,
    actorId: null,
    actorRole: 'system',
    actorIp: null,
    action: 'attendance.late-mark.deducted',
    targetType: 'LeaveBalance',
    targetId: `${employeeId}:${annualType.id}:${year}`,
    module: 'attendance',
    before: { daysRemaining: balanceRow.daysRemaining },
    after: {
      daysRemaining: balanceRow.daysRemaining - 1,
      reason: 'BL-028 late-mark penalty (multiple of 3)',
      date: now.toISOString(),
    },
  });

  // Notify the employee about the late-mark deduction (BL-028)
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
 * Record a check-out for today. Idempotent — a second call returns the existing
 * record without modification.
 *
 * Requires a check-in to exist for today (returns null if not, caller returns 400).
 * Computes hoursWorkedMinutes = checkOut − checkIn in minutes (BL-025).
 * Audits attendance.check-out.
 */
export async function recordCheckOut(
  employeeId: string,
  now: Date,
  tx: Prisma.TransactionClient,
  auditCtx: AuditCtx = {},
): Promise<CheckOutResult | null> {
  const dateOnly = new Date(now);
  dateOnly.setUTCHours(0, 0, 0, 0);

  const existing = await tx.attendanceRecord.findUnique({
    where: {
      employeeId_date_source: {
        employeeId,
        date: dateOnly,
        source: 'system',
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
    return { record: existing, hoursWorkedMinutes };
  }

  // Compute hours worked in minutes
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
    actorRole: auditCtx.role ?? 'Employee',
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

  return { record, hoursWorkedMinutes };
}

// ── Today's open attendance ────────────────────────────────────────────────────

/**
 * Find today's system attendance record for an employee.
 * Returns null if no row exists (midnight job hasn't run yet or employee just joined).
 */
export async function findOpenAttendance(
  employeeId: string,
  today: Date,
  tx: Prisma.TransactionClient,
) {
  const dateOnly = new Date(today);
  dateOnly.setUTCHours(0, 0, 0, 0);

  return tx.attendanceRecord.findUnique({
    where: {
      employeeId_date_source: {
        employeeId,
        date: dateOnly,
        source: 'system',
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

/**
 * Submit a new regularisation request.
 *
 * Steps:
 *   1. Validate date < today.
 *   2. BL-010: check for approved leave on that date (LEAVE_REG_CONFLICT).
 *   3. BL-029: compute ageDaysAtSubmit, route to Manager (≤7d) or Admin (>7d).
 *      If reportingManagerId is null or manager is Exited → Admin.
 *   4. Generate R-YYYY-NNNN code.
 *   5. Insert row, audit regularisation.create.
 */
export async function submitRegularisation(
  employeeId: string,
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
  // SEC-003-P3 — details now match LeaveConflictDetailsSchema so the front
  // end can render a single typed conflict block for both directions of
  // the BL-010 check (leave→reg and reg→leave).
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

  // Compute age in days
  const msPerDay = 1000 * 60 * 60 * 24;
  const ageDaysAtSubmit = Math.round((today.getTime() - dateOnly.getTime()) / msPerDay);

  // BL-029 routing
  let routedTo: 'Manager' | 'Admin' = 'Admin';
  let approverId: string | null = null;

  if (ageDaysAtSubmit <= 7) {
    // Route to reporting manager if available and not Exited
    const emp = await tx.employee.findUnique({
      where: { id: employeeId },
      select: { reportingManagerId: true },
    });

    if (emp?.reportingManagerId) {
      const manager = await tx.employee.findUnique({
        where: { id: emp.reportingManagerId },
        select: { id: true, status: true },
      });

      if (manager && manager.status !== 'Exited') {
        routedTo = 'Manager';
        approverId = manager.id;
      }
    }
  }

  // Fall back to Admin if routedTo is still Admin
  if (routedTo === 'Admin' || !approverId) {
    const admin = await findDefaultAdmin(tx);
    routedTo = 'Admin';
    approverId = admin.id;
  }

  // Generate code
  const year = today.getUTCFullYear();
  const code = await generateRegCode(year, tx);

  // Create the regularisation request
  const reg = await tx.regularisationRequest.create({
    data: {
      code,
      employeeId,
      date: dateOnly,
      proposedCheckIn,
      proposedCheckOut,
      reason,
      status: 'Pending',
      routedTo: routedTo === 'Manager' ? 'Manager' : 'Admin',
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

  // Audit regularisation.create
  await audit({
    tx,
    actorId: employeeId,
    actorRole: auditCtx.role ?? 'Employee',
    actorIp: auditCtx.ip ?? null,
    action: 'regularisation.create',
    targetType: 'RegularisationRequest',
    targetId: reg.id,
    module: 'attendance',
    before: null,
    after: {
      code,
      date: dateOnly.toISOString().split('T')[0],
      routedTo,
      approverId,
      ageDaysAtSubmit,
    },
  });

  // Notify the approver about the new regularisation request
  if (approverId) {
    await notify({
      tx,
      recipientIds: approverId,
      category: 'Attendance',
      title: `Regularisation request from ${reg.employee.name}`,
      body: `Regularisation request ${code} for ${dateOnly.toISOString().split('T')[0]} is pending your approval.`,
      link: `/${routedTo === 'Manager' ? 'manager' : 'admin'}/regularisations/${reg.id}`,
    });
  }

  return reg;
}

// ── Approve regularisation ─────────────────────────────────────────────────────

/**
 * Approve a regularisation request.
 *
 * Steps:
 *   1. Create a new AttendanceRecord row with source='regularisation' (BL-007).
 *   2. The original system row is preserved — never mutated (BL-007).
 *   3. Derive the status for the corrected row per BL-026.
 *   4. Update the regularisation row: Approved, correctedRecordId set.
 *   5. Audit regularisation.approve.
 *
 * Design note on BL-028 and back-dated check-ins:
 *   We do NOT re-trigger the BL-028 late-mark deduction for back-dated
 *   regularisations. BL-028 fires only on live check-ins (real-time, day-of)
 *   where the employee is actively late. Back-dated corrections are an
 *   administrative fix and do not represent a live tardiness event.
 *   This choice is documented here and in the audit trail.
 */
export async function approveRegularisation(
  reg: {
    id: string;
    employeeId: string;
    date: Date;
    proposedCheckIn: Date | null;
    proposedCheckOut: Date | null;
    version: number;
    approverId: string | null;
  },
  approverId: string,
  note: string | undefined,
  tx: Prisma.TransactionClient,
  auditCtx: AuditCtx = {},
) {
  const dateOnly = new Date(reg.date);
  dateOnly.setUTCHours(0, 0, 0, 0);

  // Derive status for the corrected row per BL-026
  const derivedStatus = await deriveStatusForDay(reg.employeeId, dateOnly, tx);
  const status = derivedStatus ?? (reg.proposedCheckIn ? 'Present' : 'Absent');

  // Compute hoursWorkedMinutes if both times are present
  let hoursWorkedMinutes: number | null = null;
  let late = false;

  if (reg.proposedCheckIn) {
    const lateThreshold = await getConfig('LATE_THRESHOLD', '10:30', tx);
    late = isLate(reg.proposedCheckIn, lateThreshold);

    if (reg.proposedCheckOut) {
      hoursWorkedMinutes = Math.max(
        0,
        Math.round((reg.proposedCheckOut.getTime() - reg.proposedCheckIn.getTime()) / 60000),
      );
    }
  }

  // Get the current monthly late count (snapshot at write time — no deduction re-trigger)
  const now = new Date();
  const year = reg.date.getUTCFullYear();
  const month = reg.date.getUTCMonth() + 1;
  const lateLedger = await tx.attendanceLateLedger.findUnique({
    where: { employeeId_year_month: { employeeId: reg.employeeId, year, month } },
  });
  const lateMonthCount = lateLedger?.count ?? 0;

  // Create the new corrected attendance row (BL-007: append, never mutate)
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
      source: 'regularisation',
      regularisationId: reg.id,
      version: 0,
    },
  });

  // Update the regularisation request
  const updated = await tx.regularisationRequest.update({
    where: { id: reg.id },
    data: {
      status: 'Approved',
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

  // Audit regularisation.approve
  await audit({
    tx,
    actorId: approverId,
    actorRole: auditCtx.role ?? 'Approver',
    actorIp: auditCtx.ip ?? null,
    action: 'regularisation.approve',
    targetType: 'RegularisationRequest',
    targetId: reg.id,
    module: 'attendance',
    before: { status: 'Pending' },
    after: {
      status: 'Approved',
      correctedRecordId: correctedRecord.id,
      decidedAt: now.toISOString(),
      note: note ?? null,
    },
  });

  // Notify the employee that their regularisation was approved
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

/**
 * Reject a regularisation request. Note is required (TC-REG-005).
 * Audits regularisation.reject.
 */
export async function rejectRegularisation(
  reg: {
    id: string;
    version: number;
  },
  rejecterId: string,
  note: string,
  tx: Prisma.TransactionClient,
  auditCtx: AuditCtx = {},
) {
  const now = new Date();

  const updated = await tx.regularisationRequest.update({
    where: { id: reg.id },
    data: {
      status: 'Rejected',
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

  // Audit regularisation.reject
  await audit({
    tx,
    actorId: rejecterId,
    actorRole: auditCtx.role ?? 'Approver',
    actorIp: auditCtx.ip ?? null,
    action: 'regularisation.reject',
    targetType: 'RegularisationRequest',
    targetId: reg.id,
    module: 'attendance',
    before: { status: 'Pending' },
    after: {
      status: 'Rejected',
      decidedAt: now.toISOString(),
      note,
    },
  });

  // Notify the employee that their regularisation was rejected
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

/**
 * Returns true if the requesting user can see the given regularisation request.
 *
 * Visibility rules:
 *   - Owner (employee who submitted it)
 *   - Current approver (approverId matches)
 *   - Manager in the chain above the owner
 *   - Admin always
 */
export async function canSeeRegularisation(
  userId: string,
  userRole: string,
  reg: {
    employeeId: string;
    approverId: string | null;
  },
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  // Admin sees all
  if (userRole === 'Admin') return true;

  // Owner
  if (reg.employeeId === userId) return true;

  // Current approver
  if (reg.approverId === userId) return true;

  // Chain manager: check if userId is a manager in the ownership chain above reg.employeeId
  if (userRole === 'Manager') {
    // Walk the reporting chain upward from reg.employeeId
    let current = reg.employeeId;
    const visited = new Set<string>();

    while (current && !visited.has(current)) {
      visited.add(current);
      const emp = await tx.employee.findUnique({
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

/** Map DB AttendanceStatus → contract enum (with hyphens). */
export function mapAttendanceStatus(
  s: string,
): 'Present' | 'Absent' | 'On-Leave' | 'Weekly-Off' | 'Holiday' {
  const m: Record<string, 'Present' | 'Absent' | 'On-Leave' | 'Weekly-Off' | 'Holiday'> = {
    Present: 'Present',
    Absent: 'Absent',
    OnLeave: 'On-Leave',
    WeeklyOff: 'Weekly-Off',
    Holiday: 'Holiday',
  };
  return m[s] ?? 'Absent';
}

/** Map contract AttendanceStatus (with hyphens) → DB enum (no hyphens). */
export function mapAttendanceStatusToDb(
  s: string,
): 'Present' | 'Absent' | 'OnLeave' | 'WeeklyOff' | 'Holiday' {
  const m: Record<string, 'Present' | 'Absent' | 'OnLeave' | 'WeeklyOff' | 'Holiday'> = {
    Present: 'Present',
    Absent: 'Absent',
    'On-Leave': 'OnLeave',
    'Weekly-Off': 'WeeklyOff',
    Holiday: 'Holiday',
  };
  return m[s] ?? 'Absent';
}

/** Map RegStatusDb → contract RegStatus. */
export function mapRegStatus(s: string): 'Pending' | 'Approved' | 'Rejected' {
  if (s === 'Approved') return 'Approved';
  if (s === 'Rejected') return 'Rejected';
  return 'Pending';
}

/** Map RegRoutedToDb → contract RegRoutedTo. */
export function mapRegRoutedTo(s: string): 'Manager' | 'Admin' {
  return s === 'Manager' ? 'Manager' : 'Admin';
}

/** Format a DB AttendanceRecord to the contract AttendanceRecord shape. */
export function formatAttendanceRecord(row: {
  id: string;
  employeeId: string;
  date: Date;
  status: string;
  checkInTime: Date | null;
  checkOutTime: Date | null;
  hoursWorkedMinutes: number | null;
  late: boolean;
  lateMonthCount: number;
  lopApplied: boolean;
  source: string;
  regularisationId: string | null;
  createdAt: Date;
  version: number;
}) {
  return {
    id: row.id,
    employeeId: row.employeeId,
    date: row.date.toISOString().split('T')[0]!,
    status: mapAttendanceStatus(row.status),
    checkInTime: row.checkInTime?.toISOString() ?? null,
    checkOutTime: row.checkOutTime?.toISOString() ?? null,
    hoursWorkedMinutes: row.hoursWorkedMinutes ?? null,
    late: row.late,
    lateMonthCount: row.lateMonthCount,
    lopApplied: row.lopApplied,
    source: (row.source === 'regularisation' ? 'regularisation' : 'system') as
      | 'system'
      | 'regularisation',
    regularisationId: row.regularisationId ?? null,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

/** Format a DB RegularisationRequest to the contract shape. */
export function formatRegularisation(row: {
  id: string;
  code: string;
  employeeId: string;
  employee: { name: string; code: string };
  date: Date;
  proposedCheckIn: Date | null;
  proposedCheckOut: Date | null;
  reason: string;
  status: string;
  routedTo: string;
  ageDaysAtSubmit: number;
  approverId: string | null;
  approver?: { name: string } | null;
  decidedAt: Date | null;
  decidedBy: string | null;
  decisionNote: string | null;
  correctedRecordId: string | null;
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
    status: mapRegStatus(row.status),
    routedTo: mapRegRoutedTo(row.routedTo),
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

/** Export getConfig for use in routes (read LATE_THRESHOLD, STANDARD_DAILY_HOURS). */
export { getConfig };
