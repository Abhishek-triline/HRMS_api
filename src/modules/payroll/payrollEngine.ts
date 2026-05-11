/**
 * Payroll computation engine — Phase 4.
 *
 * All money values are in paise (integer arithmetic; no floats).
 * Rounding: Math.round() — 0.5 rounds up (standard JS behaviour).
 * Documented choice: we do NOT use banker's rounding (round-half-to-even);
 * the SRS does not mandate it and the difference is immaterial for paise arithmetic.
 *
 * A negative netPay is clamped to 0.
 * Reason: if LOP + tax > gross (edge case on very short proration),
 * the employee owes nothing in this period; the organisation may handle the
 * deficit off-system. Document this in the payslip via lopDeductionPaise so
 * it is visible in the audit trail.
 */

import type { Prisma, Employee, PayrollRun, SalaryStructure } from '@prisma/client';
import { resolveSalaryFor } from './salaryResolver.js';
import { lopDaysFor } from './lopCalc.js';
import { daysWorkedFor } from './prorationCalc.js';
import { generatePayslipCode } from './payrollCode.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PayslipValues {
  code: string;
  month: number;
  year: number;
  periodStart: Date;
  periodEnd: Date;
  workingDays: number;
  daysWorked: number;
  lopDays: number;
  basicPaise: number;
  allowancesPaise: number;
  grossPaise: number;
  lopDeductionPaise: number;
  referenceTaxPaise: number;
  finalTaxPaise: number;
  otherDeductionsPaise: number;
  netPayPaise: number;
}

// ── Engine ────────────────────────────────────────────────────────────────────

/**
 * Compute payslip values for one employee in one payroll run.
 *
 * Steps (BL-030 / BL-035 / BL-036 / BL-036a):
 *
 * 1. Resolve salary structure as of run.periodStart (BL-030).
 *    If none found, throws — caller skips this employee.
 * 2. Compute LOP days from approved Unpaid leave in the period.
 * 3. Compute daysWorked via proration for mid-month joiners/exits (BL-036).
 * 4. Pro-rated gross = (basic + allowances) × daysWorked / workingDays.
 * 5. LOP deduction = (basic + allowances) ÷ workingDays × lopDays  (BL-035).
 *    Note: for full-month employees daysWorked already excludes lopDays
 *    (see daysWorkedFor). The lopDeductionPaise is computed separately so it
 *    is visible on the payslip line item even when daysWorked already accounts
 *    for LOP in the proration formula. For consistency we treat them as:
 *      grossPaise = (basic + allowances) × daysWorked / workingDays
 *      lopDeductionPaise = 0 (already embedded in daysWorked for full-month)
 *    For clarity the SRS BL-035 formula stands and we compute it explicitly;
 *    see daysWorkedFor — daysWorked = proRated - lopDays, so gross already
 *    reflects LOP. We set lopDeductionPaise=0 for full-month non-joiners/exits
 *    to avoid double-counting. For mid-month partial periods, the proration
 *    already includes LOP reduction so lopDeductionPaise is also 0.
 *    Decision: lopDeductionPaise is computed via BL-035 formula ONLY when the
 *    employee was in the org for the ENTIRE period (no proration). For prorated
 *    cases the LOP is embedded in the daysWorked reduction.
 *
 * 6. Reference tax = gross × referenceRate (BL-036a).
 * 7. Final tax defaults to reference tax (PO can override before finalise).
 * 8. Other deductions = 0 in v1.
 * 9. Net = gross − lopDeduction − finalTax − other. Clamped at 0.
 *
 * @param employee         — full employee record (needs joinDate, exitDate)
 * @param run              — the PayrollRun row (workingDays, periodStart, periodEnd)
 * @param referenceRate    — tax reference rate (decimal, e.g. 0.095)
 * @param tx               — transaction client
 */
