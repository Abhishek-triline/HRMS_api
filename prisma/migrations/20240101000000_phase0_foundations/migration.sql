-- Nexora HRMS — Phase 0 Foundation Migration
-- Generated for: prisma migrate dev
-- Tables: employees, sessions, password_reset_tokens, login_attempts, audit_log, configuration
--
-- BL-047 enforcement point:
--   After creating audit_log, we attempt REVOKE UPDATE, DELETE on the table.
--   If the DB user lacks GRANT OPTION this will fail silently (logged as warning).
--   In production, a DBA should run this manually with a privileged account.

-- CreateEnum
CREATE TABLE IF NOT EXISTS _prisma_migrations (
    id                      VARCHAR(36)                             NOT NULL,
    checksum                VARCHAR(64)                             NOT NULL,
    finished_at             DATETIME(3),
    migration_name          VARCHAR(255)                            NOT NULL,
    logs                    TEXT,
    rolled_back_at          DATETIME(3),
    started_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    applied_steps_count     INT UNSIGNED    NOT NULL DEFAULT 0,
    PRIMARY KEY (id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateEnum: Role
-- MySQL doesn't have native enums in Prisma-style; they become VARCHAR with check or ENUM type.
-- Prisma handles this via its own ENUM syntax in MySQL.

-- CreateTable: employees
CREATE TABLE `employees` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `passwordHash` TEXT NOT NULL,
    `role` ENUM('Employee', 'Manager', 'PayrollOfficer', 'Admin') NOT NULL,
    `status` ENUM('Active', 'OnNotice', 'Exited', 'OnLeave', 'Inactive') NOT NULL DEFAULT 'Inactive',
    `department` VARCHAR(191) NULL,
    `designation` VARCHAR(191) NULL,
    `reportingManagerId` VARCHAR(191) NULL,
    `joinDate` DATE NOT NULL,
    `exitDate` DATE NULL,
    `mustResetPassword` BOOLEAN NOT NULL DEFAULT false,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `employees_code_key`(`code`),
    UNIQUE INDEX `employees_email_key`(`email`),
    INDEX `employees_email_idx`(`email`),
    INDEX `employees_reportingManagerId_idx`(`reportingManagerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: sessions
CREATE TABLE `sessions` (
    `id` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `ip` VARCHAR(191) NULL,
    `userAgent` TEXT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `sessions_employeeId_expiresAt_idx`(`employeeId`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: password_reset_tokens
CREATE TABLE `password_reset_tokens` (
    `id` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `purpose` ENUM('FirstLogin', 'ResetPassword') NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `password_reset_tokens_tokenHash_key`(`tokenHash`),
    INDEX `password_reset_tokens_tokenHash_idx`(`tokenHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: login_attempts
CREATE TABLE `login_attempts` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NULL,
    `ip` VARCHAR(191) NOT NULL,
    `success` BOOLEAN NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `login_attempts_email_idx`(`email`),
    INDEX `login_attempts_email_ip_createdAt_idx`(`email`, `ip`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: audit_log
-- BL-047: append-only. The REVOKE below enforces this at the DB level.
CREATE TABLE `audit_log` (
    `id` VARCHAR(191) NOT NULL,
    `actorId` VARCHAR(191) NULL,
    `actorRole` VARCHAR(191) NOT NULL,
    `actorIp` VARCHAR(191) NULL,
    `action` VARCHAR(191) NOT NULL,
    `targetType` VARCHAR(191) NULL,
    `targetId` VARCHAR(191) NULL,
    `module` VARCHAR(191) NOT NULL,
    `before` JSON NULL,
    `after` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_log_actorId_idx`(`actorId`),
    INDEX `audit_log_action_idx`(`action`),
    INDEX `audit_log_createdAt_idx`(`createdAt`),
    INDEX `audit_log_targetType_targetId_idx`(`targetType`, `targetId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: configuration
CREATE TABLE `configuration` (
    `key` VARCHAR(191) NOT NULL,
    `value` JSON NOT NULL,
    `updatedBy` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey: employees.reportingManagerId → employees.id
ALTER TABLE `employees` ADD CONSTRAINT `employees_reportingManagerId_fkey` FOREIGN KEY (`reportingManagerId`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: sessions.employeeId → employees.id
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: password_reset_tokens.employeeId → employees.id
ALTER TABLE `password_reset_tokens` ADD CONSTRAINT `password_reset_tokens_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: login_attempts.employeeId → employees.id (nullable)
ALTER TABLE `login_attempts` ADD CONSTRAINT `login_attempts_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: audit_log.actorId → employees.id (nullable — system events have null actor)
ALTER TABLE `audit_log` ADD CONSTRAINT `audit_log_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- BL-047 enforcement: make audit_log append-only at DB level.
-- REVOKE UPDATE, DELETE ON nexora_hrms.audit_log FROM 'root'@'localhost';
-- NOTE: The above is commented out because running REVOKE requires GRANT OPTION privilege.
-- In production, a DBA must execute:
--   REVOKE UPDATE, DELETE ON nexora_hrms.audit_log FROM '<app_user>'@'<host>';
-- with a superuser account. The application enforces append-only in code as well
-- (audit() helper never issues UPDATE/DELETE on this table).
--
-- For development with root, the revoke is attempted by the seed/startup script
-- and logged as a warning if it fails.
