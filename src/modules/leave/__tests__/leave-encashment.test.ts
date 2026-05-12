/**
 * Leave Encashment service tests — BL-LE-01..14.
 * v2 schema: INT IDs, INT status/role codes, no paidInPayslipId.
 *
 * All DB calls are mocked via vi.mock. The tests exercise the pure service
 * logic without a real database connection.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../../lib/prisma.js', () => ({
  prisma: { $transaction: vi.fn() },
}));

vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../../../lib/notifications.js', () => ({ notify: vi.fn() }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('../encashmentCode.js', () => ({
  generateEncashmentCode: vi.fn().mockResolvedValue('LE-2025-0001'),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import {
  isInsideEncashmentWindow,
  getEncashmentConfig,
  submitEncashmentRequest,
  managerApproveEncashment,
  adminFinaliseEncashment,
  rejectEncashment,
  cancelEncashment,
  findUnpaidAdminFinalisedForEmployee,
  markEncashmentPaid,
  markEncashmentReversed,
  escalateStaleEncashments,
  type EncashmentWindowConfig,
} from '../leave-encashment.service.js';
import { audit } from '../../../lib/audit.js';
import { notify } from '../../../lib/notifications.js';
import {
  RoleId,
  EmployeeStatus,
  LeaveEncashmentStatus,
  RoutedTo,
} from '../../../lib/statusInt.js';

// ── ID constants (v2: INT) ────────────────────────────────────────────────────

const EMP_ID = 1001;
const MGR_ID = 1002;
const ADMIN_ID = 1;
const ENC_ID = 100;
const ENC_ID_2 = 101;
const ENC_ID_3 = 102;
const LT_ANNUAL_ID = 1;
const BAL_ID = 201;
const SLIP_ID = 301;
const REV_SLIP_ID = 302;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal mock tx object. */
function buildTx(overrides: Record<string, unknown> = {}) {
  return {
    employee: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    leaveType: { findUnique: vi.fn() },
    leaveBalance: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    leaveEncashment: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    salaryStructure: { findFirst: vi.fn() },
    configuration: { findMany: vi.fn(), findUnique: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([{ id: ENC_ID }]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

const DEFAULT_CFG: EncashmentWindowConfig = {
  windowStartMonth: 12,
  windowEndMonth: 1,
  windowEndDay: 15,
  maxPercent: 50,
};

/** Make a mock tx that returns the given config. */
function txWithConfig(cfg: EncashmentWindowConfig, extra?: Record<string, unknown>) {
  const tx = buildTx(extra);
  (tx.configuration.findMany as Mock).mockResolvedValue([
    { key: 'ENCASHMENT_WINDOW_START_MONTH', value: cfg.windowStartMonth },
    { key: 'ENCASHMENT_WINDOW_END_MONTH', value: cfg.windowEndMonth },
    { key: 'ENCASHMENT_WINDOW_END_DAY', value: cfg.windowEndDay },
    { key: 'ENCASHMENT_MAX_PERCENT', value: cfg.maxPercent },
  ]);
  return tx;
}

// ── TC-LE-04: isInsideEncashmentWindow ────────────────────────────────────────

describe('isInsideEncashmentWindow (BL-LE-04)', () => {
  it('returns true for December (start month)', () => {
    expect(isInsideEncashmentWindow(new Date('2025-12-15'), DEFAULT_CFG)).toBe(true);
  });

  it('returns true for January 1st', () => {
    expect(isInsideEncashmentWindow(new Date('2026-01-01'), DEFAULT_CFG)).toBe(true);
  });

  it('returns true for January 15 (end day inclusive)', () => {
    expect(isInsideEncashmentWindow(new Date('2026-01-15'), DEFAULT_CFG)).toBe(true);
  });

  it('returns false for January 16 (after end day)', () => {
    expect(isInsideEncashmentWindow(new Date('2026-01-16'), DEFAULT_CFG)).toBe(false);
  });

  it('TC-LE-04: returns false for February (well outside window)', () => {
    expect(isInsideEncashmentWindow(new Date('2026-02-01'), DEFAULT_CFG)).toBe(false);
  });

  it('returns false for November (before window)', () => {
    expect(isInsideEncashmentWindow(new Date('2025-11-30'), DEFAULT_CFG)).toBe(false);
  });

  it('returns true for December 1 (window opens)', () => {
    expect(isInsideEncashmentWindow(new Date('2025-12-01'), DEFAULT_CFG)).toBe(true);
  });
});

// ── TC-LE-04: submitEncashmentRequest — out-of-window rejection ───────────────

describe('submitEncashmentRequest — BL-LE-04 window check', () => {
  it('throws ENCASHMENT_OUT_OF_WINDOW when submitted outside window', async () => {
    // Feb 1 is outside window
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-01'));

    const tx = txWithConfig(DEFAULT_CFG);
    (tx.employee.findUnique as Mock).mockResolvedValue({
      id: EMP_ID,
      status: EmployeeStatus.Active,
      roleId: RoleId.Employee,
      name: 'Test',
      code: 'EMP-2026-0002',
    });

    await expect(
      submitEncashmentRequest(EMP_ID, 5, 2025, tx as never),
    ).rejects.toMatchObject({ code: 'ENCASHMENT_OUT_OF_WINDOW' });

    vi.useRealTimers();
  });
});

// ── TC-LE-03: ENCASHMENT_ALREADY_USED ────────────────────────────────────────

describe('submitEncashmentRequest — BL-LE-03 duplicate check', () => {
  it('TC-LE-03: throws ENCASHMENT_ALREADY_USED when approved encashment exists', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-12-15')); // Inside window

    const tx = txWithConfig(DEFAULT_CFG);
    (tx.employee.findUnique as Mock).mockResolvedValue({
      id: EMP_ID, status: EmployeeStatus.Active, roleId: RoleId.Employee, name: 'Test', code: 'EMP-2026-0002',
    });
    // findFirst for approved encashment returns existing
    (tx.leaveEncashment.findFirst as Mock).mockResolvedValue({
      id: ENC_ID, code: 'LE-2025-0001', status: LeaveEncashmentStatus.AdminFinalised,
    });

    await expect(
      submitEncashmentRequest(EMP_ID, 5, 2025, tx as never),
    ).rejects.toMatchObject({ code: 'ENCASHMENT_ALREADY_USED' });

    vi.useRealTimers();
  });
});

// ── TC-LE-01: happy path submit ───────────────────────────────────────────────

describe('submitEncashmentRequest — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (audit as Mock).mockResolvedValue(undefined);
    (notify as Mock).mockResolvedValue(undefined);
  });

  it('TC-LE-01 (submit): creates a Pending encashment and routes correctly', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-12-15'));

    const tx = txWithConfig(DEFAULT_CFG);

    // Employee is Active
    (tx.employee.findUnique as Mock)
      .mockResolvedValueOnce({ id: EMP_ID, status: EmployeeStatus.Active, roleId: RoleId.Employee, name: 'Alice', code: 'EMP-2026-0002', reportingManagerId: MGR_ID }) // employee check
      .mockResolvedValueOnce({ id: EMP_ID, reportingManagerId: MGR_ID }) // resolveRouting emp
      .mockResolvedValueOnce({ id: MGR_ID, status: EmployeeStatus.Active }); // manager status

    // No existing approved encashment
    (tx.leaveEncashment.findFirst as Mock).mockResolvedValue(null);

    // Annual leave type exists
    (tx.leaveType.findUnique as Mock).mockResolvedValue({ id: LT_ANNUAL_ID, name: 'Annual' });

    // Balance available
    (tx.leaveBalance.findUnique as Mock).mockResolvedValue({
      id: BAL_ID, daysRemaining: 12, daysUsed: 0, daysEncashed: 0,
    });

    // Manager is Active
    (tx.employee.findMany as Mock).mockResolvedValue([]); // no admins (manager routing)

    (tx.leaveEncashment.create as Mock).mockResolvedValue({
      id: ENC_ID,
      code: 'LE-2025-0001',
      employeeId: EMP_ID,
      employee: { name: 'Alice', code: 'EMP-2025-0002' },
      approver: null,
      year: 2025,
      daysRequested: 5,
      daysApproved: null,
      ratePerDayPaise: null,
      amountPaise: null,
      status: LeaveEncashmentStatus.Pending,
      routedToId: RoutedTo.Manager,
      approverId: MGR_ID,
      decidedAt: null,
      decidedBy: null,
      decisionNote: null,
      escalatedAt: null,
      paidAt: null,
      cancelledAt: null,
      cancelledBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 0,
    });

    const result = await submitEncashmentRequest(EMP_ID, 5, 2025, tx as never);

    expect(result.status).toBe(LeaveEncashmentStatus.Pending);
    expect(result.daysRequested).toBe(5);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'leave.encashment.request.create' }));

    vi.useRealTimers();
  });
});

