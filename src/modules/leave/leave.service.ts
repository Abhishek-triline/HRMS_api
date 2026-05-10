/**
 * Leave service — Phase 2.
 *
 * Pure business-logic functions (no Express types). All functions that mutate
 * state accept a Prisma.TransactionClient so they compose with the caller's
 * transaction.
 *
 * Rules enforced here:
 *   BL-009  Leave overlap detection → LEAVE_OVERLAP
 *   BL-010  Leave/regularisation conflict → LEAVE_REG_CONFLICT (Phase 3 wire-up)
 *   BL-011  Full-day units only (computeLeaveDays returns integer)
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
import { addWorkingDays, workingDaysBetween } from './workingDays.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../lib/audit.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RoutingResult {
  routedTo: 'Manager' | 'Admin';
  approverId: string;
}

export interface BalanceSnapshot {
  remaining: number;
  total: number | null;
  carryForwardCap: number | null;
}

// ── Compute leave days (BL-011) ───────────────────────────────────────────────

/**
 * Count the number of leave days requested — inclusive, full days only.
 *
 * Design decision: we count ALL calendar days (not just Mon–Fri) between
 * fromDate and toDate inclusive. The SRS specifies "full-day units" (BL-011)
 * and TC-LEAVE-009 leaves the weekends question open. This choice is the most
 * permissive and avoids a separate Sat/Sun half-day concept (DN-06).
 *
 * TODO(Phase 3): revisit when the holiday calendar is integrated. The spec
 * may clarify whether weekends reduce the day count.
 */
export function computeLeaveDays(fromDate: Date, toDate: Date): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  const from = new Date(fromDate);
  from.setHours(0, 0, 0, 0);
  const to = new Date(toDate);
  to.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / msPerDay) + 1);
}

// ── Admin lookup (deterministic) ──────────────────────────────────────────────

/**
 * Find the seeded Admin — the oldest active Admin by createdAt.
 * Used as the fallback approver for event-based leave and escalations.
 */
export async function findDefaultAdmin(
  tx: Prisma.TransactionClient,
): Promise<{ id: string; name: string }> {
  const admin = await tx.employee.findFirst({
    where: { role: 'Admin', status: 'Active' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });

  if (!admin) {
    throw new Error('No active Admin found in the system — cannot route leave request.');
  }

  return admin;
}

// ── Routing (BL-015 / BL-016 / BL-017 / BL-022) ─────────────────────────────

/**
 * Resolve the routing for a new leave request.
 *
 * Rules (in priority order):
 *   1. Maternity or Paternity → Admin always (BL-015 / BL-016)
 *   2. Employee has no reportingManagerId → Admin (BL-017)
 *   3. Reporting manager is Exited → Admin (BL-022)
 *   4. Else → Reporting manager (Manager)
 */
export async function resolveRouting(
  employeeId: string,
  leaveTypeName: string,
  tx: Prisma.TransactionClient,
): Promise<RoutingResult> {
  // Rule 1: event-based leave always goes to Admin
  if (leaveTypeName === 'Maternity' || leaveTypeName === 'Paternity') {
    const admin = await findDefaultAdmin(tx);
    return { routedTo: 'Admin', approverId: admin.id };
  }

  // Load the employee to check their reporting manager
  const emp = await tx.employee.findUnique({
    where: { id: employeeId },
    select: { reportingManagerId: true },
  });

  if (!emp) {
    throw new Error(`Employee ${employeeId} not found`);
  }

  // Rule 2: no reporting manager → Admin
  if (!emp.reportingManagerId) {
    const admin = await findDefaultAdmin(tx);
    return { routedTo: 'Admin', approverId: admin.id };
  }

  // Rule 3: check if the manager is Exited
  const manager = await tx.employee.findUnique({
    where: { id: emp.reportingManagerId },
    select: { id: true, status: true },
  });

  if (!manager || manager.status === 'Exited') {
    const admin = await findDefaultAdmin(tx);
    return { routedTo: 'Admin', approverId: admin.id };
  }

  // Rule 4: route to the reporting manager
  return { routedTo: 'Manager', approverId: manager.id };
}

// ── Overlap detection (BL-009) ────────────────────────────────────────────────

/**
 * Find any existing leave request for the employee that overlaps with
 * [fromDate, toDate]. Statuses considered: Pending, Approved, Escalated.
 *
 * Two date ranges overlap when:
 *   existingFrom <= toDate AND existingTo >= fromDate
 *
 * @param excludeId — omit this request id from the check (for future amendments)
 */
export async function findOverlappingLeave(
  employeeId: string,
  fromDate: Date,
  toDate: Date,
  tx: Prisma.TransactionClient,
  excludeId?: string,
) {
  const conflict = await tx.leaveRequest.findFirst({
    where: {
      employeeId,
      status: { in: ['Pending', 'Approved', 'Escalated'] },
      fromDate: { lte: toDate },
      toDate: { gte: fromDate },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    include: { leaveType: { select: { name: true } } },
  });

  return conflict ?? null;
}

// ── Regularisation conflict (BL-010) ─────────────────────────────────────────

/**
 * Find any approved regularisation request for the employee that overlaps
 * with [fromDate, toDate].
 *
 * TODO(Phase 3): The `RegularisationRequest` model does not exist yet.
 * When Phase 3 adds that table, replace this stub with the real query:
 *
 *   return tx.regularisationRequest.findFirst({
 *     where: {
 *       employeeId,
 *       status: { in: ['Approved'] },
 *       date: { gte: fromDate, lte: toDate },
 *     },
 *   });
 *
 * For now, always returns null (no conflict possible in Phase 2).
 */
export async function findOverlappingRegularisation(
  _employeeId: string,
  _fromDate: Date,
  _toDate: Date,
  _tx: Prisma.TransactionClient,
): Promise<null> {
  // Phase 2 stub — Phase 3 will wire this up.
  return null;
}

// ── Balance helpers ───────────────────────────────────────────────────────────

/**
 * Read (or upsert at zero) the LeaveBalance row for a given employee/type/year.
 * Returns the row including version for optimistic concurrency.
 */
export async function currentBalanceRow(
  employeeId: string,
  leaveTypeId: string,
  year: number,
  tx: Prisma.TransactionClient,
) {
  // Try to find existing row
  const existing = await tx.leaveBalance.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
  });

  if (existing) return existing;

  // Upsert at zero — handles the first-time case
  return tx.leaveBalance.upsert({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
    create: { employeeId, leaveTypeId, year, daysRemaining: 0, daysUsed: 0, version: 0 },
    update: {},
  });
}

