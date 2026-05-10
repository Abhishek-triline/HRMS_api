/**
 * Working-days calculator for payroll — Phase 4.
 *
 * v1 uses a 5-day working week (Mon–Fri). The SRS does not define a 6-day
 * option in v1 so this choice is documented here for clarity.
 *
 * Computation:
 *   periodStart = first calendar day of the month (e.g. 2026-05-01)
 *   periodEnd   = last calendar day of the month  (e.g. 2026-05-31)
 *   workingDays = count of Mon–Fri days in the period MINUS public holidays
 *                 from the Holiday table for that month+year.
 *
 * The caller may override workingDays via the CreatePayrollRunRequest body;
 * this function provides the server-computed default.
 */

import type { Prisma } from '@prisma/client';

export interface WorkingDaysResult {
  workingDays: number;
  periodStart: Date;
  periodEnd: Date;
}

/**
 * Compute working days, periodStart, and periodEnd for the given month+year.
 * Runs inside the caller's transaction (or a standalone query).
 */
export async function computeWorkingDays(
  month: number,
  year: number,
  tx: Prisma.TransactionClient,
): Promise<WorkingDaysResult> {
  // Period boundaries — full calendar month, stored as UTC midnight dates
  const periodStart = new Date(Date.UTC(year, month - 1, 1));
  const periodEnd = new Date(Date.UTC(year, month, 0)); // day 0 of next month = last day of this month

  // Fetch holidays for this month+year
  const holidays = await tx.holiday.findMany({
    where: { year, date: { gte: periodStart, lte: periodEnd } },
    select: { date: true },
  });

  // Build a Set of holiday date strings (YYYY-MM-DD in UTC) for O(1) lookup
  const holidaySet = new Set(
    holidays.map((h) => h.date.toISOString().split('T')[0]),
  );

  let workingDays = 0;
  const cursor = new Date(periodStart);

  while (cursor <= periodEnd) {
    const dayOfWeek = cursor.getUTCDay(); // 0=Sun, 6=Sat
    const isWeekday = dayOfWeek !== 0 && dayOfWeek !== 6;

    if (isWeekday) {
      const dateStr = cursor.toISOString().split('T')[0]!;
      if (!holidaySet.has(dateStr)) {
        workingDays++;
      }
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return { workingDays, periodStart, periodEnd };
}
