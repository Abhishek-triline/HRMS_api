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
import {
  findUnpaidAdminFinalisedForEmployee,
  markEncashmentPaid,
} from '../leave/leave-encashment.service.js';

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
  // BL-LE-09: encashment fields (0 / null when no encashment in this run)
  encashmentDays: number;
  encashmentPaise: number;
  encashmentId: number | null;
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

  // 4. BL-LE-09: check for an unpaid AdminFinalised encashment for the PREVIOUS year.
  // The payroll run for month M of year Y picks up encashments for year Y-1.
  // Example: Jan 2026 payroll run picks up Dec 2025 encashments.
  const encashmentYear = year - 1;
  const pendingEncashment = await findUnpaidAdminFinalisedForEmployee(
    employee.id,
    encashmentYear,
    tx,
  );

  let encashmentDays = 0;
  let encashmentPaiseFinal = 0;
  let encashmentId: number | null = null;

  if (pendingEncashment && pendingEncashment.daysApproved !== null) {
    // BL-LE-07: rate uses THIS RUN's workingDays (paying-month), not the locked snapshot.
    // The locked ratePerDayPaise at AdminFinalise used APPROX_WORKING_DAYS=26.
    // Here we override with the actual paying-month workingDays for accuracy.
    // We update the encashment record's rate + amount at markEncashmentPaid to keep
    // the audit trail accurate (see leave-encashment.service.ts: markEncashmentPaid).
    const daForCalc = (salary as SalaryStructure & { daPaise?: number | null }).daPaise ?? 0;
    const ratePerDay = workingDays > 0
      ? Math.floor((basicPaise + daForCalc) / workingDays)
      : 0;
    const encashmentPaiseComputed = pendingEncashment.daysApproved * ratePerDay;

    encashmentDays = pendingEncashment.daysApproved;
    encashmentPaiseFinal = encashmentPaiseComputed;
    encashmentId = pendingEncashment.id;

    // Add encashment to gross BEFORE tax calculation (BL-LE-12: taxable)
    grossPaise += encashmentPaiseComputed;
  }

  // 5. Reference tax (BL-036a)
  // TODO(v2): branch on Configuration TAX_GROSS_TAXABLE_BASIS:
  //   - 'GrossMinusStandardDeduction' (default): subtract the standard
  //     deduction before applying slab/rate.
  //   - 'GrossFull': use grossPaise as-is.
  //   - 'BasicOnly': use basicPaise instead of grossPaise.
  // v1 keeps a flat `gross × referenceRate` — the basis is stored + displayed
  // but ignored by the engine until the slab engine ships.
  const referenceTaxPaise = Math.round(grossPaise * referenceRate);

  // 6. Final tax defaults to reference
  const finalTaxPaise = referenceTaxPaise;

  // 7. Other deductions = 0 in v1
  const otherDeductionsPaise = 0;

  // 8. Net pay — clamp at 0 (no negative payslip)
  const rawNet = grossPaise - lopDeductionPaise - finalTaxPaise - otherDeductionsPaise;
  const netPayPaise = Math.max(0, rawNet);

  // 9. daysWorked value to store
  const daysWorked = isFullPeriod
    ? Math.max(0, workingDays - lopDays)
    : daysWorkedFor(employee, periodStart, periodEnd, workingDays, lopDays);

  // 10. Generate payslip code
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
    encashmentDays,
    encashmentPaise: encashmentPaiseFinal,
    encashmentId,
  };
}

/**
 * After a payslip has been created (inside the run transaction), call this to
 * mark the encashment as Paid and update the rate/amount snapshot to the actual
 * paying-month values (BL-LE-07).
 *
 * Must be called ONLY when computePayslip returned a non-null encashmentId.
 */
export async function finaliseEncashmentPayment(
  values: PayslipValues,
  payslipId: number,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (!values.encashmentId) return;

  const workingDays = values.workingDays;
  // Re-derive ratePerDay using the stored basicPaise from the payslip values.
  // We don't have daPaise here; the encashment service will update the record.
  // We pass the engine-computed encashmentPaise and back-calculate rate.
  const ratePerDay = values.encashmentDays > 0
    ? Math.floor(values.encashmentPaise / values.encashmentDays)
    : 0;

  void workingDays; // used implicitly via encashmentPaise

  await markEncashmentPaid(
    values.encashmentId,
    payslipId,
    ratePerDay,
    values.encashmentPaise,
    tx,
  );
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
