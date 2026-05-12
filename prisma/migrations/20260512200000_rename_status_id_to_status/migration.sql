-- Rename `status_id` → `status` across every table that has it.
-- Pure column rename — no functional change. Values, codes, indexes preserved.

ALTER TABLE `roles`                   RENAME COLUMN `status_id` TO `status`;
ALTER TABLE `employment_types`        RENAME COLUMN `status_id` TO `status`;
ALTER TABLE `departments`             RENAME COLUMN `status_id` TO `status`;
ALTER TABLE `designations`            RENAME COLUMN `status_id` TO `status`;
ALTER TABLE `genders`                 RENAME COLUMN `status_id` TO `status`;
ALTER TABLE `audit_modules`           RENAME COLUMN `status_id` TO `status`;
ALTER TABLE `leave_types`             RENAME COLUMN `status_id` TO `status`;
ALTER TABLE `employees`               RENAME COLUMN `status_id` TO `status`;
ALTER TABLE `attendance_records`      RENAME COLUMN `status_id` TO `status`;
ALTER TABLE `leave_requests`          RENAME COLUMN `status_id` TO `status`;
ALTER TABLE `leave_encashments`       RENAME COLUMN `status_id` TO `status`;
ALTER TABLE `regularisation_requests` RENAME COLUMN `status_id` TO `status`;
ALTER TABLE `payroll_runs`            RENAME COLUMN `status_id` TO `status`;
ALTER TABLE `payslips`                RENAME COLUMN `status_id` TO `status`;
ALTER TABLE `performance_cycles`      RENAME COLUMN `status_id` TO `status`;
