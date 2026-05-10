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
import { runMidnightGenerate } from '../modules/attendance/attendance.service.js';

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

  logger.info(
    'Scheduled jobs started: attendance.midnight-generate (daily 00:00 IST), leave.escalation-sweep (hourly), leave.carry-forward (Jan 1 00:05 IST)',
  );
}
