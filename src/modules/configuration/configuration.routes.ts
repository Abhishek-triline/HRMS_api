/**
 * Configuration routes — Phase 7.
 *
 * Mounted at /api/v1/config (alongside existing /config/tax and /config/holidays).
 *
 * Endpoints:
 *   GET  /api/v1/config/attendance   Admin only
 *   PUT  /api/v1/config/attendance   Admin only
 *   GET  /api/v1/config/leave        Admin only
 *   PUT  /api/v1/config/leave        Admin only
 *
 * All writes:
 *   - Run atomically in a Prisma transaction.
 *   - Write one audit row per changed key (before/after snapshot).
 *   - Notify all active Admins via the notifications system (BL-044).
 *   - Bust the in-process config cache so subsequent reads are live.
 *
 * Configuration keys (stored in the `configuration` table):
 *   ATTENDANCE_LATE_THRESHOLD_TIME   — "HH:MM" string
 *   ATTENDANCE_STANDARD_DAILY_HOURS  — number
 *   ATTENDANCE_WEEKLY_OFF_DAYS       — Weekday[] (e.g. ["Sat","Sun"])
 *   LEAVE_CARRY_FORWARD_CAPS         — Record<LeaveType, number>
 *   LEAVE_ESCALATION_PERIOD_DAYS     — number
 *   LEAVE_MATERNITY_DAYS             — number
 *   LEAVE_PATERNITY_DAYS             — number
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { requireSession } from '../../middleware/requireSession.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateBody } from '../../middleware/validateBody.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notifications.js';
import { logger } from '../../lib/logger.js';
import { getAttendanceConfig, getLeaveConfig, getEncashmentConfig, bustConfigCache } from '../../lib/config.js';
import { errorEnvelope, ErrorCode } from '@nexora/contracts/errors';
import {
  UpdateAttendanceConfigSchema,
  UpdateLeaveConfigSchema,
} from '@nexora/contracts/configuration';
import type { AttendanceConfig, LeaveConfig, EncashmentConfig } from '@nexora/contracts/configuration';

export const configurationRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve the actor's IP from the request.
 *
 * SEC-P8-005: do NOT read req.headers['x-forwarded-for'] directly — that header
 * is trivially spoofable by an attacker and would let them forge the IP stored in
 * audit rows. Express's req.ip already honours XFF correctly when
 * app.set('trust proxy', N) is configured (see PRE_PRODUCTION_CHECKLIST.md
 * SEC-P8-006). In the default no-proxy case, req.ip falls back to the socket
 * peer, which cannot be spoofed from outside the network.
 */
function resolveIp(req: Request): string | null {
  return req.ip ?? req.socket.remoteAddress ?? null;
}

/**
 * Upsert a single configuration key in the given transaction.
 * Returns { before, after } for the audit row.
 */
async function upsertConfigKey(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  key: string,
  newValue: unknown,
  updatedBy: string,
): Promise<{ before: unknown | null; after: unknown }> {
  const existing = await tx.configuration.findUnique({ where: { key } });
  const before = existing ? existing.value : null;

  await tx.configuration.upsert({
    where: { key },
    create: { key, value: newValue as import('@prisma/client').Prisma.InputJsonValue, updatedBy },
    update: { value: newValue as import('@prisma/client').Prisma.InputJsonValue, updatedBy },
  });

  return { before, after: newValue };
}

// ── GET /config/attendance ────────────────────────────────────────────────────

configurationRouter.get(
  '/attendance',
  requireSession(),
  requireRole('Admin'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const config = await getAttendanceConfig();
      res.status(200).json({ data: config });
    } catch (err: unknown) {
      logger.error({ err }, 'config.attendance.get: unexpected error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred.'));
    }
  },
);

// ── PUT /config/attendance ────────────────────────────────────────────────────

