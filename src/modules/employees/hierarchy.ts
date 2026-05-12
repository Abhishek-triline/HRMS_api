/**
 * Hierarchy helpers — BL-005 / BL-022 / BL-022a (v2 INT IDs).
 *
 * Uses raw SQL with recursive CTEs because Prisma core does not support them
 * natively. All queries are parameterised — no string interpolation.
 */

import type { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../lib/prisma.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PastTeamMember {
  historyId: number;
  managerId: number | null;
  fromDate: Date;
  toDate: Date | null;
  reasonId: number;
  // Employee fields
  id: number;
  code: string;
  name: string;
  email: string;
  roleId: number;
  status: number;
  employmentTypeId: number;
  departmentId: number | null;
  department: string | null;
  designationId: number | null;
  designation: string | null;
  joinDate: Date;
}

// ── Subordinate IDs (recursive) ───────────────────────────────────────────────

/**
 * Return the IDs of ALL employees who directly or indirectly report to
 * `rootEmployeeId`, via a recursive CTE.
 */
export async function getSubordinateIds(
  rootEmployeeId: number,
  tx?: Prisma.TransactionClient,
): Promise<number[]> {
  const db = tx ?? defaultPrisma;

  // MySQL 8 supports recursive CTEs.
  const rows = await db.$queryRaw<Array<{ id: number }>>`
    WITH RECURSIVE subordinates AS (
      SELECT id
      FROM employees
      WHERE reporting_manager_id = ${rootEmployeeId}

      UNION ALL

      SELECT e.id
      FROM employees e
      INNER JOIN subordinates s ON e.reporting_manager_id = s.id
    )
    SELECT id FROM subordinates
  `;

  return rows.map((r) => r.id);
}

// ── Cycle detection ──────────────────────────────────────────────────────────

/**
 * Returns true if setting `newManagerId` as the manager for `employeeId`
 * would create a circular reporting chain (BL-005).
 */
export async function wouldCreateCycle(
  employeeId: number,
  newManagerId: number | null,
  tx?: Prisma.TransactionClient,
): Promise<boolean> {
  if (!newManagerId) return false;
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
 */
export async function getPastTeamMembers(
  managerId: number,
  tx?: Prisma.TransactionClient,
): Promise<PastTeamMember[]> {
  const db = tx ?? defaultPrisma;

  const rows = await db.$queryRaw<PastTeamMember[]>`
    SELECT
      rmh.id            AS historyId,
      rmh.manager_id    AS managerId,
      rmh.from_date     AS fromDate,
      rmh.to_date       AS toDate,
      rmh.reason_id     AS reasonId,
      e.id              AS id,
      e.code            AS code,
      e.name            AS name,
      e.email           AS email,
      e.role_id         AS roleId,
      e.status          AS status,
      e.employment_type_id AS employmentTypeId,
      e.department_id   AS departmentId,
      e.designation_id  AS designationId,
      e.join_date       AS joinDate
    FROM reporting_manager_history rmh
    INNER JOIN employees e ON e.id = rmh.employee_id
    WHERE rmh.manager_id = ${managerId}
      AND rmh.to_date IS NOT NULL
    ORDER BY rmh.to_date DESC
  `;

  return rows;
}
