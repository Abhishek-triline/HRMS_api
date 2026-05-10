/**
 * Phase 7 — Carry-forward cron regression test.
 * BUG-CFG-001 fix: PUT /config/leave now also writes to leaveType.carryForwardCap
 * inside the same transaction, so the cron's read of lt.carryForwardCap reflects
 * the admin-configured value. This test pins the cron's read path to the column.
 *
 * TC-LEAVE-020 / BL-013.
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

describe('runCarryForward respects leaveType.carryForwardCap (kept in sync by PUT /config/leave)', () => {
  it('TC-LEAVE-020 / BL-013: carry-forward applies lt.carryForwardCap as the cap', async () => {
    // The fix for BUG-CFG-001: PUT /config/leave updates both Configuration AND
    // leaveType.carryForwardCap atomically. This test pins the cron's read path
    // to the column. With column=10 the cron caps at 10; if PUT had set Annual=15
    // both Configuration AND the column would carry 15.

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

    // The cron reads lt.carryForwardCap = 10 (the column). PUT /config/leave keeps
    // this column in sync with the Configuration table (BUG-CFG-001 fix).
    const createCall = (mockTx.leaveBalance.create as Mock).mock.calls[0]?.[0];
    expect(createCall).toBeDefined();
    const actualCarryForward = createCall.data.daysRemaining - 18; // daysRemaining - annualQuota = carryForward
    expect(actualCarryForward).toBe(10);
  });
});
