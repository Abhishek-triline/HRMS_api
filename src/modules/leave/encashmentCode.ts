/**
 * Encashment code generator.
 *
 * Format: LE-YYYY-NNNN (4-digit year, 4-digit zero-padded sequence).
 * Never reused. Mirrors the leaveCode.ts pattern.
 *
 * Concurrency: uses a dedicated EncashmentCodeCounter row with SELECT…FOR UPDATE.
 */

import type { Prisma } from '@prisma/client';

const MAX_RETRIES = 3;

/**
 * Generate the next LE-YYYY-NNNN encashment code inside the caller's transaction.
 */
export async function generateEncashmentCode(
  year: number,
  tx: Prisma.TransactionClient,
): Promise<string> {
  const prefix = `LE-${year}-`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Ensure counter row exists
    await tx.$executeRaw`
      INSERT INTO encashment_code_counters (year, lastSeq)
      VALUES (${year}, 0)
      ON DUPLICATE KEY UPDATE year = year
    `;

    const rows = await tx.$queryRaw<Array<{ lastSeq: number }>>`
      SELECT lastSeq FROM encashment_code_counters
      WHERE year = ${year}
      FOR UPDATE
    `;

    const current = rows[0]?.lastSeq ?? 0;
    const next = current + 1 + attempt;

    if (next > 9999) {
      throw new Error(`Encashment code sequence exhausted for year ${year}`);
    }

    await tx.$executeRaw`
      UPDATE encashment_code_counters SET lastSeq = ${next} WHERE year = ${year}
    `;

    const code = `${prefix}${String(next).padStart(4, '0')}`;

    const existing = await tx.leaveEncashment.findUnique({ where: { code } });
    if (!existing) {
      return code;
    }
  }

  throw new Error(
    `Could not generate a unique encashment code for year ${year} after ${MAX_RETRIES} attempts`,
  );
}
