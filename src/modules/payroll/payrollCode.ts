/**
 * Payroll code generators — Phase 4.
 *
 * Run codes:    RUN-YYYY-MM       (originals)
 *               RUN-YYYY-MM-R<n>  (reversal records, n = 1-based count)
 *
 * Payslip codes: P-YYYY-MM-NNNN   (4-digit zero-padded sequence per month+year)
 *
 * Concurrency: each counter kind uses a dedicated PayrollCodeCounter row with
 * SELECT … FOR UPDATE to serialise concurrent generation for the same month+year.
 * The DB UNIQUE constraint on run/payslip code is the hard safety net.
 */

import type { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../lib/prisma.js';

const MAX_RETRIES = 3;

// ── Run code ──────────────────────────────────────────────────────────────────

/**
 * Generate the next original run code RUN-YYYY-MM inside the caller's
 * transaction. The counter table guarantees monotonic increment; the UNIQUE
 * constraint on payroll_runs.code is the hard guard.
 *
 * For reversal runs call generateReversalRunCode instead.
 */
export async function generateRunCode(
  year: number,
  month: number,
  tx: Prisma.TransactionClient,
): Promise<string> {
  const base = `RUN-${year}-${String(month).padStart(2, '0')}`;
  // Original runs always carry a single code per month+year — no sequence needed.
  // The UNIQUE (month, year, reversalOfRunId) constraint enforces uniqueness.
  return base;
}

/**
 * Generate the reversal run code for the n-th reversal of a run.
 * First reversal = `<baseCode>-R1`, second = `<baseCode>-R2`, etc.
 *
 * @param sourceCode  The code of the original run (e.g. RUN-2026-05)
 * @param reversalCount  Number of prior reversals for this run (0 = first)
 */
export function generateReversalRunCode(sourceCode: string, reversalCount: number): string {
  return `${sourceCode}-R${reversalCount + 1}`;
}

// ── Payslip code ──────────────────────────────────────────────────────────────

/**
 * Generate the next P-YYYY-MM-NNNN payslip code inside the caller's transaction.
 * Uses a PayrollCodeCounter row (kind='payslip') with SELECT … FOR UPDATE.
 */
export async function generatePayslipCode(
  year: number,
  month: number,
  tx: Prisma.TransactionClient,
): Promise<string> {
  const prefix = `P-${year}-${String(month).padStart(2, '0')}-`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Upsert the counter row so it exists before we lock it.
    await tx.$executeRaw`
      INSERT INTO payroll_code_counters (id, year, month, kind, lastSeq)
      VALUES (${`psc-${year}-${month}`}, ${year}, ${month}, ${'payslip'}, 0)
      ON DUPLICATE KEY UPDATE year = year
    `;

    const rows = await tx.$queryRaw<Array<{ lastSeq: number }>>`
      SELECT lastSeq FROM payroll_code_counters
      WHERE year = ${year} AND month = ${month} AND kind = ${'payslip'}
      FOR UPDATE
    `;

    const current = rows[0]?.lastSeq ?? 0;
    const next = current + 1 + attempt;

    if (next > 9999) {
      throw new Error(`Payslip code sequence exhausted for ${year}-${month}`);
    }

    await tx.$executeRaw`
      UPDATE payroll_code_counters
      SET lastSeq = ${next}
      WHERE year = ${year} AND month = ${month} AND kind = ${'payslip'}
    `;

    const code = `${prefix}${String(next).padStart(4, '0')}`;

    const existing = await tx.payslip.findUnique({ where: { code } });
    if (!existing) {
      return code;
    }
  }

  throw new Error(
    `Could not generate a unique payslip code for ${year}-${month} after ${MAX_RETRIES} attempts`,
  );
}

/** Convenience wrapper for use outside a transaction. */
export async function generatePayslipCodeStandalone(year: number, month: number): Promise<string> {
  return defaultPrisma.$transaction((tx) => generatePayslipCode(year, month, tx));
}
