-- CreateTable
CREATE TABLE `performance_cycles` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `fyStart` DATE NOT NULL,
    `fyEnd` DATE NOT NULL,
    `status` ENUM('Open', 'SelfReview', 'ManagerReview', 'Closed') NOT NULL DEFAULT 'Open',
    `selfReviewDeadline` DATE NOT NULL,
    `managerReviewDeadline` DATE NOT NULL,
    `closedAt` DATETIME(3) NULL,
    `closedBy` VARCHAR(191) NULL,
    `createdBy` VARCHAR(191) NOT NULL,
    `participants` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `performance_cycles_code_key`(`code`),
    INDEX `performance_cycles_status_idx`(`status`),
    INDEX `performance_cycles_fyStart_idx`(`fyStart`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `performance_reviews` (
    `id` VARCHAR(191) NOT NULL,
    `cycleId` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `managerId` VARCHAR(191) NULL,
    `previousManagerId` VARCHAR(191) NULL,
    `selfRating` INTEGER NULL,
    `selfNote` TEXT NULL,
    `selfSubmittedAt` DATETIME(3) NULL,
    `managerRating` INTEGER NULL,
    `managerNote` TEXT NULL,
    `managerSubmittedAt` DATETIME(3) NULL,
    `managerOverrodeSelf` BOOLEAN NOT NULL DEFAULT false,
    `finalRating` INTEGER NULL,
    `lockedAt` DATETIME(3) NULL,
    `isMidCycleJoiner` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,

    INDEX `performance_reviews_cycleId_managerId_idx`(`cycleId`, `managerId`),
    INDEX `performance_reviews_employeeId_idx`(`employeeId`),
    UNIQUE INDEX `performance_reviews_cycleId_employeeId_key`(`cycleId`, `employeeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `goals` (
    `id` VARCHAR(191) NOT NULL,
    `reviewId` VARCHAR(191) NOT NULL,
    `text` TEXT NOT NULL,
    `outcome` ENUM('Met', 'Partial', 'Missed', 'Pending') NOT NULL DEFAULT 'Pending',
    `proposedByEmployee` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `version` INTEGER NOT NULL DEFAULT 0,

    INDEX `goals_reviewId_idx`(`reviewId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `performance_cycles` ADD CONSTRAINT `performance_cycles_closedBy_fkey` FOREIGN KEY (`closedBy`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `performance_cycles` ADD CONSTRAINT `performance_cycles_createdBy_fkey` FOREIGN KEY (`createdBy`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `performance_reviews` ADD CONSTRAINT `performance_reviews_cycleId_fkey` FOREIGN KEY (`cycleId`) REFERENCES `performance_cycles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `performance_reviews` ADD CONSTRAINT `performance_reviews_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `performance_reviews` ADD CONSTRAINT `performance_reviews_managerId_fkey` FOREIGN KEY (`managerId`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `performance_reviews` ADD CONSTRAINT `performance_reviews_previousManagerId_fkey` FOREIGN KEY (`previousManagerId`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goals` ADD CONSTRAINT `goals_reviewId_fkey` FOREIGN KEY (`reviewId`) REFERENCES `performance_reviews`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
