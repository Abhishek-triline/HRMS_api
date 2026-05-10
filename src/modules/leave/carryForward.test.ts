/**
 * Phase 7 — Carry-forward cron: test that the cron reads leaveType.carryForwardCap
 * from the leaveType table (NOT from the Configuration table), exposing BUG-CFG-001.
 *
 * TC-LEAVE-020 / BL-013 / Risk #1 from scope doc.
 */

import { describe, it, expect, vi, type Mock } from 'vitest';

// Mock prisma
vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    employee: { findMany: vi.fn() },
    leaveType: { findMany: vi.fn() },
    leaveBalance: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    leaveQuota: { findUnique: vi.fn() },
    leaveBalanceLedger: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../lib/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// Config returns Annual cap = 15 (updated via PUT /config/leave)
vi.mock('../../lib/config.js', () => ({
  getLeaveConfig: vi.fn().mockResolvedValue({
    carryForwardCaps: { Annual: 15, Sick: 0, Casual: 7, Unpaid: 0, Maternity: 0, Paternity: 0 },
    escalationPeriodDays: 5,
    maternityDays: 182,
    paternityDays: 10,
  }),
  getAttendanceConfig: vi.fn(),
  bustConfigCache: vi.fn(),
}));

import { runCarryForward } from './leave.service.js';

describe('BUG-CFG-001: runCarryForward reads leaveType.carryForwardCap, NOT Configuration table', () => {
  it('TC-LEAVE-020 / BL-013: carry-forward uses lt.carryForwardCap (DB column), ignoring PUT /config/leave value', async () => {
    // This test documents the sync gap:
    //   - Configuration table has Annual cap = 15 (via PUT /config/leave)
    //   - leaveType.carryForwardCap column still = 10 (unchanged)
    //   - runCarryForward reads lt.carryForwardCap = 10 → applies cap of 10, NOT 15
    //
    // The test simulates an employee with 20 Annual days remaining.
    // Expected with correct behaviour (cap=15): carry-forward = 15
    // Actual with the bug (cap=10 from DB column): carry-forward = 10

    const mockTx = {
      employee: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'emp-001', employmentType: 'Permanent' },
        ]),
      },
      leaveType: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'lt-annual',
            name: 'Annual',
            isEventBased: false,
            carryForwardCap: 10, // ← DB column value (not yet synced from Configuration)
          },
        ]),
      },
      leaveBalance: {
        findUnique: vi.fn()
          .mockResolvedValueOnce(null)       // new year: doesn't exist yet
          .mockResolvedValueOnce({           // prev year: 20 days remaining
            daysRemaining: 20,
            daysUsed: 0,
          }),
        create: vi.fn().mockResolvedValue({ id: 'lb-new' }),
      },
      leaveQuota: {
        findUnique: vi.fn().mockResolvedValue({ daysPerYear: 18 }),
      },
      leaveBalanceLedger: {
        create: vi.fn().mockResolvedValue({}),
      },
    } as unknown as Parameters<typeof runCarryForward>[1];

    const processed = await runCarryForward(2027, mockTx);

    // Verify carry-forward was applied
    expect(processed).toBe(1);

    // Verify the carry-forward cap used was 10 (from lt.carryForwardCap DB column)
    // NOT 15 (from the Configuration table updated by PUT /config/leave)
    const createCall = (mockTx.leaveBalance.create as Mock).mock.calls[0][0];
    const actualCarryForward = createCall.data.daysRemaining - 18; // daysRemaining - annualQuota = carryForward

    // BUG: should be 15 if config table was honoured, but actual is 10 from leaveType column
    expect(actualCarryForward).toBe(10); // Documents the bug: cap is 10, not the configured 15

    // This assertion will FAIL once the bug is fixed (carryForward would be 15):
    // To verify fix: change expect(actualCarryForward).toBe(10) → expect(actualCarryForward).toBe(15)
  });
});
