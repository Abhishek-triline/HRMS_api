/**
 * Phase 7 — Audit Log routes: API tests.
 *
 * Tests mapped to:
 *   TC-AUD-001..TC-AUD-012
 *   TC-CFG-001..TC-CFG-005
 *   BL-047 (audit immutability at API layer)
 *   BL-044 (configuration notifications)
 *
 * Uses supertest against the running Express app (not a real DB; mocks prisma).
 * Run: npx vitest run src/modules/audit/audit.routes.test.ts
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Router } from 'express';

// ── Minimal mocks ─────────────────────────────────────────────────────────────

// Mock prisma
vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    auditLog: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    auditModule: {
      findUnique: vi.fn(),
    },
    employee: {
      findMany: vi.fn(),
    },
    configuration: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../lib/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../../lib/notifications.js', () => ({ notify: vi.fn() }));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('../../lib/config.js', () => ({
  getAttendanceConfig: vi.fn().mockResolvedValue({ lateThresholdTime: '10:30', standardDailyHours: 8, weeklyOffDays: ['Sat', 'Sun'] }),
  getLeaveConfig: vi.fn().mockResolvedValue({
    carryForwardCaps: { Annual: 10, Sick: 0, Casual: 5, Unpaid: 0, Maternity: 0, Paternity: 0 },
    escalationPeriodDays: 5,
    maternityDays: 182,
    paternityDays: 10,
  }),
  bustConfigCache: vi.fn(),
}));

// Mock requireSession and requireRole middlewares
vi.mock('../../middleware/requireSession.js', () => ({
  requireSession: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    // Default: authenticated as admin — tests override via __testRole injection
    const roleStr = (req as unknown as Record<string, unknown>).__testRole as string ?? 'Admin';
    const roleNameToId: Record<string, number> = { Admin: 4, Manager: 2, Employee: 1, PayrollOfficer: 3 };
    const roleId = roleNameToId[roleStr] ?? 4;
    req.user = {
      id: 1,
      name: 'Priya Sharma',
      roleId,
      email: 'admin@triline.co.in',
      code: 'EMP-2024-0001',
      status: 1,
      mustResetPassword: false,
    } as unknown as typeof req.user;
    next();
  },
}));

vi.mock('../../middleware/requireRole.js', () => ({
  requireRole: (..._requiredRoles: number[]) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!req.user || !_requiredRoles.includes(req.user.roleId)) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You are not authorised for this action.' } });
      return;
    }
    next();
  },
}));

vi.mock('../../middleware/validateQuery.js', () => ({
  validateQuery: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock('../../middleware/validateBody.js', () => ({
  validateBody: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

// ── Import routes after mocks are in place ────────────────────────────────────

import { auditRouter } from './audit.routes.js';
import { configurationRouter } from '../configuration/configuration.routes.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { prisma } from '../../lib/prisma.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { getAttendanceConfig, getLeaveConfig, bustConfigCache } from '../../lib/config.js';

// ── Test app factory ──────────────────────────────────────────────────────────

function makeApp(role = 'Admin') {
  const app = express();
  app.use(express.json());

  // Inject role into every request
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>).__testRole = role;
    next();
  });

  app.use('/api/v1/audit-logs', auditRouter);
  app.use('/api/v1/config', configurationRouter);

  return app;
}

// ── Helper: seed audit row fixture ───────────────────────────────────────────

const mockAuditRow = {
  id: 1,
  actorId: 1,
  actorRoleId: 4,
  actorIp: '127.0.0.1',
  action: 'leave.approve',
  module: { name: 'leave' },
  moduleId: 3,
  targetTypeId: 2,
  targetId: 1,
  before: { status: 1 },
  after: { status: 2 },
  createdAt: new Date('2026-05-10T12:00:00.000Z'),
};

// ── Audit log tests ───────────────────────────────────────────────────────────

describe('GET /api/v1/audit-logs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.auditLog.findMany as Mock).mockResolvedValue([mockAuditRow]);
  });

  it('TC-AUD-001: Admin can read audit log — returns 200 with data array', async () => {
    const app = makeApp('Admin');
    const res = await request(app).get('/api/v1/audit-logs');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0]).toMatchObject({
      id: 1,
      action: 'leave.approve',
      moduleId: 3,
      moduleName: 'leave',
    });
  });

  it('TC-AUD-010: Non-Admin role gets 403 on audit-logs', async () => {
    const app = makeApp('Manager');
    const res = await request(app).get('/api/v1/audit-logs');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('TC-AUD-007 (API layer): POST /audit-logs returns 404 — no route exists', async () => {
    const app = makeApp('Admin');
    const res = await request(app)
      .post('/api/v1/audit-logs')
      .send({ action: 'test', module: 'test' });
    expect(res.status).toBe(404);
  });

  it('TC-AUD-007 (API layer): PATCH /audit-logs/:id returns 404 — no route exists', async () => {
    const app = makeApp('Admin');
    const res = await request(app)
      .patch('/api/v1/audit-logs/someid')
      .send({});
    expect(res.status).toBe(404);
  });

  it('TC-AUD-008 (API layer): DELETE /audit-logs/:id returns 404 — no route exists', async () => {
    const app = makeApp('Admin');
    const res = await request(app).delete('/api/v1/audit-logs/someid');
    expect(res.status).toBe(404);
  });

  it('TC-AUD-009: moduleId filter passes the INT to the Prisma where clause', async () => {
    // v2: clients send INT codes directly (no name→id lookup on the server).
    const app = makeApp('Admin');
    const res = await request(app).get('/api/v1/audit-logs?moduleId=3');
    expect(res.status).toBe(200);
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ moduleId: 3 }),
      }),
    );
  });

  it('TC-AUD-009: actorRoleId filter passed to DB as INT', async () => {
    const app = makeApp('Admin');
    await request(app).get('/api/v1/audit-logs?actorRoleId=4');
    // Admin roleId = 4 per RoleId constants
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ actorRoleId: 4 }),
      }),
    );
  });

  it('q filter maps to action contains', async () => {
    const app = makeApp('Admin');
    await request(app).get('/api/v1/audit-logs?q=approve');
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ action: { contains: 'approve' } }),
      }),
    );
  });

  it('nextCursor is present when there are more pages', async () => {
    // Return limit+1 rows to trigger hasMore=true; ids must be INTs
    (prisma.auditLog.findMany as Mock).mockResolvedValue(
      Array.from({ length: 21 }, (_, i) => ({ ...mockAuditRow, id: i + 1 })),
    );
    const app = makeApp('Admin');
    const res = await request(app).get('/api/v1/audit-logs?limit=20');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(20);
    expect(res.body.nextCursor).not.toBeNull();
  });

  it('nextCursor is null when there are no more pages', async () => {
    (prisma.auditLog.findMany as Mock).mockResolvedValue([mockAuditRow]);
    const app = makeApp('Admin');
    const res = await request(app).get('/api/v1/audit-logs?limit=20');
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
  });
});

// ── Config attendance tests ───────────────────────────────────────────────────

describe('GET /api/v1/config/attendance', () => {
  it('TC-CFG-001: Admin gets attendance config', async () => {
    const app = makeApp('Admin');
    const res = await request(app).get('/api/v1/config/attendance');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      lateThresholdTime: '10:30',
      standardDailyHours: 8,
    });
  });

  it('TC-CFG-003: Non-Admin (Manager) gets 403 on config/attendance', async () => {
    const app = makeApp('Manager');
    const res = await request(app).get('/api/v1/config/attendance');
    expect(res.status).toBe(403);
  });

  it('TC-CFG-003: Non-Admin (PayrollOfficer) gets 403 on config/attendance', async () => {
    const app = makeApp('PayrollOfficer');
    const res = await request(app).get('/api/v1/config/attendance');
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/v1/config/attendance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAttendanceConfig as Mock).mockResolvedValue({ lateThresholdTime: '10:30', standardDailyHours: 8, weeklyOffDays: ['Sat', 'Sun'] });
    (bustConfigCache as Mock).mockReturnValue(undefined);
    (prisma.$transaction as Mock).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      configuration: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
      employee: { findMany: vi.fn().mockResolvedValue([{ id: 1 }]) },
    }));
  });

  it('TC-CFG-001: Admin can update lateThresholdTime and response reflects new value', async () => {
    (getAttendanceConfig as Mock).mockResolvedValueOnce({ lateThresholdTime: '10:30', standardDailyHours: 8, weeklyOffDays: ['Sat', 'Sun'] })
      .mockResolvedValue({ lateThresholdTime: '11:00', standardDailyHours: 8, weeklyOffDays: ['Sat', 'Sun'] });

    const app = makeApp('Admin');
    const res = await request(app)
      .put('/api/v1/config/attendance')
      .send({ lateThresholdTime: '11:00' });
    expect(res.status).toBe(200);
    expect(res.body.data.lateThresholdTime).toBe('11:00');
  });

  it('TC-CFG-003: Manager cannot PUT config/attendance — 403', async () => {
    const app = makeApp('Manager');
    const res = await request(app)
      .put('/api/v1/config/attendance')
      .send({ lateThresholdTime: '09:00' });
    expect(res.status).toBe(403);
  });

  it('bustConfigCache is called after a successful PUT', async () => {
    const app = makeApp('Admin');
    await request(app)
      .put('/api/v1/config/attendance')
      .send({ lateThresholdTime: '11:00' });
    expect(bustConfigCache).toHaveBeenCalledTimes(1);
  });
});

// ── Config leave tests ────────────────────────────────────────────────────────

describe('GET /api/v1/config/leave', () => {
  it('Admin gets leave config', async () => {
    const app = makeApp('Admin');
    const res = await request(app).get('/api/v1/config/leave');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      escalationPeriodDays: 5,
      maternityDays: 182,
      paternityDays: 10,
    });
  });

  it('TC-CFG-003: Non-Admin gets 403 on config/leave', async () => {
    const app = makeApp('Employee');
    const res = await request(app).get('/api/v1/config/leave');
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/v1/config/leave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getLeaveConfig as Mock).mockResolvedValue({
      carryForwardCaps: { Annual: 10, Sick: 0, Casual: 5, Unpaid: 0, Maternity: 0, Paternity: 0 },
      escalationPeriodDays: 5,
      maternityDays: 182,
      paternityDays: 10,
    });
    (bustConfigCache as Mock).mockReturnValue(undefined);
    (prisma.$transaction as Mock).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      configuration: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
      employee: { findMany: vi.fn().mockResolvedValue([{ id: 1 }]) },
    }));
  });

  it('Admin can update escalationPeriodDays — returns 200 OK', async () => {
    // PUT /config/leave does not call getLeaveConfig inside the transaction;
    // it reads config after bustConfigCache via the final getLeaveConfig().
    // We just verify status 200 + that bustConfigCache is triggered.
    const app = makeApp('Admin');
    const res = await request(app)
      .put('/api/v1/config/leave')
      .send({ escalationPeriodDays: 1 });
    expect(res.status).toBe(200);
    // data shape is present
    expect(res.body.data).toHaveProperty('escalationPeriodDays');
  });

  it('TC-CFG-003: Non-Admin cannot PUT config/leave — 403', async () => {
    const app = makeApp('Manager');
    const res = await request(app)
      .put('/api/v1/config/leave')
      .send({ escalationPeriodDays: 7 });
    expect(res.status).toBe(403);
  });

  it('bustConfigCache is called after successful PUT /config/leave', async () => {
    const app = makeApp('Admin');
    await request(app)
      .put('/api/v1/config/leave')
      .send({ escalationPeriodDays: 3 });
    expect(bustConfigCache).toHaveBeenCalledTimes(1);
  });
});
