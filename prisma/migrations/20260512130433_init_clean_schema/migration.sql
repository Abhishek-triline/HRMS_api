-- CreateTable
CREATE TABLE `roles` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `status_id` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `roles_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employment_types` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `status_id` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `employment_types_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `departments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `status_id` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `departments_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `designations` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `status_id` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `designations_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `genders` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `status_id` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `genders_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_modules` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `status_id` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `audit_modules_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_types` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `is_event_based` BOOLEAN NOT NULL,
    `requires_admin_approval` BOOLEAN NOT NULL,
    `carry_forward_cap` INTEGER NULL,
    `max_days_per_event` INTEGER NULL,
    `status_id` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `leave_types_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employees` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `password_hash` VARCHAR(191) NOT NULL,
    `role_id` INTEGER NOT NULL,
    `employment_type_id` INTEGER NOT NULL DEFAULT 1,
    `department_id` INTEGER NULL,
    `designation_id` INTEGER NULL,
    `gender_id` INTEGER NULL,
    `status_id` INTEGER NOT NULL DEFAULT 4,
    `phone` VARCHAR(191) NULL,
    `date_of_birth` DATE NULL,
    `reporting_manager_id` INTEGER NULL,
    `previous_reporting_manager_id` INTEGER NULL,
    `join_date` DATE NOT NULL,
    `exit_date` DATE NULL,
    `must_reset_password` BOOLEAN NOT NULL DEFAULT false,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `employees_code_key`(`code`),
    UNIQUE INDEX `employees_email_key`(`email`),
    INDEX `employees_email_idx`(`email`),
    INDEX `employees_reporting_manager_id_idx`(`reporting_manager_id`),
    INDEX `employees_previous_reporting_manager_id_idx`(`previous_reporting_manager_id`),
    INDEX `employees_role_id_idx`(`role_id`),
    INDEX `employees_employment_type_id_idx`(`employment_type_id`),
    INDEX `employees_department_id_idx`(`department_id`),
    INDEX `employees_designation_id_idx`(`designation_id`),
    INDEX `employees_gender_id_idx`(`gender_id`),
    INDEX `employees_status_id_idx`(`status_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `salary_structures` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `employee_id` INTEGER NOT NULL,
    `basic_paise` INTEGER NOT NULL,
    `allowances_paise` INTEGER NOT NULL,
    `effective_from` DATE NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `version` INTEGER NOT NULL DEFAULT 0,
    `hra_paise` INTEGER NULL,
    `transport_paise` INTEGER NULL,
    `other_paise` INTEGER NULL,
    `da_paise` INTEGER NULL,

    INDEX `salary_structures_employee_id_effective_from_idx`(`employee_id`, `effective_from` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reporting_manager_history` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `employee_id` INTEGER NOT NULL,
    `manager_id` INTEGER NULL,
    `from_date` DATE NOT NULL,
    `to_date` DATE NULL,
    `reason_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `reporting_manager_history_employee_id_from_date_idx`(`employee_id`, `from_date` DESC),
    INDEX `reporting_manager_history_manager_id_to_date_idx`(`manager_id`, `to_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sessions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `token` VARCHAR(191) NOT NULL,
    `employee_id` INTEGER NOT NULL,
    `ip` VARCHAR(191) NULL,
    `user_agent` TEXT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `sessions_token_key`(`token`),
    INDEX `sessions_employee_id_idx`(`employee_id`),
    INDEX `sessions_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `login_attempts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `email` VARCHAR(191) NOT NULL,
    `ip` VARCHAR(191) NOT NULL,
    `success` BOOLEAN NOT NULL,
    `employee_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `login_attempts_email_created_at_idx`(`email`, `created_at`),
    INDEX `login_attempts_ip_created_at_idx`(`ip`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `password_reset_tokens` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `token_hash` VARCHAR(191) NOT NULL,
    `employee_id` INTEGER NOT NULL,
    `purpose_id` INTEGER NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `password_reset_tokens_token_hash_key`(`token_hash`),
    INDEX `password_reset_tokens_employee_id_idx`(`employee_id`),
    INDEX `password_reset_tokens_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_quotas` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `leave_type_id` INTEGER NOT NULL,
    `employment_type_id` INTEGER NOT NULL,
    `days_per_year` INTEGER NOT NULL,

    UNIQUE INDEX `leave_quotas_leave_type_id_employment_type_id_key`(`leave_type_id`, `employment_type_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_balances` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `employee_id` INTEGER NOT NULL,
    `leave_type_id` INTEGER NOT NULL,
    `year` INTEGER NOT NULL,
    `days_remaining` INTEGER NOT NULL DEFAULT 0,
    `days_used` INTEGER NOT NULL DEFAULT 0,
    `days_encashed` INTEGER NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 0,

    INDEX `leave_balances_employee_id_year_idx`(`employee_id`, `year`),
    UNIQUE INDEX `leave_balances_employee_id_leave_type_id_year_key`(`employee_id`, `leave_type_id`, `year`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_balance_ledger` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `employee_id` INTEGER NOT NULL,
    `leave_type_id` INTEGER NOT NULL,
    `year` INTEGER NOT NULL,
    `delta` INTEGER NOT NULL,
    `reason_id` INTEGER NOT NULL,
    `related_request_id` INTEGER NULL,
    `created_by` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `leave_balance_ledger_employee_id_year_created_at_idx`(`employee_id`, `year`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_code_counters` (
    `year` INTEGER NOT NULL,
    `number` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`year`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `encashment_code_counters` (
    `year` INTEGER NOT NULL,
    `number` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`year`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_requests` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(191) NOT NULL,
    `employee_id` INTEGER NOT NULL,
    `leave_type_id` INTEGER NOT NULL,
    `from_date` DATE NOT NULL,
    `to_date` DATE NOT NULL,
    `days` INTEGER NOT NULL,
    `reason` TEXT NOT NULL,
    `status_id` INTEGER NOT NULL DEFAULT 1,
    `routed_to_id` INTEGER NOT NULL,
    `approver_id` INTEGER NULL,
    `decided_at` DATETIME(3) NULL,
    `decided_by` INTEGER NULL,
    `decision_note` TEXT NULL,
    `escalated_at` DATETIME(3) NULL,
    `cancelled_at` DATETIME(3) NULL,
    `cancelled_by` INTEGER NULL,
    `cancelled_after_start` BOOLEAN NOT NULL DEFAULT false,
    `deducted_days` INTEGER NOT NULL DEFAULT 0,
    `restored_days` INTEGER NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `leave_requests_code_key`(`code`),
    INDEX `leave_requests_employee_id_status_id_idx`(`employee_id`, `status_id`),
    INDEX `leave_requests_approver_id_status_id_idx`(`approver_id`, `status_id`),
    INDEX `leave_requests_status_id_escalated_at_idx`(`status_id`, `escalated_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_late_ledger` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `employee_id` INTEGER NOT NULL,
    `year` INTEGER NOT NULL,
    `month` INTEGER NOT NULL,
    `count` INTEGER NOT NULL DEFAULT 0,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `attendance_late_ledger_employee_id_year_month_key`(`employee_id`, `year`, `month`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_records` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `employee_id` INTEGER NOT NULL,
    `date` DATE NOT NULL,
    `status_id` INTEGER NOT NULL,
    `check_in_time` DATETIME(3) NULL,
    `check_out_time` DATETIME(3) NULL,
    `hours_worked_minutes` INTEGER NULL,
    `late` BOOLEAN NOT NULL DEFAULT false,
    `late_month_count` INTEGER NOT NULL DEFAULT 0,
    `lop_applied` BOOLEAN NOT NULL DEFAULT false,
    `source_id` INTEGER NOT NULL,
    `regularisation_id` INTEGER NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `attendance_records_employee_id_date_idx`(`employee_id`, `date`),
    INDEX `attendance_records_date_status_id_idx`(`date`, `status_id`),
    UNIQUE INDEX `attendance_records_employee_id_date_source_id_key`(`employee_id`, `date`, `source_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reg_code_counters` (
    `year` INTEGER NOT NULL,
    `number` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`year`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `regularisation_requests` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(191) NOT NULL,
    `employee_id` INTEGER NOT NULL,
    `date` DATE NOT NULL,
    `proposed_check_in` DATETIME(3) NULL,
    `proposed_check_out` DATETIME(3) NULL,
    `reason` TEXT NOT NULL,
    `status_id` INTEGER NOT NULL DEFAULT 1,
    `routed_to_id` INTEGER NOT NULL,
    `age_days_at_submit` INTEGER NOT NULL,
    `approver_id` INTEGER NULL,
    `decided_at` DATETIME(3) NULL,
    `decided_by` INTEGER NULL,
    `decision_note` TEXT NULL,
    `corrected_record_id` INTEGER NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `regularisation_requests_code_key`(`code`),
    UNIQUE INDEX `regularisation_requests_corrected_record_id_key`(`corrected_record_id`),
    INDEX `regularisation_requests_employee_id_status_id_idx`(`employee_id`, `status_id`),
    INDEX `regularisation_requests_approver_id_status_id_idx`(`approver_id`, `status_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `holidays` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `date` DATE NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `year` INTEGER NOT NULL,
    `source` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `holidays_year_idx`(`year`),
    UNIQUE INDEX `holidays_date_key`(`date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_code_counters` (
    `year` INTEGER NOT NULL,
    `month` INTEGER NOT NULL,
    `number` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`year`, `month`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_runs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(191) NOT NULL,
    `month` INTEGER NOT NULL,
    `year` INTEGER NOT NULL,
    `status_id` INTEGER NOT NULL DEFAULT 2,
    `working_days` INTEGER NOT NULL,
    `period_start` DATE NOT NULL,
    `period_end` DATE NOT NULL,
    `initiated_by` INTEGER NOT NULL,
    `initiated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finalised_by` INTEGER NULL,
    `finalised_at` DATETIME(3) NULL,
    `reversed_by` INTEGER NULL,
    `reversed_at` DATETIME(3) NULL,
    `reversal_reason` TEXT NULL,
    `reversal_of_run_id` INTEGER NULL,
    `version` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `payroll_runs_code_key`(`code`),
    INDEX `payroll_runs_status_id_year_month_idx`(`status_id`, `year`, `month`),
    UNIQUE INDEX `payroll_runs_month_year_reversal_of_run_id_key`(`month`, `year`, `reversal_of_run_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payslips` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(191) NOT NULL,
    `run_id` INTEGER NOT NULL,
    `employee_id` INTEGER NOT NULL,
    `month` INTEGER NOT NULL,
    `year` INTEGER NOT NULL,
    `status_id` INTEGER NOT NULL DEFAULT 2,
    `period_start` DATE NOT NULL,
    `period_end` DATE NOT NULL,
    `working_days` INTEGER NOT NULL,
    `days_worked` INTEGER NOT NULL,
    `lop_days` INTEGER NOT NULL DEFAULT 0,
    `basic_paise` INTEGER NOT NULL,
    `allowances_paise` INTEGER NOT NULL,
    `gross_paise` INTEGER NOT NULL,
    `lop_deduction_paise` INTEGER NOT NULL DEFAULT 0,
    `reference_tax_paise` INTEGER NOT NULL DEFAULT 0,
    `final_tax_paise` INTEGER NOT NULL DEFAULT 0,
    `other_deductions_paise` INTEGER NOT NULL DEFAULT 0,
    `net_pay_paise` INTEGER NOT NULL,
    `encashment_days` INTEGER NOT NULL DEFAULT 0,
    `encashment_paise` INTEGER NOT NULL DEFAULT 0,
    `encashment_id` INTEGER NULL,
    `finalised_at` DATETIME(3) NULL,
    `reversal_of_payslip_id` INTEGER NULL,
    `reversed_by_payslip_id` INTEGER NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payslips_code_key`(`code`),
    UNIQUE INDEX `payslips_encashment_id_key`(`encashment_id`),
    UNIQUE INDEX `payslips_reversal_of_payslip_id_key`(`reversal_of_payslip_id`),
    UNIQUE INDEX `payslips_reversed_by_payslip_id_key`(`reversed_by_payslip_id`),
    INDEX `payslips_employee_id_year_month_idx`(`employee_id`, `year`, `month`),
    UNIQUE INDEX `payslips_run_id_employee_id_key`(`run_id`, `employee_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_encashments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(191) NOT NULL,
    `employee_id` INTEGER NOT NULL,
    `year` INTEGER NOT NULL,
    `days_requested` INTEGER NOT NULL,
    `days_approved` INTEGER NULL,
    `rate_per_day_paise` INTEGER NULL,
    `amount_paise` INTEGER NULL,
    `status_id` INTEGER NOT NULL DEFAULT 1,
    `routed_to_id` INTEGER NOT NULL,
    `approver_id` INTEGER NULL,
    `decided_at` DATETIME(3) NULL,
    `decided_by` INTEGER NULL,
    `decision_note` TEXT NULL,
    `escalated_at` DATETIME(3) NULL,
    `paid_at` DATETIME(3) NULL,
    `cancelled_at` DATETIME(3) NULL,
    `cancelled_by` INTEGER NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `leave_encashments_code_key`(`code`),
    INDEX `leave_encashments_employee_id_year_status_id_idx`(`employee_id`, `year`, `status_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `performance_cycles` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(191) NOT NULL,
    `fy_start` DATE NOT NULL,
    `fy_end` DATE NOT NULL,
    `status_id` INTEGER NOT NULL DEFAULT 1,
    `self_review_deadline` DATE NOT NULL,
    `manager_review_deadline` DATE NOT NULL,
    `closed_at` DATETIME(3) NULL,
    `closed_by` INTEGER NULL,
    `created_by` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `performance_cycles_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `performance_reviews` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `cycle_id` INTEGER NOT NULL,
    `employee_id` INTEGER NOT NULL,
    `manager_id` INTEGER NULL,
    `previous_manager_id` INTEGER NULL,
    `self_rating` INTEGER NULL,
    `self_note` TEXT NULL,
    `manager_rating` INTEGER NULL,
    `manager_note` TEXT NULL,
    `manager_overrode_self` BOOLEAN NOT NULL DEFAULT false,
    `final_rating` INTEGER NULL,
    `locked_at` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `performance_reviews_employee_id_idx`(`employee_id`),
    UNIQUE INDEX `performance_reviews_cycle_id_employee_id_key`(`cycle_id`, `employee_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `goals` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `review_id` INTEGER NOT NULL,
    `text` TEXT NOT NULL,
    `outcome_id` INTEGER NOT NULL DEFAULT 1,
    `proposed_by_employee` BOOLEAN NOT NULL DEFAULT false,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `goals_review_id_idx`(`review_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notifications` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `recipient_id` INTEGER NOT NULL,
    `category_id` INTEGER NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `body` TEXT NOT NULL,
    `link` VARCHAR(191) NULL,
    `unread` BOOLEAN NOT NULL DEFAULT true,
    `audit_log_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notifications_recipient_id_unread_created_at_idx`(`recipient_id`, `unread`, `created_at` DESC),
    INDEX `notifications_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_log` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `actor_id` INTEGER NULL,
    `actor_role_id` INTEGER NOT NULL,
    `actor_ip` VARCHAR(191) NULL,
    `action` VARCHAR(191) NOT NULL,
    `target_type_id` INTEGER NULL,
    `target_id` INTEGER NULL,
    `module_id` INTEGER NOT NULL,
    `before` JSON NULL,
    `after` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_log_actor_id_idx`(`actor_id`),
    INDEX `audit_log_action_idx`(`action`),
    INDEX `audit_log_created_at_idx`(`created_at`),
    INDEX `audit_log_target_type_id_target_id_idx`(`target_type_id`, `target_id`),
    INDEX `audit_log_module_id_idx`(`module_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `configurations` (
    `key` VARCHAR(191) NOT NULL,
    `value` JSON NOT NULL,
    `updated_by` VARCHAR(191) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `idempotency_keys` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `key` VARCHAR(191) NOT NULL,
    `employee_id` INTEGER NOT NULL,
    `endpoint` VARCHAR(191) NOT NULL,
    `response_snapshot` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `idempotency_keys_key_key`(`key`),
    INDEX `idempotency_keys_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
