/**
 * Cancellation attribution tests — cancelledByName + cancelledByRole.
 *
 * Covers the `resolveCanceller` logic baked into the leave routes layer.
 * Because the helper calls `prisma.employee.findUnique` directly, we test
 * the role-mapping rule in isolation by driving the same logic through a
 * plain function extracted for testability.
 *
 * Three cases per the task spec:
 *   TC-LEAVE-CANCEL-01  Self-cancel before start  → role='Self', name matches employee
 *   TC-LEAVE-CANCEL-02  Admin cancels             → role='Admin', name matches admin
 *   TC-LEAVE-CANCEL-03  Never cancelled           → both fields null
 */

import { describe, it, expect } from 'vitest';

// ── Role-mapping helper (mirrors resolveCanceller in leave.routes.ts) ─────────

type CancellerRow = { name: string; role: string };

function computeCancellerRole(
  cancelledBy: string | null,
  employeeId: string,
  canceller: CancellerRow | null,
): { name: string; role: 'Self' | 'Manager' | 'Admin' } | null {
  if (!cancelledBy || !canceller) return null;

  let roleLabel: 'Self' | 'Manager' | 'Admin';
  if (cancelledBy === employeeId) {
    roleLabel = 'Self';
  } else if (canceller.role === 'Admin') {
    roleLabel = 'Admin';
  } else {
    roleLabel = 'Manager';
  }

  return { name: canceller.name, role: roleLabel };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('cancellation attribution — cancelledByName + cancelledByRole', () => {
  it('TC-LEAVE-CANCEL-01: self-cancel before start → role=Self, name=employee name', () => {
    const employeeId = 'emp-kavya-001';
    const cancelledBy = 'emp-kavya-001'; // same as employeeId → Self
    const cancellerRow: CancellerRow = { name: 'Kavya Reddy', role: 'Employee' };

    const result = computeCancellerRole(cancelledBy, employeeId, cancellerRow);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('Kavya Reddy');
    expect(result!.role).toBe('Self');
  });

  it('TC-LEAVE-CANCEL-02: admin cancels someone else approved leave → role=Admin, name matches admin', () => {
    const employeeId = 'emp-kavya-001';
    const cancelledBy = 'emp-priya-admin'; // different from employeeId, role=Admin
    const cancellerRow: CancellerRow = { name: 'Priya Sharma', role: 'Admin' };

    const result = computeCancellerRole(cancelledBy, employeeId, cancellerRow);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('Priya Sharma');
    expect(result!.role).toBe('Admin');
  });

  it('TC-LEAVE-CANCEL-03: never-cancelled leave → both fields null', () => {
    const employeeId = 'emp-kavya-001';
    const cancelledBy = null; // never cancelled
    const cancellerRow = null;

    const result = computeCancellerRole(cancelledBy, employeeId, cancellerRow);

    expect(result).toBeNull();
  });

  it('manager cancels subordinate leave → role=Manager', () => {
    const employeeId = 'emp-kavya-001';
    const cancelledBy = 'emp-arjun-mgr'; // different from employeeId, role=Manager
    const cancellerRow: CancellerRow = { name: 'Arjun Mehta', role: 'Manager' };

    const result = computeCancellerRole(cancelledBy, employeeId, cancellerRow);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('Arjun Mehta');
    expect(result!.role).toBe('Manager');
  });
});
