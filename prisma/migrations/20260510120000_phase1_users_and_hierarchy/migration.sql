-- Nexora HRMS — Phase 1 Migration: Users & Hierarchy
-- Adds: employmentType + previousReportingManagerId to employees,
--       salary_structures table, reporting_manager_history table.
--
-- Rules enforced:
--   BL-005  No circular reporting chains (enforced in application layer)
--   BL-006  Status transitions (Active / On-Notice / Exited manual; On-Leave system-set)
--   BL-007  Historical records never deleted
--   BL-008  EMP code never reused (unique constraint already in place from Phase 0)
--   BL-022  Pending approvals stay with previous manager
--   BL-022a Past team members surfaced via reporting_manager_history
--   BL-030  Salary edits apply from next payroll run only

-- ── 1. New ENUMs ─────────────────────────────────────────────────────────────
--
-- MySQL ENUM values added to employees table via ALTER TABLE below.
-- Separate ENUM types are not a MySQL concept; Prisma maps them inline.

-- ── 2. Add columns to employees ──────────────────────────────────────────────

ALTER TABLE `employees`
  ADD COLUMN `employmentType` ENUM('Permanent','Contract','Intern','Probation') NOT NULL DEFAULT 'Permanent',
  ADD COLUMN `previousReportingManagerId` VARCHAR(191) NULL;

-- Index for fast past-manager queries
CREATE INDEX `employees_previousReportingManagerId_idx`
  ON `employees` (`previousReportingManagerId`);

-- ── 3. Create salary_structures ──────────────────────────────────────────────
--
-- One row per salary change. Active structure = latest effectiveFrom <= run month start.
-- BL-030: inserting a new row (never mutating old ones) ensures past payslips stay immutable.

CREATE TABLE `salary_structures` (
    `id`              VARCHAR(191)    NOT NULL,
    `employeeId`      VARCHAR(191)    NOT NULL,
    `basicPaise`      INTEGER         NOT NULL,
    `allowancesPaise` INTEGER         NOT NULL,
    `effectiveFrom`   DATE            NOT NULL,
    `createdAt`       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `version`         INTEGER         NOT NULL DEFAULT 0,

    INDEX `salary_structures_employeeId_effectiveFrom_idx` (`employeeId`, `effectiveFrom` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `salary_structures`
  ADD CONSTRAINT `salary_structures_employeeId_fkey`
  FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 4. Create reporting_manager_history ──────────────────────────────────────
--
-- BL-007: never deleted. Insert on creation (Initial), close + re-insert on reassign.
-- toDate NULL = currently open row.
-- Supports: past-team query (managerId + toDate IS NOT NULL).

CREATE TABLE `reporting_manager_history` (
    `id`         VARCHAR(191)                                    NOT NULL,
    `employeeId` VARCHAR(191)                                    NOT NULL,
    `managerId`  VARCHAR(191)                                    NULL,
    `fromDate`   DATE                                            NOT NULL,
    `toDate`     DATE                                            NULL,
    `reason`     ENUM('Initial','Reassigned','Exited')           NOT NULL,
    `createdAt`  DATETIME(3)                                     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `reporting_manager_history_employeeId_fromDate_idx` (`employeeId`, `fromDate` DESC),
    INDEX `reporting_manager_history_managerId_toDate_idx`    (`managerId`, `toDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `reporting_manager_history`
  ADD CONSTRAINT `reporting_manager_history_employeeId_fkey`
  FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `reporting_manager_history`
  ADD CONSTRAINT `reporting_manager_history_managerId_fkey`
  FOREIGN KEY (`managerId`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