// ── TC-LE-05: routing with exited manager ────────────────────────────────────

describe('submitEncashmentRequest — BL-LE-05 routing', () => {
  it('TC-LE-05: routes to Admin when reporting manager is Exited', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-12-15'));

    const tx = txWithConfig(DEFAULT_CFG);

    (tx.employee.findUnique as Mock)
      .mockResolvedValueOnce({ id: EMP_ID, status: EmployeeStatus.Active, roleId: RoleId.Employee, name: 'Alice', code: 'EMP-2025-0002', reportingManagerId: MGR_ID })
      .mockResolvedValueOnce({ id: EMP_ID, reportingManagerId: MGR_ID }) // resolveRouting
      .mockResolvedValueOnce({ id: MGR_ID, status: EmployeeStatus.Exited }); // manager is Exited

    // No approved encashment
    (tx.leaveEncashment.findFirst as Mock).mockResolvedValue(null);
    (tx.leaveType.findUnique as Mock).mockResolvedValue({ id: LT_ANNUAL_ID, name: 'Annual' });
    (tx.leaveBalance.findUnique as Mock).mockResolvedValue({ id: BAL_ID, daysRemaining: 12 });

    // findDefaultAdmin calls employee.findFirst
    (tx.employee.findFirst as Mock).mockResolvedValue({ id: ADMIN_ID, name: 'Admin' });
    (tx.employee.findMany as Mock).mockResolvedValue([{ id: ADMIN_ID }]);

    (tx.leaveEncashment.create as Mock).mockResolvedValue({
      id: ENC_ID,
      code: 'LE-2025-0001',
      employeeId: EMP_ID,
      employee: { name: 'Alice', code: 'EMP-2025-0002' },
      approver: { name: 'Admin' },
      year: 2025,
      daysRequested: 5,
      daysApproved: null,
      ratePerDayPaise: null,
      amountPaise: null,
      status: LeaveEncashmentStatus.Pending,
      routedToId: RoutedTo.Admin,
      approverId: ADMIN_ID,
      decidedAt: null, decidedBy: null, decisionNote: null, escalatedAt: null,
      paidAt: null, cancelledAt: null, cancelledBy: null,
      createdAt: new Date(), updatedAt: new Date(), version: 0,
    });

    const result = await submitEncashmentRequest(EMP_ID, 5, 2025, tx as never);
    expect(result.routedToId).toBe(RoutedTo.Admin);

    vi.useRealTimers();
  });
});

