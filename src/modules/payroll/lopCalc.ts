/**
 * LOP (Loss of Pay) calculator — BL-035.
 *
 * Counts the number of approved Unpaid leave days that overlap the payroll period.
 *
 * Rules (BL-011):
 *   - Counts only full calendar days (no half-day concept — DN-06).
 *   - The overlap is computed as max(periodStart, fromDate) to min(periodEnd, toDate) inclusive.
 *   - Only LeaveRequests with status='Approved' and leaveType.name='Unpaid' are counted.
 *
 * Returns an integer — the total number of LOP days to deduct.
 */

import type { Prisma } from '@prisma/client';
import { LeaveStatus } from '../../lib/statusInt.js';

/**
 * Compute the number of approved Unpaid leave days for an employee
 * that fall within [periodStart, periodEnd].
 *
 * @param employeeId  — employee to compute LOP for (INT)
 * @param periodStart — first day of the pay period (inclusive)
 * @param periodEnd   — last day of the pay period (inclusive)
 * @param workingDays — cap: LOP days cannot exceed working days in the period
 * @param tx          — transaction client
 */
export async function lopDaysFor(
  employeeId: number,
  periodStart: Date,
  periodEnd: Date,
  workingDays: number,
  tx: Prisma.TransactionClient,
): Promise<number> {
  // Find the Unpaid leave type id
  const unpaidType = await tx.leaveType.findUnique({
    where: { name: 'Unpaid' },
    select: { id: true },
  });

  if (!unpaidType) return 0;

  // Fetch all approved Unpaid leave requests that overlap this period
  const requests = await tx.leaveRequest.findMany({
    where: {
      employeeId,
      leaveTypeId: unpaidType.id,
      status: LeaveStatus.Approved,
      // Overlap condition: fromDate <= periodEnd AND toDate >= periodStart
      fromDate: { lte: periodEnd },
      toDate: { gte: periodStart },
    },
    select: { fromDate: true, toDate: true, days: true },
  });

  // Sum up the days that actually fall within the period (overlap)
  let total = 0;

  for (const req of requests) {
    const overlapStart = req.fromDate > periodStart ? req.fromDate : periodStart;
    const overlapEnd = req.toDate < periodEnd ? req.toDate : periodEnd;

    if (overlapStart > overlapEnd) continue;

    // Count calendar days in the overlap range (BL-011: full days only)
    const diffMs = overlapEnd.getTime() - overlapStart.getTime();
    const days = Math.round(diffMs / (24 * 60 * 60 * 1000)) + 1;
    total += days;
  }

  // LOP cannot exceed workingDays in the period (sanity cap)
  return Math.min(total, workingDays);
}
