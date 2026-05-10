-- CreateTable
CREATE TABLE `payroll_runs` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `month` INTEGER NOT NULL,
    `year` INTEGER NOT NULL,
    `status` ENUM('Draft', 'Review', 'Finalised', 'Reversed') NOT NULL DEFAULT 'Review',
    `workingDays` INTEGER NOT NULL,
    `periodStart` DATE NOT NULL,
    `periodEnd` DATE NOT NULL,
    `initiatedBy` VARCHAR(191) NOT NULL,
    `finalisedBy` VARCHAR(191) NULL,
    `finalisedAt` DATETIME(3) NULL,
    `reversedBy` VARCHAR(191) NULL,
    `reversedAt` DATETIME(3) NULL,
    `reversalReason` TEXT NULL,
    `reversalOfRunId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `payroll_runs_code_key`(`code`),
    INDEX `payroll_runs_year_status_idx`(`year`, `status`),
    UNIQUE INDEX `payroll_runs_month_year_reversalOfRunId_key`(`month`, `year`, `reversalOfRunId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payslips` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `month` INTEGER NOT NULL,
    `year` INTEGER NOT NULL,
    `status` ENUM('Draft', 'Review', 'Finalised', 'Reversed') NOT NULL DEFAULT 'Review',
    `periodStart` DATE NOT NULL,
    `periodEnd` DATE NOT NULL,
    `workingDays` INTEGER NOT NULL,
    `daysWorked` INTEGER NOT NULL,
    `lopDays` INTEGER NOT NULL DEFAULT 0,
    `basicPaise` INTEGER NOT NULL,
    `allowancesPaise` INTEGER NOT NULL,
    `grossPaise` INTEGER NOT NULL,
    `lopDeductionPaise` INTEGER NOT NULL DEFAULT 0,
    `referenceTaxPaise` INTEGER NOT NULL DEFAULT 0,
    `finalTaxPaise` INTEGER NOT NULL DEFAULT 0,
    `otherDeductionsPaise` INTEGER NOT NULL DEFAULT 0,
    `netPayPaise` INTEGER NOT NULL,
    `finalisedAt` DATETIME(3) NULL,
    `reversalOfPayslipId` VARCHAR(191) NULL,
    `reversedByPayslipId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `payslips_code_key`(`code`),
    UNIQUE INDEX `payslips_reversedByPayslipId_key`(`reversedByPayslipId`),
    INDEX `payslips_employeeId_year_month_idx`(`employeeId`, `year`, `month`),
    INDEX `payslips_runId_idx`(`runId`),
    INDEX `payslips_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_code_counters` (
    `id` VARCHAR(191) NOT NULL,
    `year` INTEGER NOT NULL,
    `month` INTEGER NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `lastSeq` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `payroll_code_counters_year_month_kind_key`(`year`, `month`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `idempotency_keys` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `path` VARCHAR(191) NOT NULL,
    `status` INTEGER NOT NULL,
    `responseBody` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idempotency_keys_userId_key_idx`(`userId`, `key`),
    UNIQUE INDEX `idempotency_keys_userId_key_key`(`userId`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_initiatedBy_fkey` FOREIGN KEY (`initiatedBy`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_finalisedBy_fkey` FOREIGN KEY (`finalisedBy`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_reversedBy_fkey` FOREIGN KEY (`reversedBy`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_reversalOfRunId_fkey` FOREIGN KEY (`reversalOfRunId`) REFERENCES `payroll_runs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payslips` ADD CONSTRAINT `payslips_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `payroll_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payslips` ADD CONSTRAINT `payslips_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payslips` ADD CONSTRAINT `payslips_reversalOfPayslipId_fkey` FOREIGN KEY (`reversalOfPayslipId`) REFERENCES `payslips`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payslips` ADD CONSTRAINT `payslips_reversedByPayslipId_fkey` FOREIGN KEY (`reversedByPayslipId`) REFERENCES `payslips`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `idempotency_keys` ADD CONSTRAINT `idempotency_keys_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
