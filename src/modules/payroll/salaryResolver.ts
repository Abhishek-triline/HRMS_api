/**
 * Salary resolver — BL-030.
 *
 * Returns the SalaryStructure row whose effectiveFrom is the largest date
 * that is still <= periodStart. This is the "active" structure for the pay period.
 *
 * BL-030 enforcement: salary structure changes entered after periodStart are
 * ignored because their effectiveFrom > periodStart. Past runs are unaffected
 * by any subsequent salary change.
 *
 * Returns null if the employee has no salary structure effective on or before
 * periodStart. The caller decides what to do (skip payslip with a warning).
 */

import type { Prisma, SalaryStructure } from '@prisma/client';

/**
 * Resolve the effective salary structure for a given employee and period start.
 * Must be called inside a transaction so the read is consistent with other ops.
 */
export async function resolveSalaryFor(
  employeeId: number,
  periodStart: Date,
  tx: Prisma.TransactionClient,
): Promise<SalaryStructure | null> {
  // Find the salary structure with the largest effectiveFrom that is <= periodStart.
  const structure = await tx.salaryStructure.findFirst({
    where: {
      employeeId,
      effectiveFrom: { lte: periodStart },
    },
    orderBy: { effectiveFrom: 'desc' },
  });

  return structure ?? null;
}
