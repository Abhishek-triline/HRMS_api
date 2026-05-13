-- DropIndex
DROP INDEX `leave_requests_employee_id_status_idx` ON `leave_requests`;

-- CreateIndex
CREATE INDEX `leave_requests_employee_id_status_from_date_to_date_idx` ON `leave_requests`(`employee_id`, `status`, `from_date`, `to_date`);