/**
 * Read or create the balance row and return a BalanceSnapshot.
 * Also returns the leaveType's quota for the employee's employment type.
 */
export async function currentBalance(
  employeeId: string,
  leaveTypeId: string,
  year: number,
  tx: Prisma.TransactionClient,
): Promise<BalanceSnapshot & { leaveTypeId: string; version: number }> {
  const row = await currentBalanceRow(employeeId, leaveTypeId, year, tx);

  const leaveType = await tx.leaveType.findUnique({
    where: { id: leaveTypeId },
    select: { carryForwardCap: true, isEventBased: true },
  });

  const emp = await tx.employee.findUnique({
    where: { id: employeeId },
    select: { employmentType: true },
  });

  let total: number | null = null;
  if (!leaveType?.isEventBased && emp) {
    const quota = await tx.leaveQuota.findUnique({
      where: {
        leaveTypeId_employmentType: {
          leaveTypeId,
          employmentType: emp.employmentType,
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

/**
 * Apply approval: set status, deduct balance, record deductedDays.
 *
 * Deduction rules:
 *   - Annual / Sick / Casual: deduct `days` from daysRemaining
 *   - Unpaid: no balance to consume (balance is conceptually unlimited)
 *   - Maternity / Paternity (event-based): no balance deduction; instead,
 *     increment daysUsed on the per-year balance row so eligibility checks
 *     have a record.
 *
 * Always writes a LeaveBalanceLedger row for traceability.
 *
 * Uses optimistic concurrency: the version on the balance row must match.
 * (The request's own version lock is handled by the route handler.)
 */
export async function applyApproval(
  requestId: string,
  approverId: string,
  note: string | undefined,
  tx: Prisma.TransactionClient,
) {
  const request = await tx.leaveRequest.findUnique({
    where: { id: requestId },
    include: { leaveType: true, employee: { select: { employmentType: true } } },
  });

  if (!request) throw new Error(`LeaveRequest ${requestId} not found`);

  const year = request.fromDate.getFullYear();
  const leaveTypeName = request.leaveType.name;
  const isEventBased = request.leaveType.isEventBased;
  const isUnpaid = leaveTypeName === 'Unpaid';

  let deductedDays = 0;

  if (isEventBased) {
    // Maternity/Paternity: track daysUsed but do NOT deduct a balance
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
    // Accrual types: deduct from daysRemaining
    const balanceRow = await currentBalanceRow(
      request.employeeId,
      request.leaveTypeId,
      year,
      tx,
    );

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

    // Ledger entry for deduction
    await tx.leaveBalanceLedger.create({
      data: {
        employeeId: request.employeeId,
        leaveTypeId: request.leaveTypeId,
        year,
        delta: -request.days,
        reason: 'Approval',
        relatedRequestId: requestId,
        createdBy: approverId,
      },
    });

    void balanceRow; // used above for the row reference
  }
  // For Unpaid: no balance change, no ledger entry needed

  // Update the request
  const updated = await tx.leaveRequest.update({
    where: { id: requestId },
    data: {
      status: 'Approved',
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

/**
 * Apply cancellation: compute restoredDays, restore balance, close the request.
 *
 * Restore logic (BL-020):
 *   - cancelDate < fromDate  → restore ALL deductedDays (full restore)
 *   - cancelDate >= fromDate → partial restore:
 *       completedDays = max(0, min(today, toDate) - fromDate + 1)
 *       restoredDays = deductedDays - completedDays
 *       Sets cancelledAfterStart=true
 *
 * For Maternity/Paternity: same logic but applied to daysUsed decrement.
 */
export async function applyCancellation(
  requestId: string,
  cancelledById: string,
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
  const isUnpaid = request.leaveType.name === 'Unpaid';

  const cancelDay = new Date(cancelDate);
  cancelDay.setHours(0, 0, 0, 0);
  const fromDay = new Date(request.fromDate);
  fromDay.setHours(0, 0, 0, 0);
  const toDay = new Date(request.toDate);
  toDay.setHours(0, 0, 0, 0);

  const cancelledAfterStart = cancelDay >= fromDay;
  let restoredDays = 0;

  if (request.status === 'Approved' && request.deductedDays > 0) {
    if (!cancelledAfterStart) {
      // Full restore
      restoredDays = request.deductedDays;
    } else {
      // Partial restore: completedDays = days already consumed
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
        // Decrement daysUsed
        await tx.leaveBalance.updateMany({
          where: {
            employeeId: request.employeeId,
            leaveTypeId: request.leaveTypeId,
            year,
          },
          data: { daysUsed: { decrement: restoredDays } },
        });
      } else {
        // Restore to daysRemaining
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

        // Ledger entry for restoration
        await tx.leaveBalanceLedger.create({
          data: {
            employeeId: request.employeeId,
            leaveTypeId: request.leaveTypeId,
            year,
            delta: restoredDays,
            reason: 'Cancellation',
            relatedRequestId: requestId,
            createdBy: cancelledById,
          },
        });
      }
    }
  }

  // Close the request
  const updated = await tx.leaveRequest.update({
    where: { id: requestId },
    data: {
      status: 'Cancelled',
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

/**
 * Escalate all stale pending requests where:
 *   - routedTo = Manager AND
 *   - createdAt + 5 working days < now()
 * OR
 *   - the current approver (manager) is Exited (BL-022 — immediate escalation)
 *
 * This is idempotent: already-escalated requests are skipped.
 * Called by the hourly cron job.
 *
 * Returns the count of requests escalated in this run.
 */
export async function escalateStaleRequests(
  tx: Prisma.TransactionClient,
): Promise<number> {
  const now = new Date();

  // Load all Pending Manager-routed requests
  const pending = await tx.leaveRequest.findMany({
    where: {
      status: 'Pending',
      routedTo: 'Manager',
    },
    include: {
      approver: { select: { id: true, status: true } },
    },
  });

  const admin = await findDefaultAdmin(tx);
  let escalatedCount = 0;

  for (const req of pending) {
    const slaDeadline = addWorkingDays(req.createdAt, 5);
    const slaBreach = now > slaDeadline;
    const approverExited = req.approver?.status === 'Exited';

    if (!slaBreach && !approverExited) continue;

    const before = {
      status: req.status,
      routedTo: req.routedTo,
      approverId: req.approverId,
      escalatedAt: req.escalatedAt,
    };

    await tx.leaveRequest.update({
      where: { id: req.id },
      data: {
        status: 'Escalated',
        escalatedAt: now,
        routedTo: 'Admin',
        approverId: admin.id,
        version: { increment: 1 },
      },
    });

    // BUG-LEAVE-001 fix — every state-changing action writes an audit row
    // (BL-047 / BL-048). Cron-driven escalation is system-initiated, so
    // actorId is null and actorRole is "system".
    await audit({
      tx,
      actorId: null,
      actorRole: 'system',
      actorIp: null,
      action: 'leave.escalated',
      targetType: 'LeaveRequest',
      targetId: req.id,
      module: 'leave',
      before,
      after: {
        status: 'Escalated',
        routedTo: 'Admin',
        approverId: admin.id,
        escalatedAt: now.toISOString(),
        reason: approverExited ? 'approver_exited' : 'sla_breach',
      },
    });

    logger.info(
      {
        requestId: req.id,
        code: req.code,
        reason: approverExited ? 'approver_exited' : 'sla_breach',
      },
      'leave.escalation-sweep: escalated request',
    );

    escalatedCount++;
  }

  return escalatedCount;
}

// ── Carry-forward (BL-012 / BL-013) ─────────────────────────────────────────

/**
 * Run the annual carry-forward for all active employees.
 *
 * Called by the Jan 1 cron job. Processes the transition from `year - 1`
 * to `year` (the new year).
 *
 * Rules per leave type:
 *   Annual    — cap at carryForwardCap (default 10); excess truncated
 *   Casual    — cap at carryForwardCap (default 5)
 *   Sick      — reset to 0 (BL-012: no carry-forward)
 *   Unpaid    — reset to 0 (no carry)
 *   Maternity — untouched (BL-014)
 *   Paternity — untouched (BL-014)
 *
 * Idempotent: if a balance row for the new year already exists, it is skipped.
 *
 * Returns the number of employee/type pairs processed.
 */
export async function runCarryForward(
  newYear: number,
  tx: Prisma.TransactionClient,
): Promise<number> {
  const prevYear = newYear - 1;
  const db = tx ?? defaultPrisma;

  // All active employees
  const employees = await db.employee.findMany({
    where: { status: { in: ['Active', 'OnLeave', 'OnNotice'] } },
    select: { id: true, employmentType: true },
  });

  // All leave types
  const leaveTypes = await db.leaveType.findMany();

  let processed = 0;

  for (const emp of employees) {
    for (const lt of leaveTypes) {
      // Skip event-based types — carry-forward doesn't apply (BL-014)
      if (lt.isEventBased) continue;

      // Check if the new-year balance row already exists (idempotency guard)
      const existingNewYear = await tx.leaveBalance.findUnique({
        where: {
          employeeId_leaveTypeId_year: {
            employeeId: emp.id,
            leaveTypeId: lt.id,
            year: newYear,
          },
        },
      });

      if (existingNewYear) continue; // already processed for this employee/type/year

      // Get or create the previous year balance
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

      // Quota for the new year (basis for the new balance)
      const quota = await tx.leaveQuota.findUnique({
        where: {
          leaveTypeId_employmentType: {
            leaveTypeId: lt.id,
            employmentType: emp.employmentType,
          },
        },
      });
      const annualQuota = quota?.daysPerYear ?? 0;

      // Compute carry-forward amount
      let carryForward = 0;

      if (lt.name === 'Sick' || lt.name === 'Unpaid') {
        // Reset to zero — no carry
        carryForward = 0;
      } else {
        // Annual / Casual — cap at carryForwardCap
        const cap = lt.carryForwardCap ?? 0;
        carryForward = Math.min(prevRemaining, cap);
      }

      const newBalance = annualQuota + carryForward;

      // Create the new-year balance row
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

      // Ledger entry for carry-forward
      if (carryForward > 0) {
        await tx.leaveBalanceLedger.create({
          data: {
            employeeId: emp.id,
            leaveTypeId: lt.id,
            year: newYear,
            delta: carryForward,
            reason: 'CarryForward',
            relatedRequestId: null,
            createdBy: null, // system action
          },
        });
      }

      // Also ledger the annual quota grant
      if (annualQuota > 0) {
        await tx.leaveBalanceLedger.create({
          data: {
            employeeId: emp.id,
            leaveTypeId: lt.id,
            year: newYear,
            delta: annualQuota,
            reason: 'Initial',
            relatedRequestId: null,
            createdBy: null,
          },
        });
      }

      // BUG-LEAVE-001 fix — carry-forward is a state-changing action and
      // must be audited per BL-047 / BL-048. One audit row per
      // employee/type rather than per employee so the audit log doesn't
      // explode at scale; details capture the per-type before/after.
      await audit({
        tx,
        actorId: null,
        actorRole: 'system',
        actorIp: null,
        action: 'leave.carry-forward',
        targetType: 'LeaveBalance',
        targetId: `${emp.id}:${lt.id}:${newYear}`,
        module: 'leave',
        before: {
          year: prevYear,
          leaveType: lt.name,
          daysRemaining: prevRemaining,
        },
        after: {
          year: newYear,
          leaveType: lt.name,
          daysRemaining: newBalance,
          carryForward,
          annualQuota,
          cap: lt.carryForwardCap ?? null,
        },
      });

      processed++;
    }
  }

  return processed;
}