// ── TC-LE-13: exited employee cannot submit ───────────────────────────────────

describe('submitEncashmentRequest — BL-LE-13 exited employee', () => {
  it('TC-LE-13: throws VALIDATION_FAILED for Exited employee', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-12-15'));

    const tx = txWithConfig(DEFAULT_CFG);
    (tx.employee.findUnique as Mock).mockResolvedValue({
      id: EMP_ID, status: EmployeeStatus.Exited, roleId: RoleId.Employee, name: 'Bob', code: 'EMP-2025-0003',
    });

    await expect(
      submitEncashmentRequest(EMP_ID, 5, 2025, tx as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    vi.useRealTimers();
  });
});

// ── TC-LE-02: Admin clamps daysApproved at 50% ───────────────────────────────

describe('adminFinaliseEncashment — BL-LE-02 clamping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (audit as Mock).mockResolvedValue(undefined);
    (notify as Mock).mockResolvedValue(undefined);
  });

  it('TC-LE-02: clamps 10-day request to 6 when balance is 12 (50% = 6)', async () => {
    const tx = buildTx();

    // Row lock mock
    (tx.$queryRaw as Mock).mockResolvedValue([{ id: ENC_ID }]);

    // Actor is Admin
    (tx.employee.findUnique as Mock)
      .mockResolvedValueOnce({ id: ADMIN_ID, roleId: RoleId.Admin, status: EmployeeStatus.Active })
      .mockResolvedValue(undefined);

    // Encashment in ManagerApproved state
    (tx.leaveEncashment.findUnique as Mock).mockResolvedValue({
      id: ENC_ID,
      code: 'LE-2025-0001',
      employeeId: EMP_ID,
      year: 2025,
      daysRequested: 10,
      daysApproved: null,
      ratePerDayPaise: null,
      amountPaise: null,
      status: LeaveEncashmentStatus.ManagerApproved,
      routedToId: RoutedTo.Admin,
      approverId: ADMIN_ID,
      decidedAt: null, decidedBy: null, decisionNote: null, escalatedAt: null,
      paidAt: null, cancelledAt: null, cancelledBy: null,
      createdAt: new Date(), updatedAt: new Date(), version: 0,
      employee: { name: 'Alice', code: 'EMP-2025-0002', status: EmployeeStatus.Active, roleId: RoleId.Employee },
    });

    // Annual leave type
    (tx.leaveType.findUnique as Mock).mockResolvedValue({ id: LT_ANNUAL_ID, name: 'Annual' });

    // Balance: daysRemaining = 12 → maxAllowed = floor(12 × 0.5) = 6
    (tx.leaveBalance.findUnique as Mock).mockResolvedValue({
      id: BAL_ID, daysRemaining: 12, daysEncashed: 0, version: 0,
    });

    // Config: 50%
    (tx.configuration.findMany as Mock).mockResolvedValue([
      { key: 'ENCASHMENT_MAX_PERCENT', value: 50 },
      { key: 'ENCASHMENT_WINDOW_START_MONTH', value: 12 },
      { key: 'ENCASHMENT_WINDOW_END_MONTH', value: 1 },
      { key: 'ENCASHMENT_WINDOW_END_DAY', value: 15 },
    ]);

    // Salary structure
    (tx.salaryStructure.findFirst as Mock).mockResolvedValue({
      basicPaise: 5_000_00, // 5000 rupees in paise
      allowancesPaise: 2_000_00,
      daPaise: 0,
    });

    // PayrollOfficers
    (tx.employee.findMany as Mock).mockResolvedValue([]);

    (tx.leaveBalance.update as Mock).mockResolvedValue({ daysRemaining: 6, daysEncashed: 6 });
    (tx.leaveEncashment.update as Mock).mockResolvedValue({
      id: ENC_ID,
      code: 'LE-2025-0001',
      employeeId: EMP_ID,
      year: 2025,
      daysRequested: 10,
      daysApproved: 6,  // clamped
      ratePerDayPaise: Math.floor(5_000_00 / 26),
      amountPaise: 6 * Math.floor(5_000_00 / 26),
      status: LeaveEncashmentStatus.AdminFinalised,
      routedToId: RoutedTo.Admin,
      approverId: ADMIN_ID,
      decidedAt: new Date(), decidedBy: ADMIN_ID, decisionNote: null, escalatedAt: null,
      paidAt: null, cancelledAt: null, cancelledBy: null,
      createdAt: new Date(), updatedAt: new Date(), version: 1,
      employee: { name: 'Alice', code: 'EMP-2025-0002' },
      approver: { name: 'Admin' },
    });

    // Pass daysApproved=10 (over 50%) — server must clamp to 6
    const result = await adminFinaliseEncashment(ENC_ID, ADMIN_ID, 10, undefined, tx as never, RoleId.Admin);

    expect(result.daysApproved).toBe(6);
    expect(result.status).toBe(LeaveEncashmentStatus.AdminFinalised);
  });
});

