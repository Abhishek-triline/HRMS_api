-- Phase 7: BUG-CFG-004 — Drop orphan configuration key.
--
-- Both LEAVE_ESCALATION_WORKING_DAYS (Phase 2) and LEAVE_ESCALATION_PERIOD_DAYS
-- (Phase 7) exist in the DB with value 5, but only the latter is read by the
-- application. The former is an orphan left over from the Phase 2 implementation.
--
-- MySQL DELETE is idempotent — rerunning this migration on a DB that already had the
-- row deleted (or never had it) is safe and produces zero rows affected.
DELETE FROM `configuration` WHERE `key` = 'LEAVE_ESCALATION_WORKING_DAYS';