configurationRouter.put(
  '/attendance',
  requireSession(),
  requireRole('Admin'),
  validateBody(UpdateAttendanceConfigSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const actorId = req.user!.id;
      const actorRole = req.user!.role;
      const actorIp = resolveIp(req);
      const body = req.body as Partial<AttendanceConfig>;

      // BUG-CFG-003: capture resolved running value BEFORE upsert so audit 'before'
      // reflects the actual effective config (including code-defaults), not null.
      const beforeResolved = await getAttendanceConfig();

      const changedKeys: Array<{ key: string; before: unknown; after: unknown }> = [];

      await prisma.$transaction(async (tx) => {
        if (body.lateThresholdTime !== undefined) {
          const { before, after } = await upsertConfigKey(
            tx,
            'ATTENDANCE_LATE_THRESHOLD_TIME',
            body.lateThresholdTime,
            actorId,
          );
          changedKeys.push({ key: 'ATTENDANCE_LATE_THRESHOLD_TIME', before, after });

          await audit({
            tx,
            actorId,
            actorRole,
            actorIp,
            action: 'config.attendance.update',
            module: 'configuration',
            targetType: 'Configuration',
            targetId: 'ATTENDANCE_LATE_THRESHOLD_TIME',
            // BUG-CFG-003: use resolved before value so first-write audit is not null
            before: { value: beforeResolved.lateThresholdTime },
            after: { value: after },
          });
        }

        if (body.standardDailyHours !== undefined) {
          const { before, after } = await upsertConfigKey(
            tx,
            'ATTENDANCE_STANDARD_DAILY_HOURS',
            body.standardDailyHours,
            actorId,
          );
          changedKeys.push({ key: 'ATTENDANCE_STANDARD_DAILY_HOURS', before, after });

          await audit({
            tx,
            actorId,
            actorRole,
            actorIp,
            action: 'config.attendance.update',
            module: 'configuration',
            targetType: 'Configuration',
            targetId: 'ATTENDANCE_STANDARD_DAILY_HOURS',
            // BUG-CFG-003: use resolved before value so first-write audit is not null
            before: { value: beforeResolved.standardDailyHours },
            after: { value: after },
          });
        }

        if (body.weeklyOffDays !== undefined) {
          // Dedupe + canonicalise (Mon→Sun) so the stored value is stable
          const WEEKDAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
          const incoming = new Set(body.weeklyOffDays);
          const canonical = WEEKDAY_ORDER.filter((d) => incoming.has(d));

          const { before, after } = await upsertConfigKey(
            tx,
            'ATTENDANCE_WEEKLY_OFF_DAYS',
            canonical,
            actorId,
          );
          changedKeys.push({ key: 'ATTENDANCE_WEEKLY_OFF_DAYS', before, after });

          await audit({
            tx,
            actorId,
            actorRole,
            actorIp,
            action: 'config.attendance.update',
            module: 'configuration',
            targetType: 'Configuration',
            targetId: 'ATTENDANCE_WEEKLY_OFF_DAYS',
            before: { value: beforeResolved.weeklyOffDays },
            after: { value: after },
          });
        }

        // Notify all active Admins (BL-044 — Configuration category)
        if (changedKeys.length > 0) {
          const admins = await tx.employee.findMany({
            where: { role: 'Admin', status: 'Active' },
            select: { id: true },
          });

          const changeSummary = changedKeys
            .map((k) => `${k.key}: ${JSON.stringify(k.before)} → ${JSON.stringify(k.after)}`)
            .join('; ');

          await notify({
            tx,
            recipientIds: admins.map((a) => a.id),
            category: 'Configuration',
            title: 'Attendance configuration updated',
            body: `Attendance config changed by ${req.user!.name}: ${changeSummary}`,
            link: '/admin/config/attendance',
          });
        }
      });

      // Bust cache so next read reflects the new values, THEN reread for after-snapshot
      bustConfigCache();

      const updated = await getAttendanceConfig();

      logger.info({ actorId, changedKeys: changedKeys.map((k) => k.key) }, 'config.attendance.update: success');

      res.status(200).json({ data: updated });
    } catch (err: unknown) {
      logger.error({ err }, 'config.attendance.put: unexpected error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred.'));
    }
  },
);

// ── GET /config/leave ─────────────────────────────────────────────────────────

