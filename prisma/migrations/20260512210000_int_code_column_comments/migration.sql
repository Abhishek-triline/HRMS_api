-- Self-document every INT-coded column with a MySQL COMMENT clause so the
-- meaning of each code value is visible directly in SHOW FULL COLUMNS, in
-- information_schema.COLUMNS.COLUMN_COMMENT, and in DB tooling (DataGrip,
-- DBeaver, MySQL Workbench, phpMyAdmin) — no need to grep the codebase to
-- understand what status=4 means.
--
-- These comments mirror the FROZEN code mappings in docs/HRMS_Schema_v2_Plan.md
-- §3. Never re-number an existing code — only append new ones.

-- ── status columns on master tables (uniform 1=Active, 2=Deprecated) ────────

ALTER TABLE `roles`            MODIFY COLUMN `status` INT NOT NULL DEFAULT 1 COMMENT '1=Active, 2=Deprecated';
ALTER TABLE `employment_types` MODIFY COLUMN `status` INT NOT NULL DEFAULT 1 COMMENT '1=Active, 2=Deprecated';
ALTER TABLE `departments`      MODIFY COLUMN `status` INT NOT NULL DEFAULT 1 COMMENT '1=Active, 2=Deprecated';
ALTER TABLE `designations`     MODIFY COLUMN `status` INT NOT NULL DEFAULT 1 COMMENT '1=Active, 2=Deprecated';
ALTER TABLE `genders`          MODIFY COLUMN `status` INT NOT NULL DEFAULT 1 COMMENT '1=Active, 2=Deprecated';
ALTER TABLE `audit_modules`    MODIFY COLUMN `status` INT NOT NULL DEFAULT 1 COMMENT '1=Active, 2=Deprecated';
ALTER TABLE `leave_types`      MODIFY COLUMN `status` INT NOT NULL DEFAULT 1 COMMENT '1=Active, 2=Deprecated';

-- ── status columns on entity tables (§3.1–§3.6) ─────────────────────────────

ALTER TABLE `employees`               MODIFY COLUMN `status` INT NOT NULL DEFAULT 4 COMMENT '§3.1 1=Active, 2=OnNotice, 3=OnLeave, 4=Inactive, 5=Exited';
ALTER TABLE `attendance_records`      MODIFY COLUMN `status` INT NOT NULL          COMMENT '§3.4 1=Present, 2=Absent, 3=OnLeave, 4=WeeklyOff, 5=Holiday';
ALTER TABLE `leave_requests`          MODIFY COLUMN `status` INT NOT NULL DEFAULT 1 COMMENT '§3.2 1=Pending, 2=Approved, 3=Rejected, 4=Cancelled, 5=Escalated';
ALTER TABLE `leave_encashments`       MODIFY COLUMN `status` INT NOT NULL DEFAULT 1 COMMENT '§3.3 1=Pending, 2=ManagerApproved, 3=AdminFinalised, 4=Paid, 5=Rejected, 6=Cancelled';
ALTER TABLE `regularisation_requests` MODIFY COLUMN `status` INT NOT NULL DEFAULT 1 COMMENT '§3.4 1=Pending, 2=Approved, 3=Rejected';
ALTER TABLE `payroll_runs`            MODIFY COLUMN `status` INT NOT NULL DEFAULT 2 COMMENT '§3.5 1=Draft, 2=Review, 3=Finalised, 4=Reversed';
ALTER TABLE `payslips`                MODIFY COLUMN `status` INT NOT NULL DEFAULT 2 COMMENT '§3.5 1=Draft, 2=Review, 3=Finalised, 4=Reversed';
ALTER TABLE `performance_cycles`      MODIFY COLUMN `status` INT NOT NULL DEFAULT 1 COMMENT '§3.6 1=Open, 2=SelfReview, 3=ManagerReview, 4=Closed';

-- ── routing (§3.2 / §3.3 / §3.4 — uniform 1=Manager, 2=Admin) ───────────────

ALTER TABLE `leave_requests`          MODIFY COLUMN `routed_to_id` INT NOT NULL COMMENT '1=Manager, 2=Admin';
ALTER TABLE `leave_encashments`       MODIFY COLUMN `routed_to_id` INT NOT NULL COMMENT '1=Manager, 2=Admin';
ALTER TABLE `regularisation_requests` MODIFY COLUMN `routed_to_id` INT NOT NULL COMMENT '1=Manager, 2=Admin';

-- ── Attendance source (§3.4) ────────────────────────────────────────────────

ALTER TABLE `attendance_records` MODIFY COLUMN `source_id` INT NOT NULL COMMENT '§3.4 1=system, 2=regularisation';

-- ── Auth token purpose (§3.8) ───────────────────────────────────────────────

ALTER TABLE `password_reset_tokens` MODIFY COLUMN `purpose_id` INT NOT NULL COMMENT '§3.8 1=FirstLogin, 2=ResetPassword';

-- ── Notification category (§3.7) ────────────────────────────────────────────

ALTER TABLE `notifications` MODIFY COLUMN `category_id` INT NOT NULL COMMENT '§3.7 1=Leave, 2=Attendance, 3=Payroll, 4=Performance, 5=Status, 6=Configuration, 7=Auth, 8=System';

-- ── Goal outcome (§3.6) ─────────────────────────────────────────────────────

ALTER TABLE `goals` MODIFY COLUMN `outcome_id` INT NOT NULL DEFAULT 1 COMMENT '§3.6 1=Pending, 2=Met, 3=Partial, 4=Missed';

-- ── Audit log codes (§3.9) ──────────────────────────────────────────────────

ALTER TABLE `audit_log` MODIFY COLUMN `target_type_id` INT NULL COMMENT '§3.9 1=Employee, 2=LeaveRequest, 3=LeaveEncashment, 4=AttendanceRecord, 5=RegularisationRequest, 6=PayrollRun, 7=Payslip, 8=PerformanceCycle, 9=PerformanceReview, 10=Goal, 11=Configuration, 12=SalaryStructure, 13=Holiday, 14=Notification';
ALTER TABLE `audit_log` MODIFY COLUMN `actor_role_id`  INT NOT NULL COMMENT '§3.9 1=Employee, 2=Manager, 3=PayrollOfficer, 4=Admin, 99=unknown, 100=system';

-- ── History reason codes (§3.8) ─────────────────────────────────────────────

ALTER TABLE `reporting_manager_history` MODIFY COLUMN `reason_id` INT NOT NULL COMMENT '§3.8 1=Initial, 2=Reassigned, 3=Exited';
ALTER TABLE `leave_balance_ledger`      MODIFY COLUMN `reason_id` INT NOT NULL COMMENT '§3.2 1=Initial, 2=Approval, 3=Cancellation, 4=CarryForward, 5=Adjustment, 6=LateMarkPenalty';