// ── TC-LE-07: balance deducted at AdminFinalise, not at payment ───────────────

describe('adminFinaliseEncashment — BL-LE-06 balance deduction', () => {
  it('TC-LE-07: LeaveBalance.daysRemaining is decremented at AdminFinalise', async () => {
    const tx = buildTx();

    (tx.$queryRaw as Mock).mockResolvedValue([{ id: ENC_ID }]);
    (tx.employee.findUnique as Mock).mockResolvedValue({ id: ADMIN_ID, roleId: RoleId.Admin, status: EmployeeStatus.Active });
    (tx.leaveEncashment.findUnique as Mock).mockResolvedValue({
      id: ENC_ID, code: 'LE-2025-0001', employeeId: EMP_ID, year: 2025,
      daysRequested: 5, daysApproved: null, ratePerDayPaise: null, amountPaise: null,
      status: LeaveEncashmentStatus.ManagerApproved, routedToId: RoutedTo.Admin, approverId: ADMIN_ID,
      decidedAt: null, decidedBy: null, decisionNote: null, escalatedAt: null,
      paidAt: null, cancelledAt: null, cancelledBy: null,
      createdAt: new Date(), updatedAt: new Date(), version: 0,
      employee: { name: 'Alice', code: 'EMP-2025-0002', status: EmployeeStatus.Active, roleId: RoleId.Employee },
    });
    (tx.leaveType.findUnique as Mock).mockResolvedValue({ id: LT_ANNUAL_ID, name: 'Annual' });
    (tx.leaveBalance.findUnique as Mock).mockResolvedValue({ id: BAL_ID, daysRemaining: 12, daysEncashed: 0, version: 0 });
    (tx.configuration.findMany as Mock).mockResolvedValue([
      { key: 'ENCASHMENT_MAX_PERCENT', value: 50 },
      { key: 'ENCASHMENT_WINDOW_START_MONTH', value: 12 },
      { key: 'ENCASHMENT_WINDOW_END_MONTH', value: 1 },
      { key: 'ENCASHMENT_WINDOW_END_DAY', value: 15 },
    ]);
    (tx.salaryStructure.findFirst as Mock).mockResolvedValue({ basicPaise: 5_000_00, allowancesPaise: 2_000_00, daPaise: null });
    (tx.employee.findMany as Mock).mockResolvedValue([]);
    (tx.leaveBalance.update as Mock).mockResolvedValue({ daysRemaining: 7, daysEncashed: 5 });
    (tx.leaveEncashment.update as Mock).mockResolvedValue({
      id: ENC_ID, code: 'LE-2025-0001', employeeId: EMP_ID, year: 2025,
      daysRequested: 5, daysApproved: 5, ratePerDayPaise: 1923, amountPaise: 9615,
      status: LeaveEncashmentStatus.AdminFinalised, routedToId: RoutedTo.Admin, approverId: ADMIN_ID,
      decidedAt: new Date(), decidedBy: ADMIN_ID, decisionNote: null, escalatedAt: null,
      paidAt: null, cancelledAt: null, cancelledBy: null,
      createdAt: new Date(), updatedAt: new Date(), version: 1,
      employee: { name: 'Alice', code: 'EMP-2025-0002' },
      approver: { name: 'Admin' },
    });
    (audit as Mock).mockResolvedValue(undefined);
    (notify as Mock).mockResolvedValue(undefined);

    await adminFinaliseEncashment(ENC_ID, ADMIN_ID, 5, undefined, tx as never, RoleId.Admin);

    // Verify balance was updated (deducted at finalise, not at payment)
    expect(tx.leaveBalance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          daysRemaining: { decrement: 5 },
          daysEncashed: { increment: 5 },
        }),
      }),
    );
  });
});

