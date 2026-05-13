-- AlterTable
ALTER TABLE `attendance_records` ADD COLUMN `target_hours` INTEGER NOT NULL DEFAULT 8;

-- RenameIndex
ALTER TABLE `attendance_records` RENAME INDEX `attendance_records_date_status_id_idx` TO `attendance_records_date_status_idx`;

-- RenameIndex
ALTER TABLE `employees` RENAME INDEX `employees_status_id_idx` TO `employees_status_idx`;

-- RenameIndex
ALTER TABLE `leave_encashments` RENAME INDEX `leave_encashments_employee_id_year_status_id_idx` TO `leave_encashments_employee_id_year_status_idx`;

-- RenameIndex
ALTER TABLE `leave_requests` RENAME INDEX `leave_requests_approver_id_status_id_idx` TO `leave_requests_approver_id_status_idx`;

-- RenameIndex
ALTER TABLE `leave_requests` RENAME INDEX `leave_requests_employee_id_status_id_idx` TO `leave_requests_employee_id_status_idx`;

-- RenameIndex
ALTER TABLE `leave_requests` RENAME INDEX `leave_requests_status_id_escalated_at_idx` TO `leave_requests_status_escalated_at_idx`;

-- RenameIndex
ALTER TABLE `payroll_runs` RENAME INDEX `payroll_runs_status_id_year_month_idx` TO `payroll_runs_status_year_month_idx`;

-- RenameIndex
ALTER TABLE `regularisation_requests` RENAME INDEX `regularisation_requests_approver_id_status_id_idx` TO `regularisation_requests_approver_id_status_idx`;

-- RenameIndex
ALTER TABLE `regularisation_requests` RENAME INDEX `regularisation_requests_employee_id_status_id_idx` TO `regularisation_requests_employee_id_status_idx`;