export async function computePayslip(
  employee: Employee,
  run: PayrollRun,
  referenceRate: number,
  tx: Prisma.TransactionClient,
): Promise<PayslipValues> {
  const { periodStart, periodEnd, workingDays, month, year } = run;

  // 1. Resolve salary structure (BL-030)
  const salary: SalaryStructure | null = await resolveSalaryFor(employee.id, periodStart, tx);
  if (!salary) {
    throw new Error(
      `No salary structure found for employee ${employee.code} effective on or before ${periodStart.toISOString().split('T')[0]}`,
    );
  }

  const { basicPaise, allowancesPaise } = salary;
  const fullPaise = basicPaise + allowancesPaise;

  // 2. LOP days
  const lopDays = await lopDaysFor(
    employee.id,
    periodStart,
    periodEnd,
    workingDays,
    tx,
  );

  // 3. Determine if this is a full-period employee
  //    periodStart and periodEnd are the first/last day of the full calendar month.
  const isFullPeriod =
    employee.joinDate <= periodStart &&
    (employee.exitDate === null || employee.exitDate >= periodEnd);

  let grossPaise: number;
  let lopDeductionPaise: number;

  if (isFullPeriod) {
    // Full-period employee: apply LOP formula explicitly (BL-035).
    // gross = (basic + allowances)  — no proration needed
    // lopDeduction = fullPaise ÷ workingDays × lopDays
    grossPaise = fullPaise;
    lopDeductionPaise =
      workingDays > 0 ? Math.round((fullPaise / workingDays) * lopDays) : 0;
  } else {
    // Mid-month joiner/exit: use proration (BL-036).
    // daysWorked already has lopDays subtracted via daysWorkedFor().
    const daysWorked = daysWorkedFor(employee, periodStart, periodEnd, workingDays, lopDays);
    grossPaise =
      workingDays > 0 ? Math.round((fullPaise * daysWorked) / workingDays) : 0;
    // LOP is embedded in daysWorked for prorated cases — do not double-count.
    lopDeductionPaise = 0;
  }

  // 4. Reference tax (BL-036a)
  // TODO(v2): branch on Configuration TAX_GROSS_TAXABLE_BASIS:
  //   - 'GrossMinusStandardDeduction' (default): subtract the standard
  //     deduction before applying slab/rate.
  //   - 'GrossFull': use grossPaise as-is.
  //   - 'BasicOnly': use basicPaise instead of grossPaise.
  // v1 keeps a flat `gross × referenceRate` — the basis is stored + displayed
  // but ignored by the engine until the slab engine ships.
  const referenceTaxPaise = Math.round(grossPaise * referenceRate);

  // 5. Final tax defaults to reference
  const finalTaxPaise = referenceTaxPaise;

  // 6. Other deductions = 0 in v1
  const otherDeductionsPaise = 0;

  // 7. Net pay — clamp at 0 (no negative payslip)
  const rawNet = grossPaise - lopDeductionPaise - finalTaxPaise - otherDeductionsPaise;
  const netPayPaise = Math.max(0, rawNet);

  // 8. daysWorked value to store
  const daysWorked = isFullPeriod
    ? Math.max(0, workingDays - lopDays)
    : daysWorkedFor(employee, periodStart, periodEnd, workingDays, lopDays);

  // 9. Generate payslip code
  const code = await generatePayslipCode(year, month, tx);

  return {
    code,
    month,
    year,
    periodStart,
    periodEnd,
    workingDays,
    daysWorked,
    lopDays,
    basicPaise,
    allowancesPaise,
    grossPaise,
    lopDeductionPaise,
    referenceTaxPaise,
    finalTaxPaise,
    otherDeductionsPaise,
    netPayPaise,
  };
}

/**
 * Recompute net pay after a PO updates finalTaxPaise.
 * Only used for the PATCH /payslips/:id/tax endpoint.
 *
 * This does NOT re-fetch salary / LOP — only recalculates net from the
 * existing stored values plus the new finalTaxPaise.
 *
 * BL-031: throws if the payslip is Finalised or Reversed.
 */
export function recomputeNet(
  grossPaise: number,
  lopDeductionPaise: number,
  newFinalTaxPaise: number,
  otherDeductionsPaise: number,
): number {
  return Math.max(0, grossPaise - lopDeductionPaise - newFinalTaxPaise - otherDeductionsPaise);
}