configurationRouter.get(
  '/leave',
  requireSession(),
  requireRole('Admin'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const config = await getLeaveConfig();
      res.status(200).json({ data: config });
    } catch (err: unknown) {
      logger.error({ err }, 'config.leave.get: unexpected error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred.'));
    }
  },
);

// ── PUT /config/leave ─────────────────────────────────────────────────────────

configurationRouter.put(
  '/leave',
  requireSession(),
  requireRole('Admin'),
  validateBody(UpdateLeaveConfigSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const actorId = req.user!.id;
      const actorRole = req.user!.role;
      const actorIp = resolveIp(req);
      const body = req.body as Partial<LeaveConfig>;

      // BUG-CFG-003: capture the resolved running config BEFORE upsert so audit
      // 'before' reflects the actual effective value (including code-defaults),
      // not null on the first-ever write.
      const beforeResolved = await getLeaveConfig();

      const changedKeys: Array<{ key: string; before: unknown; after: unknown }> = [];

      await prisma.$transaction(async (tx) => {
        // carryForwardCaps — merge incoming partial over the current stored value
        if (body.carryForwardCaps !== undefined) {
          const existingRow = await tx.configuration.findUnique({
            where: { key: 'LEAVE_CARRY_FORWARD_CAPS' },
          });

          // Default caps as base (matching getLeaveConfig defaults)
          const defaultCaps = { Annual: 10, Sick: 0, Casual: 5, Unpaid: 0, Maternity: 0, Paternity: 0 };
          const currentCaps =
            existingRow &&
            typeof existingRow.value === 'object' &&
            existingRow.value !== null &&
            !Array.isArray(existingRow.value)
              ? (existingRow.value as Record<string, number>)
              : defaultCaps;

          // Merge, forcing non-configurable types to 0 (BL-012 / BL-014)
          const incoming = body.carryForwardCaps as Partial<Record<string, number>>;
          const merged = {
            Annual:    incoming['Annual']    !== undefined ? incoming['Annual']    : (currentCaps['Annual']    ?? 10),
            Sick:      0,
            Casual:    incoming['Casual']    !== undefined ? incoming['Casual']    : (currentCaps['Casual']    ?? 5),
            Unpaid:    0,
            Maternity: 0,
            Paternity: 0,
          };

          const { before, after } = await upsertConfigKey(
            tx,
            'LEAVE_CARRY_FORWARD_CAPS',
            merged,
            actorId,
          );
          changedKeys.push({ key: 'LEAVE_CARRY_FORWARD_CAPS', before, after });

          // BUG-CFG-001 / SEC-003-P7: also sync leave_types.carryForwardCap so that
          // runCarryForward() (which reads lt.carryForwardCap) uses the updated value.
          // Unknown type names are silently skipped — they are already blocked at the
          // contract layer but we guard defensively here too.
          for (const [typeName, capValue] of Object.entries(merged)) {
            if (typeof capValue !== 'number') continue;
            try {
              await tx.leaveType.update({
                where: { name: typeName },
                data: { carryForwardCap: capValue },
              });
            } catch {
              // Unknown leave-type name — skip silently (safe: contract layer already
              // validates incoming keys). Do NOT abort the whole transaction.
            }
          }

          await audit({
            tx,
            actorId,
            actorRole,
            actorIp,
            action: 'config.leave.update',
            module: 'configuration',
            targetType: 'Configuration',
            targetId: 'LEAVE_CARRY_FORWARD_CAPS',
            // BUG-CFG-003: use resolved before value — includes code-defaults on first write
            before: { value: beforeResolved.carryForwardCaps },
            after: { value: after },
          });
        }

        if (body.escalationPeriodDays !== undefined) {
          const { before, after } = await upsertConfigKey(
            tx,
            'LEAVE_ESCALATION_PERIOD_DAYS',
            body.escalationPeriodDays,
            actorId,
          );
          changedKeys.push({ key: 'LEAVE_ESCALATION_PERIOD_DAYS', before, after });

          await audit({
            tx,
            actorId,
            actorRole,
            actorIp,
            action: 'config.leave.update',
            module: 'configuration',
            targetType: 'Configuration',
            targetId: 'LEAVE_ESCALATION_PERIOD_DAYS',
            // BUG-CFG-003: use resolved before value
            before: { value: beforeResolved.escalationPeriodDays },
            after: { value: after },
          });
        }

        if (body.maternityDays !== undefined) {
          const { before, after } = await upsertConfigKey(
            tx,
            'LEAVE_MATERNITY_DAYS',
            body.maternityDays,
            actorId,
          );
          changedKeys.push({ key: 'LEAVE_MATERNITY_DAYS', before, after });

          // BUG-CFG-002: sync leave_types.maxDaysPerEvent for Maternity so that when
          // Phase 2 eligibility enforcement lands (TODO: BUG-CFG-002) it reads the
          // correct value, not the seed-time constant.
          try {
            await tx.leaveType.update({
              where: { name: 'Maternity' },
              data: { maxDaysPerEvent: body.maternityDays },
            });
          } catch {
            // Maternity leave type not found — skip silently (seed gap, not fatal here)
          }

          await audit({
            tx,
            actorId,
            actorRole,
            actorIp,
            action: 'config.leave.update',
            module: 'configuration',
            targetType: 'Configuration',
            targetId: 'LEAVE_MATERNITY_DAYS',
            // BUG-CFG-003: use resolved before value
            before: { value: beforeResolved.maternityDays },
            after: { value: after },
          });
        }

        if (body.paternityDays !== undefined) {
          const { before, after } = await upsertConfigKey(
            tx,
            'LEAVE_PATERNITY_DAYS',
            body.paternityDays,
            actorId,
          );
          changedKeys.push({ key: 'LEAVE_PATERNITY_DAYS', before, after });

          // BUG-CFG-002: sync leave_types.maxDaysPerEvent for Paternity so that when
          // Phase 2 eligibility enforcement lands (TODO: BUG-CFG-002) it reads the
          // correct value, not the seed-time constant.
          try {
            await tx.leaveType.update({
              where: { name: 'Paternity' },
              data: { maxDaysPerEvent: body.paternityDays },
            });
          } catch {
            // Paternity leave type not found — skip silently (seed gap, not fatal here)
          }

          await audit({
            tx,
            actorId,
            actorRole,
            actorIp,
            action: 'config.leave.update',
            module: 'configuration',
            targetType: 'Configuration',
            targetId: 'LEAVE_PATERNITY_DAYS',
            // BUG-CFG-003: use resolved before value
            before: { value: beforeResolved.paternityDays },
            after: { value: after },
          });
        }

        // Notify all active Admins (BL-044 — Configuration category)
        if (changedKeys.length > 0) {
          const admins = await tx.employee.findMany({
            where: { role: 'Admin', status: 'Active' },
            select: { id: true },
          });

          const changeSummary = changedKeys
            .map((k) => `${k.key}: ${JSON.stringify(k.before)} → ${JSON.stringify(k.after)}`)
            .join('; ');

          await notify({
            tx,
            recipientIds: admins.map((a) => a.id),
            category: 'Configuration',
            title: 'Leave configuration updated',
            body: `Leave config changed by ${req.user!.name}: ${changeSummary}`,
            link: '/admin/config/leave',
          });
        }
      });

      // Bust cache BEFORE reread so the after-snapshot reflects persisted values
      // (BUG-CFG-003: stale cache would return the pre-upsert value as 'after').
      bustConfigCache();

      const updated = await getLeaveConfig();

      logger.info({ actorId, changedKeys: changedKeys.map((k) => k.key) }, 'config.leave.update: success');

      res.status(200).json({ data: updated });
    } catch (err: unknown) {
      logger.error({ err }, 'config.leave.put: unexpected error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred.'));
    }
  },
);