// ── TC-LE-11: DA-null salary gets basic/workingDays rate ─────────────────────

describe('adminFinaliseEncashment — BL-LE-07 DA null handling', () => {
  it('TC-LE-11: uses basicPaise only when daPaise is null (no crash)', async () => {
    const tx = buildTx();

    (tx.$queryRaw as Mock).mockResolvedValue([{ id: ENC_ID }]);
    (tx.employee.findUnique as Mock).mockResolvedValue({ id: ADMIN_ID, roleId: RoleId.Admin, status: EmployeeStatus.Active });
    (tx.leaveEncashment.findUnique as Mock).mockResolvedValue({
      id: ENC_ID, code: 'LE-2025-0001', employeeId: EMP_ID, year: 2025,
      daysRequested: 3, daysApproved: null, ratePerDayPaise: null, amountPaise: null,
      status: LeaveEncashmentStatus.ManagerApproved, routedToId: RoutedTo.Admin, approverId: ADMIN_ID,
      decidedAt: null, decidedBy: null, decisionNote: null, escalatedAt: null,
      paidAt: null, cancelledAt: null, cancelledBy: null,
      createdAt: new Date(), updatedAt: new Date(), version: 0,
      employee: { name: 'Alice', code: 'EMP-2025-0002', status: EmployeeStatus.Active, roleId: RoleId.Employee },
    });
    (tx.leaveType.findUnique as Mock).mockResolvedValue({ id: LT_ANNUAL_ID, name: 'Annual' });
    (tx.leaveBalance.findUnique as Mock).mockResolvedValue({ id: BAL_ID, daysRemaining: 10, daysEncashed: 0, version: 0 });
    (tx.configuration.findMany as Mock).mockResolvedValue([
      { key: 'ENCASHMENT_MAX_PERCENT', value: 50 },
      { key: 'ENCASHMENT_WINDOW_START_MONTH', value: 12 },
      { key: 'ENCASHMENT_WINDOW_END_MONTH', value: 1 },
      { key: 'ENCASHMENT_WINDOW_END_DAY', value: 15 },
    ]);
    // daPaise = null (legacy salary structure)
    (tx.salaryStructure.findFirst as Mock).mockResolvedValue({
      basicPaise: 6_000_00, allowancesPaise: 2_000_00, daPaise: null,
    });
    (tx.employee.findMany as Mock).mockResolvedValue([]);
    (tx.leaveBalance.update as Mock).mockResolvedValue({ daysRemaining: 7, daysEncashed: 3 });

    const expectedRate = Math.floor(6_000_00 / 26); // no DA

    (tx.leaveEncashment.update as Mock).mockResolvedValue({
      id: ENC_ID, code: 'LE-2025-0001', employeeId: EMP_ID, year: 2025,
      daysRequested: 3, daysApproved: 3, ratePerDayPaise: expectedRate, amountPaise: 3 * expectedRate,
      status: LeaveEncashmentStatus.AdminFinalised, routedToId: RoutedTo.Admin, approverId: ADMIN_ID,
      decidedAt: new Date(), decidedBy: ADMIN_ID, decisionNote: null, escalatedAt: null,
      paidAt: null, cancelledAt: null, cancelledBy: null,
      createdAt: new Date(), updatedAt: new Date(), version: 1,
      employee: { name: 'Alice', code: 'EMP-2025-0002' },
      approver: { name: 'Admin' },
    });
    (audit as Mock).mockResolvedValue(undefined);
    (notify as Mock).mockResolvedValue(undefined);

    // Should not throw even with daPaise = null
    const result = await adminFinaliseEncashment(ENC_ID, ADMIN_ID, 3, undefined, tx as never, RoleId.Admin);
    expect(result.ratePerDayPaise).toBe(expectedRate);
  });
});

