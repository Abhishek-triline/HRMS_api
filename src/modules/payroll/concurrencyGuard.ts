/**
 * Concurrency guard for payroll run finalisation — BL-034.
 *
 * MySQL-compatible row-level lock using SELECT … FOR UPDATE.
 * Only one transaction can hold the lock on a given run row at a time.
 * The second concurrent finalise caller sees status='Finalised' when it
 * re-reads the row inside the lock and returns 409 RUN_ALREADY_FINALISED.
 */

import type { Prisma } from '@prisma/client';

export interface LockedRunRow {
  id: string;
  status: string;
  version: number;
  finalisedBy: string | null;
  finalisedAt: Date | null;
}

/**
 * Acquire a row-level lock on the PayrollRun with the given id.
 *
 * Must be called inside a Prisma interactive transaction (NOT a batch
 * $transaction). Returns the row data post-lock so the caller can
 * inspect the current status before proceeding.
 *
 * SQL used: SELECT id, status, version, finalisedBy, finalisedAt
 *           FROM payroll_runs WHERE id = ? FOR UPDATE
 *
 * MySQL compatibility: FOR UPDATE is supported in InnoDB (the default MySQL
 * storage engine). The lock is released when the surrounding transaction
 * commits or rolls back.
 */
export async function acquireRunLock(
  runId: string,
  tx: Prisma.TransactionClient,
): Promise<LockedRunRow | null> {
  const rows = await tx.$queryRaw<LockedRunRow[]>`
    SELECT id, status, version, finalisedBy, finalisedAt
    FROM payroll_runs
    WHERE id = ${runId}
    FOR UPDATE
  `;

  return rows[0] ?? null;
}
