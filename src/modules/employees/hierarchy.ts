/**
 * Hierarchy helpers — BL-005 / BL-022 / BL-022a.
 *
 * Uses raw SQL with recursive CTEs because Prisma core does not support them
 * natively. All queries are parameterised — no string interpolation.
 */

import type { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../lib/prisma.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PastTeamMember {
  historyId: string;
  managerId: string | null;
  fromDate: Date;
  toDate: Date | null;
  reason: string;
  // Employee fields
  id: string;
  code: string;
  name: string;
  email: string;
  role: string;
  status: string;
  employmentType: string;
  department: string | null;
  designation: string | null;
  joinDate: Date;
}

// ── Subordinate IDs (recursive) ───────────────────────────────────────────────

/**
 * Return the IDs of ALL employees who directly or indirectly report to
 * `rootEmployeeId`, via a recursive CTE.
 *
 * Time-complexity: O(N) with the reporting tree; no caching — always fresh.
 */
export async function getSubordinateIds(
  rootEmployeeId: string,
  tx?: Prisma.TransactionClient,
): Promise<string[]> {
  const db = tx ?? defaultPrisma;

  // MySQL 8 supports recursive CTEs.
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE subordinates AS (
      -- Anchor: direct reports of the root employee
      SELECT id
      FROM employees
      WHERE reportingManagerId = ${rootEmployeeId}

      UNION ALL

      -- Recursive: reports of reports
      SELECT e.id
      FROM employees e
      INNER JOIN subordinates s ON e.reportingManagerId = s.id
    )
    SELECT id FROM subordinates
  `;

  return rows.map((r) => r.id);
}

// ── Cycle detection ──────────────────────────────────────────────────────────

/**
 * Returns true if setting `newManagerId` as the manager for `employeeId`
 * would create a circular reporting chain (BL-005).
 *
 * A cycle exists when `newManagerId` is already a subordinate (direct or
 * indirect) of `employeeId` — i.e. `employeeId` would end up reporting to
 * someone below them in the tree.
 */
export async function wouldCreateCycle(
  employeeId: string,
  newManagerId: string | null,
  tx?: Prisma.TransactionClient,
): Promise<boolean> {
  if (!newManagerId) return false;
  // If setting manager to self, that's circular too
  if (newManagerId === employeeId) return true;

  const subordinateIds = await getSubordinateIds(employeeId, tx);
  return subordinateIds.includes(newManagerId);
}

// ── Past team members ────────────────────────────────────────────────────────

/**
 * Return all closed ReportingManagerHistory rows where managerId = the given
 * manager, joined with their employee record.
 *
 * BL-022a: surfaced on GET /employees/{id}/team as the `past` array.
 * "Past" means the row has been closed (toDate IS NOT NULL).
 */
export async function getPastTeamMembers(
  managerId: string,
  tx?: Prisma.TransactionClient,
): Promise<PastTeamMember[]> {
  const db = tx ?? defaultPrisma;

  const rows = await db.$queryRaw<PastTeamMember[]>`
    SELECT
      rmh.id            AS historyId,
      rmh.managerId     AS managerId,
      rmh.fromDate      AS fromDate,
      rmh.toDate        AS toDate,
      rmh.reason        AS reason,
      e.id              AS id,
      e.code            AS code,
      e.name            AS name,
      e.email           AS email,
      e.role            AS role,
      e.status          AS status,
      e.employmentType  AS employmentType,
      e.department      AS department,
      e.designation     AS designation,
      e.joinDate        AS joinDate
    FROM reporting_manager_history rmh
    INNER JOIN employees e ON e.id = rmh.employeeId
    WHERE rmh.managerId = ${managerId}
      AND rmh.toDate IS NOT NULL
    ORDER BY rmh.toDate DESC
  `;

  return rows;
}
