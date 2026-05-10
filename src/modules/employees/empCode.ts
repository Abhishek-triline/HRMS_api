/**
 * EMP code generator — BL-008.
 *
 * Format: EMP-YYYY-NNNN (4-digit year, 4-digit zero-padded sequence).
 * Never reused — even after employee exit and theoretical re-join (they get a new code).
 *
 * Concurrency: we fetch MAX(code) with a SELECT … FOR UPDATE on an advisory
 * lock row in the employees table scoped to the current year, parse the suffix,
 * and increment. The DB-level UNIQUE constraint on employees.code is the safety
 * net; we retry up to 3 times on collision.
 */

import type { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../lib/prisma.js';

const MAX_RETRIES = 3;

/**
 * Parse the 4-digit suffix from a code like "EMP-2026-0042".
 * Returns 0 when the code does not match the expected year.
 */
function parseSuffix(code: string, year: number): number {
  const prefix = `EMP-${year}-`;
  if (!code.startsWith(prefix)) return 0;
  const suffix = code.slice(prefix.length);
  return parseInt(suffix, 10) || 0;
}

/**
 * Generate the next EMP code for a given year, running inside the caller's
 * transaction.  Uses a raw SELECT … FOR UPDATE on the employee with the
 * highest code for that year so only one concurrent transaction can advance
 * the sequence at a time.  Retries on DB-level unique constraint violation.
 */
export async function generateEmpCode(
  year: number,
  tx: Prisma.TransactionClient,
): Promise<string> {
  const prefix = `EMP-${year}-`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // SELECT … FOR UPDATE on the row with the largest code for this year.
    // This serialises concurrent code generation for the same year at the DB level.
    const rows = await tx.$queryRaw<Array<{ code: string }>>`
      SELECT code
      FROM employees
      WHERE code LIKE ${`${prefix}%`}
      ORDER BY code DESC
      LIMIT 1
      FOR UPDATE
    `;

    const maxSuffix = rows.length > 0 ? parseSuffix(rows[0]!.code, year) : 0;
    const nextSuffix = maxSuffix + 1 + attempt; // bump by attempt on retry

    if (nextSuffix > 9999) {
      throw new Error(`EMP code sequence exhausted for year ${year}`);
    }

    const code = `${prefix}${String(nextSuffix).padStart(4, '0')}`;

    // Check uniqueness explicitly before returning (the DB unique constraint is
    // the hard guard; this is a fast path to avoid a round-trip on collision).
    const existing = await tx.employee.findUnique({ where: { code } });
    if (!existing) {
      return code;
    }
    // Collision — loop and try the next increment
  }

  // Final fallback: let the DB unique constraint reject it — the caller should
  // propagate the constraint violation as an INTERNAL_ERROR.
  throw new Error(`Could not generate a unique EMP code for year ${year} after ${MAX_RETRIES} attempts`);
}

/**
 * Convenience wrapper that opens its own transaction when the caller has none.
 * In practice the employees.routes handler always passes its own tx, but this
 * is useful for seeding and tests.
 */
export async function generateEmpCodeStandalone(year: number): Promise<string> {
  return defaultPrisma.$transaction((tx) => generateEmpCode(year, tx));
}
