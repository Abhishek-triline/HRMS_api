/**
 * Scheduled jobs — Phase 2 + Phase 3.
 *
 * Jobs registered here:
 *
 *   attendance.midnight-generate  — Daily at 00:00 IST (0 0 * * * Asia/Kolkata).
 *     For every Active or OnNotice employee, upserts one AttendanceRecord row
 *     with source='system' and default status=Absent. BL-026 priority overrides:
 *     Holiday → Holiday, Weekly-Off → WeeklyOff, Approved Leave → OnLeave.
 *     Idempotent: employees who already have a system row for that date are skipped.
 *     Audits attendance.midnight-generate.run with actorRole='system', actorId=null.
 *
 *   leave.escalation-sweep  — Runs every hour (0 * * * *).
 *     Escalates any Pending leave request where:
 *       - routedTo = Manager AND createdAt + 5 working days < now() (BL-018), OR
 *       - the current approver (manager) has status=Exited (BL-022).
 *     NEVER auto-approves. Flips status to Escalated, re-routes to Admin.
 *
 *   leave.carry-forward  — Runs on Jan 1 at 00:05 IST (5 0 1 1 * Asia/Kolkata).
 *     Annual: cap carry-forward at carryForwardCap (default 10).
 *     Casual: cap at carryForwardCap (default 5).
 *     Sick: reset to 0 (BL-012).
 *     Unpaid: reset to 0.
 *     Maternity / Paternity: untouched (BL-014).
 *     Then creates fresh balance rows for the new year.
 *
 * All jobs are:
 *   - Guarded by ENABLE_CRON env flag (default 'true' — set to 'false' in tests).
 *   - Wrapped in try/catch — a failed job never crashes the server.
 *   - Idempotent — running twice for the same period is a no-op.
 */

import cron from 'node-cron';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { escalateStaleRequests, runCarryForward } from '../modules/leave/leave.service.js';
import { escalateStaleEncashments } from '../modules/leave/leave-encashment.service.js';
import { runMidnightGenerate } from '../modules/attendance/attendance.service.js';
import { audit } from './audit.js';
import { notify } from './notifications.js';
import {
  AuditTargetType,
  CycleStatus,
  LeaveEncashmentStatus,
} from './statusInt.js';

const ENABLE_CRON = process.env['ENABLE_CRON'] !== 'false';

/**
 * Start all scheduled jobs.
 * Must be called after the Express server starts listening.
 */
