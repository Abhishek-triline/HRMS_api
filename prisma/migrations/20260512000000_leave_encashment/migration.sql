-- Leave Encashment migration (additive, BL-LE-01..14)
--
-- New table:      leave_encashments, encashment_code_counters
-- Altered tables: leave_balances (daysEncashed), payslips (encashmentDays, encashmentPaise, encashmentId),
--                 salary_structures (daPaise)
--
-- Partial-unique-index note (BL-LE-03):
--   MySQL does NOT support partial (filtered) unique indexes.
--   The "one approved encashment per employee per year" constraint is therefore enforced
--   ONLY at the application layer via a findFirst check in leave-encashment.service.ts
--   at submit and admin-finalise time.  The service also wraps the finalise step in a
--   SELECT…FOR UPDATE row lock so two concurrent requests cannot both pass the check.
--   Trade-off: a concurrent race that slips past both application checks would insert
--   a second AdminFinalised row; the SELECT…FOR UPDATE makes this impossible in practice
--   for the finalise path, and the submit path only creates Pending rows (which do not
--   consume the quota per BL-LE-03).

-- AlterTable
ALTER TABLE `leave_balances` ADD COLUMN `daysEncashed` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `payslips` ADD COLUMN `encashmentDays` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `encashmentId` VARCHAR(191) NULL,
    ADD COLUMN `encashmentPaise` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `salary_structures` ADD COLUMN `daPaise` INTEGER NULL;

-- CreateTable: leave_encashments
CREATE TABLE `leave_encashments` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `year` INTEGER NOT NULL,
    `daysRequested` INTEGER NOT NULL,
    `daysApproved` INTEGER NULL,
    `ratePerDayPaise` INTEGER NULL,
    `amountPaise` INTEGER NULL,
    `status` ENUM('Pending', 'ManagerApproved', 'AdminFinalised', 'Paid', 'Rejected', 'Cancelled') NOT NULL DEFAULT 'Pending',
    `routedTo` VARCHAR(191) NOT NULL,
    `approverId` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decidedBy` VARCHAR(191) NULL,
    `decisionNote` TEXT NULL,
    `escalatedAt` DATETIME(3) NULL,
    `paidInPayslipId` VARCHAR(191) NULL,
    `paidAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelledBy` VARCHAR(191) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `leave_encashments_code_key`(`code`),
    UNIQUE INDEX `leave_encashments_paidInPayslipId_key`(`paidInPayslipId`),
    INDEX `leave_encashments_employeeId_year_idx`(`employeeId`, `year`),
    INDEX `leave_encashments_status_year_idx`(`status`, `year`),
    INDEX `leave_encashments_approverId_status_idx`(`approverId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: encashment_code_counters
CREATE TABLE `encashment_code_counters` (
    `year` INTEGER NOT NULL,
    `lastSeq` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`year`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex on payslips for encashmentId FK
CREATE UNIQUE INDEX `payslips_encashmentId_key` ON `payslips`(`encashmentId`);

-- AddForeignKey: payslips → leave_encashments
ALTER TABLE `payslips` ADD CONSTRAINT `payslips_encashmentId_fkey`
    FOREIGN KEY (`encashmentId`) REFERENCES `leave_encashments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: leave_encashments → employees (employee)
ALTER TABLE `leave_encashments` ADD CONSTRAINT `leave_encashments_employeeId_fkey`
    FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: leave_encashments → employees (approver)
ALTER TABLE `leave_encashments` ADD CONSTRAINT `leave_encashments_approverId_fkey`
    FOREIGN KEY (`approverId`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed: 4 new Configuration rows for the encashment window (idempotent — INSERT IGNORE).
INSERT IGNORE INTO `configuration` (`key`, `value`, `updatedBy`, `updatedAt`)
VALUES
    ('ENCASHMENT_WINDOW_START_MONTH', '12', 'migration', NOW()),
    ('ENCASHMENT_WINDOW_END_MONTH',   '1',  'migration', NOW()),
    ('ENCASHMENT_WINDOW_END_DAY',     '15', 'migration', NOW()),
    ('ENCASHMENT_MAX_PERCENT',        '50', 'migration', NOW());
