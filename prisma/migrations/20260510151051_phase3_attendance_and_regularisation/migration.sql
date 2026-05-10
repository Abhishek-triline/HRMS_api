-- AlterTable
ALTER TABLE `leave_balance_ledger` MODIFY `reason` ENUM('Approval', 'Cancellation', 'CarryForward', 'Adjustment', 'Initial', 'LateMarkPenalty') NOT NULL;

-- CreateTable
CREATE TABLE `attendance_records` (
    `id` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `status` ENUM('Present', 'Absent', 'OnLeave', 'WeeklyOff', 'Holiday') NOT NULL,
    `checkInTime` DATETIME(3) NULL,
    `checkOutTime` DATETIME(3) NULL,
    `hoursWorkedMinutes` INTEGER NULL,
    `late` BOOLEAN NOT NULL DEFAULT false,
    `lateMonthCount` INTEGER NOT NULL DEFAULT 0,
    `lopApplied` BOOLEAN NOT NULL DEFAULT false,
    `source` ENUM('system', 'regularisation') NOT NULL,
    `regularisationId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `version` INTEGER NOT NULL DEFAULT 0,

    INDEX `attendance_records_employeeId_date_idx`(`employeeId`, `date`),
    INDEX `attendance_records_date_status_idx`(`date`, `status`),
    UNIQUE INDEX `attendance_records_employeeId_date_source_key`(`employeeId`, `date`, `source`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `regularisation_requests` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `proposedCheckIn` DATETIME(3) NULL,
    `proposedCheckOut` DATETIME(3) NULL,
    `reason` TEXT NOT NULL,
    `status` ENUM('Pending', 'Approved', 'Rejected') NOT NULL DEFAULT 'Pending',
    `routedTo` ENUM('Manager', 'Admin') NOT NULL,
    `ageDaysAtSubmit` INTEGER NOT NULL,
    `approverId` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decidedBy` VARCHAR(191) NULL,
    `decisionNote` TEXT NULL,
    `correctedRecordId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `regularisation_requests_code_key`(`code`),
    INDEX `regularisation_requests_employeeId_date_idx`(`employeeId`, `date`),
    INDEX `regularisation_requests_approverId_status_idx`(`approverId`, `status`),
    INDEX `regularisation_requests_status_routedTo_idx`(`status`, `routedTo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reg_code_counters` (
    `year` INTEGER NOT NULL,
    `lastSeq` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`year`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_late_ledger` (
    `id` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `year` INTEGER NOT NULL,
    `month` INTEGER NOT NULL,
    `count` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `attendance_late_ledger_employeeId_year_month_key`(`employeeId`, `year`, `month`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `holidays` (
    `id` VARCHAR(191) NOT NULL,
    `year` INTEGER NOT NULL,
    `date` DATE NOT NULL,
    `name` VARCHAR(120) NOT NULL,

    INDEX `holidays_date_idx`(`date`),
    UNIQUE INDEX `holidays_year_date_key`(`year`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `attendance_records` ADD CONSTRAINT `attendance_records_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_records` ADD CONSTRAINT `attendance_records_regularisationId_fkey` FOREIGN KEY (`regularisationId`) REFERENCES `regularisation_requests`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `regularisation_requests` ADD CONSTRAINT `regularisation_requests_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `regularisation_requests` ADD CONSTRAINT `regularisation_requests_approverId_fkey` FOREIGN KEY (`approverId`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_late_ledger` ADD CONSTRAINT `attendance_late_ledger_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