export function startScheduler(): void {
  if (!ENABLE_CRON) {
    logger.info({ cron: false }, 'Scheduled jobs disabled via ENABLE_CRON=false');
    return;
  }

  logger.info({ cron: true }, 'Starting scheduled jobs...');

  // ── attendance.midnight-generate — daily 00:00 IST ────────────────────────
  // BL-023: auto-generate one Absent row per Active employee at midnight IST.
  // BL-026: override status to Holiday/WeeklyOff/OnLeave where applicable.
  // Idempotent: employees already processed for the date are skipped.
  cron.schedule(
    '0 0 * * *',
    async () => {
      const jobId = 'attendance.midnight-generate';
      // The cron fires at 00:00 IST — the date in India is "today" at midnight
      const today = new Date();
      logger.info({ job: jobId, date: today.toISOString() }, 'Starting midnight attendance generate');

      try {
        const result = await prisma.$transaction((tx) => runMidnightGenerate(today, tx));

        logger.info(
          { job: jobId, date: today.toISOString().split('T')[0], ...result },
          `Midnight generate complete — ${result.employeesProcessed} employee(s) processed`,
        );
      } catch (err: unknown) {
        // A failed generate must NOT crash the server (cron error isolation).
        logger.error(
          { job: jobId, err },
          'Midnight attendance generate failed — server continues normally',
        );
      }
    },
    {
      timezone: 'Asia/Kolkata',
    },
  );

  // ── leave.escalation-sweep — hourly ────────────────────────────────────────
  // BL-018: pending leave requests older than 5 working days are escalated to Admin.
  // BL-022: requests assigned to an Exited manager are immediately escalated.
  cron.schedule(
    '0 * * * *',
    async () => {
      const jobId = 'leave.escalation-sweep';
      logger.info({ job: jobId }, 'Starting escalation sweep');

      try {
        const count = await prisma.$transaction((tx) => escalateStaleRequests(tx));

        logger.info(
          { job: jobId, escalatedCount: count },
          `Escalation sweep complete — ${count} request(s) escalated`,
        );
      } catch (err: unknown) {
        // A failed sweep must NOT crash the server (cron error isolation).
        logger.error(
          { job: jobId, err },
          'Escalation sweep failed — server continues normally',
        );
      }
    },
    {
      timezone: 'Asia/Kolkata',
    },
  );

  // ── leave.carry-forward — Jan 1 at 00:01 IST ──────────────────────────────
  // Adjusted from 00:05 to 00:01 to ensure carry-forward runs AFTER the
  // Dec 31 23:50 encashment window-check cron and any last-minute finalise
  // actions (BL-LE-10: encashment must finalise before Jan 1 carry-forward).
  // BL-012: Sick leave resets to zero.
  // BL-013: Annual + Casual carry-forward capped per leaveType.carryForwardCap.
  // BL-014: Maternity/Paternity untouched.
  cron.schedule(
    '1 0 1 1 *',
    async () => {
      const jobId = 'leave.carry-forward';
      const newYear = new Date().getFullYear(); // Jan 1 of the new year at job fire time
      logger.info({ job: jobId, newYear }, 'Starting annual carry-forward');

      try {
        const processed = await prisma.$transaction((tx) => runCarryForward(newYear, tx));

        logger.info(
          { job: jobId, newYear, processed },
          `Carry-forward complete — ${processed} employee/type pairs processed`,
        );
      } catch (err: unknown) {
        logger.error(
          { job: jobId, newYear, err },
          'Carry-forward job failed — server continues normally',
        );
      }
    },
    {
      timezone: 'Asia/Kolkata',
    },
  );

  // ── leave-encashment.escalation-sweep — hourly ──────────────────────────────
  // BL-LE-05: mirrors leave escalation — pending encashments > 5 working days
  // route to Admin. Exited-approver encashments escalate immediately.
  cron.schedule(
    '0 * * * *',
    async () => {
      const jobId = 'leave-encashment.escalation-sweep';
      logger.info({ job: jobId }, 'Starting encashment escalation sweep');
      try {
        const count = await prisma.$transaction((tx) => escalateStaleEncashments(tx));
        logger.info({ job: jobId, count }, `Encashment escalation sweep complete — ${count} escalated`);
      } catch (err: unknown) {
        logger.error({ job: jobId, err }, 'Encashment escalation sweep failed — server continues normally');
      }
    },
    { timezone: 'Asia/Kolkata' },
  );

  // ── leave-encashment.windowCheck — Dec 31 23:50 IST ─────────────────────────
  // BL-LE-10: heads-up log of Pending encashments still in queue before the
  // Dec 31 window closes and carry-forward runs. No behaviour change — admin
  // awareness only.
  cron.schedule(
    '50 23 31 12 *',
    async () => {
      const jobId = 'leave-encashment.windowCheck';
      logger.info({ job: jobId }, 'Starting encashment window-closing check');
      try {
        const count = await prisma.leaveEncashment.count({
          where: { status: { in: [LeaveEncashmentStatus.Pending, LeaveEncashmentStatus.ManagerApproved] } },
        });
        if (count > 0) {
          logger.warn(
            { job: jobId, pendingCount: count },
            `ENCASHMENT WINDOW CLOSING: ${count} encashment request(s) are still Pending or ManagerApproved and will not be paid for this year unless acted on before Jan 1 00:01 IST carry-forward.`,
          );
        } else {
          logger.info({ job: jobId, pendingCount: 0 }, 'No pending encashment requests — window closes cleanly.');
        }
      } catch (err: unknown) {
        logger.error({ job: jobId, err }, 'Encashment window-check failed — server continues normally');
      }
    },
    { timezone: 'Asia/Kolkata' },
  );

  // ── idempotency-key.cleanup — daily 03:00 IST ─────────────────────────────
  // Deletes IdempotencyKey rows older than 24h (TTL enforcement).
  // Audits the number of rows deleted so the cleanup can be traced.
  cron.schedule(
    '0 3 * * *',
    async () => {
      const jobId = 'idempotency-key.cleanup';
      logger.info({ job: jobId }, 'Starting idempotency-key cleanup');

      try {
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const deleted = await prisma.idempotencyKey.deleteMany({
          where: { createdAt: { lt: cutoff } },
        });

        await audit({
          actorId: null,
          actorRole: 'system',
          action: 'idempotency-key.cleanup',
          targetType: null,
          targetId: null,
          module: 'payroll',
          before: null,
          after: { deletedCount: deleted.count, cutoff: cutoff.toISOString() },
        });

        logger.info(
          { job: jobId, deletedCount: deleted.count },
          `Idempotency-key cleanup complete — ${deleted.count} rows deleted`,
        );
      } catch (err: unknown) {
        logger.error({ job: jobId, err }, 'Idempotency-key cleanup failed — server continues normally');
      }
    },
    {
      timezone: 'Asia/Kolkata',
    },
  );

  // ── notifications.archive-90d — daily 03:30 IST ───────────────────────────
  // BL-045: delete Notification rows older than NOTIFICATION_RETENTION_DAYS
  // (default 90). The source audit_log rows are NEVER affected. No audit entry
  // is written for this cleanup — it's a sweep of derived data (BL-045).
  cron.schedule(
    '30 3 * * *',
    async () => {
      const jobId = 'notifications.archive-90d';
      logger.info({ job: jobId }, 'Starting notification retention sweep');

      try {
        // SEC-003-P6: Read retention days from configuration with validated parse.
        // Unsafe cast (config?.value as number) replaced with type-safe guard +
        // clamp to [1, 3650] to prevent NaN, Infinity, negative, or absurd values.
        const config = await prisma.configuration.findUnique({
          where: { key: 'NOTIFICATION_RETENTION_DAYS' },
        });
        const rawValue = config?.value;
        const parsed =
          typeof rawValue === 'number' && Number.isFinite(rawValue) ? rawValue : 90;
        const retentionDays = Math.max(1, Math.min(parsed, 3650)); // floor 1d, ceiling 10y
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

        const deleted = await prisma.notification.deleteMany({
          where: { createdAt: { lt: cutoff } },
        });

        // SEC-003-P6: Audit each sweep for traceability (even though notifications
        // themselves are derived data, the sweep action warrants an audit row).
        await audit({
          actorId: null,
          actorRole: 'system',
          action: 'notifications.archive-90d',
          targetType: null,
          targetId: null,
          module: 'notifications',
          before: null,
          after: {
            retentionDays,
            cutoff: cutoff.toISOString(),
            deletedCount: deleted.count,
          },
        });

        logger.info(
          { job: jobId, retentionDays, cutoff: cutoff.toISOString(), deletedCount: deleted.count },
          `Notification retention sweep complete — ${deleted.count} rows deleted`,
        );
      } catch (err: unknown) {
        logger.error({ job: jobId, err }, 'Notification retention sweep failed — server continues normally');
      }
    },
    {
      timezone: 'Asia/Kolkata',
    },
  );

  // ── performance.review-deadline-nudge — daily 09:00 IST ──────────────────
  // BUG-NOT-002: send reminder notifications 7 days and 1 day before selfReviewDeadline
  // to every participant who has not yet submitted a self-review.
  // De-duplication: checks audit_log for a previous nudge action for the same
  // (reviewId, employeeId) pair within the last 30 days before sending.
  cron.schedule(
    '0 9 * * *',
    async () => {
      const jobId = 'performance.review-deadline-nudge';
      logger.info({ job: jobId }, 'Starting performance review deadline nudge');

      try {
        const now = new Date();

        // ±12h window centred on each target deadline so the 09:00 daily fire
        // catches deadlines regardless of what time-of-day they were stored at.
        const windowHalfMs = 12 * 60 * 60 * 1000;

        for (const daysAhead of [7, 1]) {
          const targetMs = now.getTime() + daysAhead * 24 * 60 * 60 * 1000;
          const windowStart = new Date(targetMs - windowHalfMs);
          const windowEnd   = new Date(targetMs + windowHalfMs);

          // Open cycles whose selfReviewDeadline falls within the window
          const cycles = await prisma.performanceCycle.findMany({
            where: {
              status: CycleStatus.Open,
              selfReviewDeadline: { gte: windowStart, lte: windowEnd },
            },
            select: { id: true, code: true },
          });

          for (const cycle of cycles) {
            // Participants who have NOT yet submitted a self-review and are
            // not mid-cycle joiners (BL-037 excludes them from self-review)
            const reviews = await prisma.performanceReview.findMany({
              where: {
                cycleId: cycle.id,
                isMidCycleJoiner: false,
                selfSubmittedAt: null,
              },
              select: { id: true, employeeId: true },
            });

            const actionKey = daysAhead === 7
              ? 'performance.deadline-nudge-7d'
              : 'performance.deadline-nudge-1d';

            const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

            for (const review of reviews) {
              // De-duplicate: skip if we already sent this exact nudge in the last 30 days
              const alreadySent = await prisma.auditLog.findFirst({
                where: {
                  action: actionKey,
                  targetTypeId: AuditTargetType.PerformanceReview,
                  targetId: review.id,
                  // The actorId for system nudges is null; match on targetId + action
                  createdAt: { gte: thirtyDaysAgo },
                },
                select: { id: true },
              });

              if (alreadySent) continue;

              const body = daysAhead === 7
                ? `Your self-review for "${cycle.code}" is due in 7 days. Please submit your ratings.`
                : `Your self-review for "${cycle.code}" is due tomorrow. Please submit before the deadline.`;

              const title = daysAhead === 7
                ? 'Self-review due in 7 days'
                : 'Self-review due tomorrow';

              await audit({
                actorId: null,
                actorRole: 'system',
                action: actionKey,
                targetType: 'PerformanceReview',
                targetId: review.id,
                module: 'performance',
                before: null,
                after: {
                  cycleId: cycle.id,
                  cycleCode: cycle.code,
                  employeeId: review.employeeId,
                  daysAhead,
                },
              });

              await notify({
                recipientIds: review.employeeId,
                category: 'Performance',
                title,
                body,
                link: `/employee/performance/${review.id}`,
              });
            }
          }
        }

        logger.info({ job: jobId }, 'Performance review deadline nudge complete');
      } catch (err: unknown) {
        logger.error({ job: jobId, err }, 'Performance review deadline nudge failed — server continues normally');
      }
    },
    {
      timezone: 'Asia/Kolkata',
    },
  );

  logger.info(
    'Scheduled jobs started: attendance.midnight-generate (daily 00:00 IST), leave.escalation-sweep (hourly), leave-encashment.escalation-sweep (hourly), leave-encashment.windowCheck (Dec 31 23:50 IST), leave.carry-forward (Jan 1 00:01 IST), idempotency-key.cleanup (daily 03:00 IST), notifications.archive-90d (daily 03:30 IST), performance.review-deadline-nudge (daily 09:00 IST)',
  );
}
