ALTER TABLE `CdnConfig` ADD COLUMN `storageBaselineBytes` BIGINT NULL;

CREATE TABLE `StorageSpaceReservation` (
  `id` VARCHAR(191) NOT NULL,
  `configId` VARCHAR(191) NOT NULL,
  `keyHash` CHAR(64) NOT NULL,
  `storageKey` VARCHAR(512) NOT NULL,
  `size` BIGINT NOT NULL,
  `quotaRevision` INTEGER NOT NULL,
  `owner` VARCHAR(64) NULL,
  `leaseUntil` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `StorageSpaceReservation_configId_keyHash_key` (`configId`, `keyHash`),
  CONSTRAINT `StorageSpaceReservation_configId_fkey` FOREIGN KEY (`configId`) REFERENCES `CdnConfig` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