// ── GET /config/encashment ────────────────────────────────────────────────────

configurationRouter.get(
  '/encashment',
  requireSession(),
  requireRole('Admin'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const config = await getEncashmentConfig();
      res.status(200).json({ data: config });
    } catch (err: unknown) {
      logger.error({ err }, 'config.encashment.get: unexpected error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred.'));
    }
  },
);

// ── PUT /config/encashment ────────────────────────────────────────────────────

configurationRouter.put(
  '/encashment',
  requireSession(),
  requireRole('Admin'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const actorId = req.user!.id;
      const actorRole = req.user!.role;
      const actorIp = resolveIp(req);
      const body = req.body as Partial<EncashmentConfig>;

      const beforeResolved = await getEncashmentConfig();
      const changedKeys: Array<{ key: string; before: unknown; after: unknown }> = [];

      await prisma.$transaction(async (tx) => {
        if (body.windowStartMonth !== undefined) {
          const { before, after } = await upsertConfigKey(
            tx, 'ENCASHMENT_WINDOW_START_MONTH', body.windowStartMonth, actorId,
          );
          changedKeys.push({ key: 'ENCASHMENT_WINDOW_START_MONTH', before, after });
          await audit({
            tx, actorId, actorRole, actorIp,
            action: 'config.encashment.update', module: 'configuration',
            targetType: 'Configuration', targetId: 'ENCASHMENT_WINDOW_START_MONTH',
            before: { value: beforeResolved.windowStartMonth }, after: { value: after },
          });
        }
        if (body.windowEndMonth !== undefined) {
          const { before, after } = await upsertConfigKey(
            tx, 'ENCASHMENT_WINDOW_END_MONTH', body.windowEndMonth, actorId,
          );
          changedKeys.push({ key: 'ENCASHMENT_WINDOW_END_MONTH', before, after });
          await audit({
            tx, actorId, actorRole, actorIp,
            action: 'config.encashment.update', module: 'configuration',
            targetType: 'Configuration', targetId: 'ENCASHMENT_WINDOW_END_MONTH',
            before: { value: beforeResolved.windowEndMonth }, after: { value: after },
          });
        }
        if (body.windowEndDay !== undefined) {
          const { before, after } = await upsertConfigKey(
            tx, 'ENCASHMENT_WINDOW_END_DAY', body.windowEndDay, actorId,
          );
          changedKeys.push({ key: 'ENCASHMENT_WINDOW_END_DAY', before, after });
          await audit({
            tx, actorId, actorRole, actorIp,
            action: 'config.encashment.update', module: 'configuration',
            targetType: 'Configuration', targetId: 'ENCASHMENT_WINDOW_END_DAY',
            before: { value: beforeResolved.windowEndDay }, after: { value: after },
          });
        }
        if (body.maxPercent !== undefined) {
          const { before, after } = await upsertConfigKey(
            tx, 'ENCASHMENT_MAX_PERCENT', body.maxPercent, actorId,
          );
          changedKeys.push({ key: 'ENCASHMENT_MAX_PERCENT', before, after });
          await audit({
            tx, actorId, actorRole, actorIp,
            action: 'config.encashment.update', module: 'configuration',
            targetType: 'Configuration', targetId: 'ENCASHMENT_MAX_PERCENT',
            before: { value: beforeResolved.maxPercent }, after: { value: after },
          });
        }

        if (changedKeys.length > 0) {
          const admins = await tx.employee.findMany({
            where: { role: 'Admin', status: 'Active' },
            select: { id: true },
          });
          const changeSummary = changedKeys
            .map((k) => `${k.key}: ${JSON.stringify(k.before)} → ${JSON.stringify(k.after)}`)
            .join('; ');
          await notify({
            tx,
            recipientIds: admins.map((a) => a.id),
            category: 'Configuration',
            title: 'Encashment configuration updated',
            body: `Encashment config changed by ${req.user!.name}: ${changeSummary}`,
            link: '/admin/leave-config',
          });
        }
      });

      bustConfigCache();
      const updated = await getEncashmentConfig();
      logger.info({ actorId, changedKeys: changedKeys.map((k) => k.key) }, 'config.encashment.update: success');
      res.status(200).json({ data: updated });
    } catch (err: unknown) {
      logger.error({ err }, 'config.encashment.put: unexpected error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred.'));
    }
  },
);