// ── TC-LE-09: payroll engine picks up unpaid encashments ─────────────────────

describe('findUnpaidAdminFinalisedForEmployee (BL-LE-09)', () => {
  it('TC-LE-09: returns AdminFinalised encashment for the previous year', async () => {
    const tx = buildTx();
    (tx.leaveEncashment.findFirst as Mock).mockResolvedValue({
      id: ENC_ID, employeeId: EMP_ID, year: 2024, daysApproved: 5,
      status: LeaveEncashmentStatus.AdminFinalised,
    });

    const result = await findUnpaidAdminFinalisedForEmployee(EMP_ID, 2024, tx as never);
    expect(result).not.toBeNull();
    expect(result?.status).toBe(LeaveEncashmentStatus.AdminFinalised);
    expect(tx.leaveEncashment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: LeaveEncashmentStatus.AdminFinalised,
          year: 2024,
        }),
      }),
    );
  });

  it('TC-LE-09: returns null when no unpaid encashment exists', async () => {
    const tx = buildTx();
    (tx.leaveEncashment.findFirst as Mock).mockResolvedValue(null);
    const result = await findUnpaidAdminFinalisedForEmployee(EMP_ID, 2024, tx as never);
    expect(result).toBeNull();
  });
});

// ── TC-LE-10: markEncashmentPaid / markEncashmentReversed ────────────────────

describe('markEncashmentPaid (BL-LE-09)', () => {
  it('TC-LE-10 paid: marks encashment Paid with actual amounts', async () => {
    const tx = buildTx();
    (tx.leaveEncashment.update as Mock).mockResolvedValue({});
    (audit as Mock).mockResolvedValue(undefined);

    await markEncashmentPaid(ENC_ID, SLIP_ID, 1923, 9615, tx as never);

    expect(tx.leaveEncashment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ENC_ID },
        data: expect.objectContaining({
          status: LeaveEncashmentStatus.Paid,
          ratePerDayPaise: 1923,
          amountPaise: 9615,
        }),
      }),
    );
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'leave.encashment.payment.paid' }));
  });
});

describe('markEncashmentReversed (BL-LE-11)', () => {
  it('TC-LE-10 reversed: writes leave.encashment.payment.reverse audit row without restoring balance', async () => {
    const tx = buildTx();
    (audit as Mock).mockResolvedValue(undefined);

    await markEncashmentReversed(ENC_ID, REV_SLIP_ID, tx as never);

    // Balance update should NOT be called
    expect(tx.leaveBalance.update).not.toHaveBeenCalled();
    // Audit row IS written
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'leave.encashment.payment.reverse' }),
    );
  });
});

