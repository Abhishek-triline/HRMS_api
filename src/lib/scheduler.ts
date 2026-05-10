/**
 * Scheduled jobs — Phase 2.
 *
 * Jobs registered here:
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
 * Both jobs are:
 *   - Guarded by ENABLE_CRON env flag (default 'true' — set to 'false' in tests).
 *   - Wrapped in try/catch — a failed sweep never crashes the server.
 *   - Idempotent — running twice for the same period is a no-op.
 */

import cron from 'node-cron';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { escalateStaleRequests, runCarryForward } from '../modules/leave/leave.service.js';

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

  // ── leave.carry-forward — Jan 1 at 00:05 IST ──────────────────────────────
  // BL-012: Sick leave resets to zero.
  // BL-013: Annual + Casual carry-forward capped per leaveType.carryForwardCap.
  // BL-014: Maternity/Paternity untouched.
  cron.schedule(
    '5 0 1 1 *',
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

  logger.info('Scheduled jobs started: leave.escalation-sweep (hourly), leave.carry-forward (Jan 1 00:05 IST)');
}
