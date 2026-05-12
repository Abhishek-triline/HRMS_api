/**
 * Unit tests for undoCheckOutForEmployee — 4 cases as specified.
 *
 * TC-ATT-UNDO-01  Happy path: check-out → undo → checkOutTime null, hoursWorkedMinutes null
 * TC-ATT-UNDO-02  No check-in → 409 NOT_CHECKED_IN
 * TC-ATT-UNDO-03  Already Working (no check-out) → idempotent 200, record unchanged
 * TC-ATT-UNDO-04  Undo window expired (>5 min after check-out) → 409 UNDO_WINDOW_EXPIRED
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ── Mock all external dependencies ───────────────────────────────────────────

vi.mock('../../../lib/prisma.js', () => ({
  prisma: { $transaction: vi.fn() },
}));

vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }));

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../../lib/config.js', () => ({
  getAttendanceConfig: vi.fn().mockResolvedValue({
    lateThresholdTime: '10:30',
    standardDailyHours: 8,
  }),
  getLeaveConfig: vi.fn(),
  bustConfigCache: vi.fn(),
}));

vi.mock('../../../lib/notifications.js', () => ({ notify: vi.fn() }));

vi.mock('../../leave/leave.service.js', () => ({
  findOverlappingLeave: vi.fn(),
  currentBalanceRow: vi.fn(),
  findDefaultAdmin: vi.fn(),
}));

vi.mock('../holidays.js', () => ({
  isHoliday: vi.fn().mockResolvedValue(false),
  isWeeklyOff: vi.fn().mockResolvedValue(false),
}));

vi.mock('../regCode.js', () => ({ generateRegCode: vi.fn() }));

// ── Import after mocks ────────────────────────────────────────────────────────

import { undoCheckOutForEmployee } from '../attendance.service.js';
import { audit } from '../../../lib/audit.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal AttendanceRecord-like object for the mock. */
function makeRecord(overrides: Record<string, unknown> = {}) {
  const base = {
    id: 1,
    employeeId: 1001,
    date: new Date('2026-05-11T00:00:00.000Z'),
    status: 'Present',
    checkInTime: new Date('2026-05-11T03:30:00.000Z'), // 09:00 IST
    checkOutTime: null as Date | null,
    hoursWorkedMinutes: null as number | null,
    late: false,
    lateMonthCount: 0,
    lopApplied: false,
    source: 'system',
    regularisationId: null,
    createdAt: new Date('2026-05-11T03:30:00.000Z'),
    version: 1,
  };
  return { ...base, ...overrides };
}

/** Build a minimal Prisma TransactionClient mock. */
function makeTx(record: ReturnType<typeof makeRecord> | null) {
  return {
    attendanceRecord: {
      findUnique: vi.fn().mockResolvedValue(record),
      update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...record!, ...data, version: (record?.version ?? 0) + 1 }),
      ),
    },
    attendanceLateLedger: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
}

// ── Reference "now" — 2026-05-11 09:10 IST = 03:40 UTC ────────────────────────

const NOW = new Date('2026-05-11T03:40:00.000Z');

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('undoCheckOutForEmployee', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // TC-ATT-UNDO-01
  it('happy path: clears checkOutTime + hoursWorkedMinutes and writes audit', async () => {
    // Record has checked out 2 minutes ago
    const checkOutTime = new Date(NOW.getTime() - 2 * 60_000);
    const rec = makeRecord({ checkOutTime, hoursWorkedMinutes: 130 });
    const tx = makeTx(rec);

    const result = await undoCheckOutForEmployee(1001, NOW, tx as never);

    // update was called with the right nulls
    expect(tx.attendanceRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({
          checkOutTime: null,
          hoursWorkedMinutes: null,
        }),
      }),
    );

    // Returned record must have no checkOutTime / hoursWorkedMinutes
    expect(result.record.checkOutTime).toBeNull();
    expect(result.record.hoursWorkedMinutes).toBeNull();
    expect(result.lateMarkDeductionApplied).toBe(false);

    // Audit was written
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'attendance.check-out.undo',
        targetType: 'AttendanceRecord',
        targetId: 1,
        before: expect.objectContaining({ checkOutTime: checkOutTime.toISOString() }),
        after: expect.objectContaining({ checkOutTime: null }),
      }),
    );
  });

  // TC-ATT-UNDO-02
  it('no check-in → throws 409 NOT_CHECKED_IN', async () => {
    // Record exists but checkInTime is null
    const rec = makeRecord({ checkInTime: null });
    const tx = makeTx(rec);

    await expect(undoCheckOutForEmployee(1001, NOW, tx as never)).rejects.toMatchObject({
      httpStatus: 409,
      code: 'NOT_CHECKED_IN',
    });

    // Also covers the case where no record exists at all
    const txNull = makeTx(null);
    await expect(undoCheckOutForEmployee(1001, NOW, txNull as never)).rejects.toMatchObject({
      httpStatus: 409,
      code: 'NOT_CHECKED_IN',
    });
  });

  // TC-ATT-UNDO-03
  it('already Working (no check-out) → idempotent, update never called', async () => {
    // Record has checkInTime but no checkOutTime
    const rec = makeRecord({ checkOutTime: null, hoursWorkedMinutes: null });
    const tx = makeTx(rec);

    const result = await undoCheckOutForEmployee(1001, NOW, tx as never);

    expect(tx.attendanceRecord.update).not.toHaveBeenCalled();
    expect(result.record).toBe(rec);
    expect(result.lateMarkDeductionApplied).toBe(false);
  });

  // TC-ATT-UNDO-04
  it('undo window expired (>5 min after check-out) → throws 409 UNDO_WINDOW_EXPIRED', async () => {
    // Check-out was 6 minutes ago
    const checkOutTime = new Date(NOW.getTime() - 6 * 60_000);
    const rec = makeRecord({ checkOutTime, hoursWorkedMinutes: 120 });
    const tx = makeTx(rec);

    await expect(undoCheckOutForEmployee(1001, NOW, tx as never)).rejects.toMatchObject({
      httpStatus: 409,
      code: 'UNDO_WINDOW_EXPIRED',
    });

    expect(tx.attendanceRecord.update).not.toHaveBeenCalled();
  });
});