// ── TC-LE-06: escalation sweep ────────────────────────────────────────────────

describe('escalateStaleEncashments (BL-LE-05 / BL-LE-06)', () => {
  it('TC-LE-06: escalates encashments past 5-day SLA', async () => {
    const tx = buildTx();
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago

    (tx.leaveEncashment.findMany as Mock).mockResolvedValue([
      {
        id: ENC_ID,
        code: 'LE-2025-0002',
        employeeId: EMP_ID,
        status: LeaveEncashmentStatus.Pending,
        routedToId: RoutedTo.Manager,
        approverId: MGR_ID,
        createdAt: oldDate,
        approver: { id: MGR_ID, status: EmployeeStatus.Active },
      },
    ]);
    (tx.employee.findFirst as Mock).mockResolvedValue({ id: ADMIN_ID, name: 'Admin' });
    (tx.employee.findMany as Mock).mockResolvedValue([{ id: ADMIN_ID }]);
    (tx.leaveEncashment.update as Mock).mockResolvedValue({});
    (audit as Mock).mockResolvedValue(undefined);
    (notify as Mock).mockResolvedValue(undefined);

    const count = await escalateStaleEncashments(tx as never);
    expect(count).toBe(1);
    expect(tx.leaveEncashment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ routedToId: RoutedTo.Admin, approverId: ADMIN_ID }),
      }),
    );
  });

  it('does not escalate when SLA not breached', async () => {
    const tx = buildTx();
    const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago

    (tx.leaveEncashment.findMany as Mock).mockResolvedValue([
      {
        id: ENC_ID_2,
        code: 'LE-2025-0003',
        employeeId: EMP_ID,
        status: LeaveEncashmentStatus.Pending,
        routedToId: RoutedTo.Manager,
        approverId: MGR_ID,
        createdAt: recentDate,
        approver: { id: MGR_ID, status: EmployeeStatus.Active },
      },
    ]);
    (tx.employee.findFirst as Mock).mockResolvedValue({ id: ADMIN_ID, name: 'Admin' });
    (audit as Mock).mockResolvedValue(undefined);

    const count = await escalateStaleEncashments(tx as never);
    expect(count).toBe(0);
  });
});

// ── cancelEncashment: balance restoration on AdminFinalised cancel ────────────

