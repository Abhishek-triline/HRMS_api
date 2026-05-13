/**
 * Regularisation code generator — Phase 3.
 *
 * Format: R-YYYY-NNNN (4-digit year, 4-digit zero-padded sequence).
 * Never reused. Mirrors leaveCode.ts from Phase 2.
 *
 * Concurrency: uses a dedicated RegCodeCounter row with SELECT…FOR UPDATE
 * (advisory lock) to serialise concurrent generation for the same year.
 * The DB UNIQUE constraint on regularisation_requests.code is the safety net.
 */

import type { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../lib/prisma.js';

const MAX_RETRIES = 3;

/**
 * Generate the next R-YYYY-NNNN regularisation code inside the caller's transaction.
 *
 * Uses the RegCodeCounter table with SELECT…FOR UPDATE to serialise
 * concurrent generation for the same year.
 */
export async function generateRegCode(
  year: number,
  tx: Prisma.TransactionClient,
): Promise<string> {
  const prefix = `R-${year}-`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Lock the counter row for this year; create at 0 if it does not exist yet.
    await tx.$executeRaw`
      INSERT INTO reg_code_counters (year, number)
      VALUES (${year}, 0)
      ON DUPLICATE KEY UPDATE year = year
    `;

    // SELECT … FOR UPDATE serialises concurrent code generation for the same year.
    const rows = await tx.$queryRaw<Array<{ number: number }>>`
      SELECT number FROM reg_code_counters
      WHERE year = ${year}
      FOR UPDATE
    `;

    const current = rows[0]?.number ?? 0;
    const next = current + 1 + attempt; // bump by attempt on retry

    if (next > 9999) {
      throw new Error(`Regularisation code sequence exhausted for year ${year}`);
    }

    await tx.$executeRaw`
      UPDATE reg_code_counters SET number = ${next} WHERE year = ${year}
    `;

    const code = `${prefix}${String(next).padStart(4, '0')}`;

    // Quick uniqueness check — the DB UNIQUE constraint is the hard guard.
    const existing = await tx.regularisationRequest.findUnique({ where: { code } });
    if (!existing) {
      return code;
    }
    // Collision — loop and try the next increment
  }

  throw new Error(
    `Could not generate a unique regularisation code for year ${year} after ${MAX_RETRIES} attempts`,
  );
}

/** Convenience wrapper for use outside a transaction (seeding, tests). */
export async function generateRegCodeStandalone(year: number): Promise<string> {
  return defaultPrisma.$transaction((tx) => generateRegCode(year, tx));
}
