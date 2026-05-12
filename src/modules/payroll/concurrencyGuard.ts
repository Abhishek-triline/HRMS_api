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
  id: number;
  status: number;
  version: number;
  finalisedBy: number | null;
  finalisedAt: Date | null;
}

/**
 * Acquire a row-level lock on the PayrollRun with the given id.
 *
 * Must be called inside a Prisma interactive transaction (NOT a batch
 * $transaction). Returns the row data post-lock so the caller can
 * inspect the current status before proceeding.
 *
 * SQL used: SELECT id, status, version, finalised_by, finalised_at
 *           FROM payroll_runs WHERE id = ? FOR UPDATE
 *
 * MySQL compatibility: FOR UPDATE is supported in InnoDB (the default MySQL
 * storage engine). The lock is released when the surrounding transaction
 * commits or rolls back.
 *
 * Note: $queryRaw returns raw MySQL column names (snake_case). The result is
 * cast to LockedRunRow; numeric columns come back as number from mysql2 driver.
 */
export async function acquireRunLock(
  runId: number,
  tx: Prisma.TransactionClient,
): Promise<LockedRunRow | null> {
  const rows = await tx.$queryRaw<Array<{
    id: number;
    status: number;
    version: number;
    finalised_by: number | null;
    finalised_at: Date | null;
  }>>`
    SELECT id, status, version, finalised_by, finalised_at
    FROM payroll_runs
    WHERE id = ${runId}
    FOR UPDATE
  `;

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    status: row.status,
    version: row.version,
    finalisedBy: row.finalised_by,
    finalisedAt: row.finalised_at,
  };
}