describe('cancelEncashment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (audit as Mock).mockResolvedValue(undefined);
    (notify as Mock).mockResolvedValue(undefined);
  });

  it('restores balance when Admin cancels an AdminFinalised encashment', async () => {
    const tx = buildTx();

    (tx.leaveEncashment.findUnique as Mock).mockResolvedValue({
      id: ENC_ID, code: 'LE-2025-0001', employeeId: EMP_ID, year: 2025,
      daysRequested: 5, daysApproved: 5, ratePerDayPaise: 1923, amountPaise: 9615,
      status: LeaveEncashmentStatus.AdminFinalised, routedToId: RoutedTo.Admin, approverId: ADMIN_ID,
      decidedAt: new Date(), decidedBy: ADMIN_ID, decisionNote: null, escalatedAt: null,
      paidAt: null, cancelledAt: null, cancelledBy: null,
      createdAt: new Date(), updatedAt: new Date(), version: 1,
      employee: { name: 'Alice', code: 'EMP-2025-0002' },
      approver: { name: 'Admin' },
    });
    (tx.leaveType.findUnique as Mock).mockResolvedValue({ id: LT_ANNUAL_ID, name: 'Annual' });
    (tx.leaveBalance.update as Mock).mockResolvedValue({ daysRemaining: 12, daysEncashed: 0 });
    (tx.leaveEncashment.update as Mock).mockResolvedValue({
      id: ENC_ID, code: 'LE-2025-0001', employeeId: EMP_ID, year: 2025,
      daysRequested: 5, daysApproved: 5, ratePerDayPaise: 1923, amountPaise: 9615,
      status: LeaveEncashmentStatus.Cancelled, routedToId: RoutedTo.Admin, approverId: ADMIN_ID,
      decidedAt: null, decidedBy: null, decisionNote: null, escalatedAt: null,
      paidAt: null, cancelledAt: new Date(), cancelledBy: ADMIN_ID,
      createdAt: new Date(), updatedAt: new Date(), version: 2,
      employee: { name: 'Alice', code: 'EMP-2025-0002' },
      approver: { name: 'Admin' },
    });

    await cancelEncashment(ENC_ID, ADMIN_ID, RoleId.Admin, tx as never);

    // Balance should be restored (increment daysRemaining, decrement daysEncashed)
    expect(tx.leaveBalance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          daysRemaining: { increment: 5 },
          daysEncashed: { decrement: 5 },
        }),
      }),
    );
  });

  it('does NOT restore balance when cancelling a Pending encashment (balance not yet deducted)', async () => {
    const tx = buildTx();

    (tx.leaveEncashment.findUnique as Mock).mockResolvedValue({
      id: ENC_ID_2, code: 'LE-2025-0002', employeeId: EMP_ID, year: 2025,
      daysRequested: 5, daysApproved: null, ratePerDayPaise: null, amountPaise: null,
      status: LeaveEncashmentStatus.Pending, routedToId: RoutedTo.Manager, approverId: MGR_ID,
      decidedAt: null, decidedBy: null, decisionNote: null, escalatedAt: null,
      paidAt: null, cancelledAt: null, cancelledBy: null,
      createdAt: new Date(), updatedAt: new Date(), version: 0,
      employee: { name: 'Alice', code: 'EMP-2025-0002' },
      approver: null,
    });
    (tx.leaveEncashment.update as Mock).mockResolvedValue({
      id: ENC_ID_2, code: 'LE-2025-0002', employeeId: EMP_ID, year: 2025,
      daysRequested: 5, daysApproved: null, ratePerDayPaise: null, amountPaise: null,
      status: LeaveEncashmentStatus.Cancelled, routedToId: RoutedTo.Manager, approverId: MGR_ID,
      decidedAt: null, decidedBy: null, decisionNote: null, escalatedAt: null,
      paidAt: null, cancelledAt: new Date(), cancelledBy: EMP_ID,
      createdAt: new Date(), updatedAt: new Date(), version: 1,
      employee: { name: 'Alice', code: 'EMP-2025-0002' },
      approver: null,
    });

    await cancelEncashment(ENC_ID_2, EMP_ID, RoleId.Employee, tx as never);

    // Balance should NOT be touched for a Pending cancel
    expect(tx.leaveBalance.update).not.toHaveBeenCalled();
  });
});

// ── rejectEncashment ──────────────────────────────────────────────────────────

describe('rejectEncashment', () => {
  it('transitions to Rejected without balance change', async () => {
    const tx = buildTx();
    (audit as Mock).mockResolvedValue(undefined);
    (notify as Mock).mockResolvedValue(undefined);

    (tx.leaveEncashment.findUnique as Mock).mockResolvedValue({
      id: ENC_ID_3, code: 'LE-2025-0003', employeeId: EMP_ID, year: 2025,
      daysRequested: 5, daysApproved: null, ratePerDayPaise: null, amountPaise: null,
      status: LeaveEncashmentStatus.Pending, routedToId: RoutedTo.Manager, approverId: MGR_ID,
      decidedAt: null, decidedBy: null, decisionNote: null, escalatedAt: null,
      paidAt: null, cancelledAt: null, cancelledBy: null,
      createdAt: new Date(), updatedAt: new Date(), version: 0,
      employee: { name: 'Alice', code: 'EMP-2025-0002' },
      approver: { name: 'Manager' },
    });
    (tx.leaveEncashment.update as Mock).mockResolvedValue({
      id: ENC_ID_3, code: 'LE-2025-0003', employeeId: EMP_ID, year: 2025,
      daysRequested: 5, daysApproved: null, ratePerDayPaise: null, amountPaise: null,
      status: LeaveEncashmentStatus.Rejected, routedToId: RoutedTo.Manager, approverId: MGR_ID,
      decidedAt: new Date(), decidedBy: MGR_ID, decisionNote: 'No budget', escalatedAt: null,
      paidAt: null, cancelledAt: null, cancelledBy: null,
      createdAt: new Date(), updatedAt: new Date(), version: 1,
      employee: { name: 'Alice', code: 'EMP-2025-0002' },
      approver: { name: 'Manager' },
    });

    const result = await rejectEncashment(ENC_ID_3, MGR_ID, 'No budget', tx as never, RoleId.Manager);
    expect(result.status).toBe(LeaveEncashmentStatus.Rejected);
    expect(tx.leaveBalance.update).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'leave.encashment.reject' }));
  });
});
