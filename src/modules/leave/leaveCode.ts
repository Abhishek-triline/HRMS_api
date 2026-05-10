/**
 * Leave code generator — Phase 2.
 *
 * Format: L-YYYY-NNNN (4-digit year, 4-digit zero-padded sequence).
 * Never reused. Mirrors the EMP code generator pattern from empCode.ts.
 *
 * Concurrency: uses a dedicated LeaveCodeCounter row with SELECT…FOR UPDATE
 * (advisory lock) to serialise concurrent generation for the same year.
 * The DB UNIQUE constraint on leave_requests.code is the safety net.
 */

import type { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../lib/prisma.js';

const MAX_RETRIES = 3;

/**
 * Generate the next L-YYYY-NNNN leave code inside the caller's transaction.
 *
 * Uses the LeaveCodeCounter table with SELECT…FOR UPDATE to serialise
 * concurrent generation for the same year.
 */
export async function generateLeaveCode(
  year: number,
  tx: Prisma.TransactionClient,
): Promise<string> {
  const prefix = `L-${year}-`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Lock the counter row for this year; create at 0 if it does not exist yet.
    await tx.$executeRaw`
      INSERT INTO leave_code_counters (year, lastSeq)
      VALUES (${year}, 0)
      ON DUPLICATE KEY UPDATE year = year
    `;

    // SELECT … FOR UPDATE serialises concurrent code generation for the same year.
    const rows = await tx.$queryRaw<Array<{ lastSeq: number }>>`
      SELECT lastSeq FROM leave_code_counters
      WHERE year = ${year}
      FOR UPDATE
    `;

    const current = rows[0]?.lastSeq ?? 0;
    const next = current + 1 + attempt; // bump by attempt on retry

    if (next > 9999) {
      throw new Error(`Leave code sequence exhausted for year ${year}`);
    }

    await tx.$executeRaw`
      UPDATE leave_code_counters SET lastSeq = ${next} WHERE year = ${year}
    `;

    const code = `${prefix}${String(next).padStart(4, '0')}`;

    // Quick uniqueness check — the DB UNIQUE constraint is the hard guard.
    const existing = await tx.leaveRequest.findUnique({ where: { code } });
    if (!existing) {
      return code;
    }
    // Collision — loop and try the next increment
  }

  throw new Error(
    `Could not generate a unique leave code for year ${year} after ${MAX_RETRIES} attempts`,
  );
}

/** Convenience wrapper for use outside a transaction (seeding, tests). */
export async function generateLeaveCodeStandalone(year: number): Promise<string> {
  return defaultPrisma.$transaction((tx) => generateLeaveCode(year, tx));
}
