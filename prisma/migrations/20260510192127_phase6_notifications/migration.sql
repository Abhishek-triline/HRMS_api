-- CreateTable
CREATE TABLE `notifications` (
    `id` VARCHAR(191) NOT NULL,
    `recipientId` VARCHAR(191) NOT NULL,
    `category` ENUM('Leave', 'Attendance', 'Payroll', 'Performance', 'Status', 'Configuration', 'Auth', 'System') NOT NULL,
    `title` VARCHAR(120) NOT NULL,
    `body` VARCHAR(600) NOT NULL,
    `link` VARCHAR(191) NULL,
    `unread` BOOLEAN NOT NULL DEFAULT true,
    `auditLogId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notifications_recipientId_unread_idx`(`recipientId`, `unread`),
    INDEX `notifications_recipientId_createdAt_idx`(`recipientId`, `createdAt` DESC),
    INDEX `notifications_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_recipientId_fkey` FOREIGN KEY (`recipientId`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
