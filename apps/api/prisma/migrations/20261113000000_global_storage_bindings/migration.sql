CREATE TABLE `ProjectStorageBinding` (
  `projectId` VARCHAR(191) NOT NULL,
  `configId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`projectId`, `configId`),
  INDEX `ProjectStorageBinding_configId_idx` (`configId`),
  CONSTRAINT `ProjectStorageBinding_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `ProjectStorageBinding_configId_fkey` FOREIGN KEY (`configId`) REFERENCES `CdnConfig` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT IGNORE INTO `ProjectStorageBinding` (`projectId`, `configId`)
  SELECT `id`, `activeCdnConfigId` FROM `Project` WHERE `activeCdnConfigId` IS NOT NULL;
INSERT IGNORE INTO `ProjectStorageBinding` (`projectId`, `configId`)
  SELECT `projectId`, `id` FROM `CdnConfig` WHERE `projectId` IS NOT NULL;
UPDATE `CdnConfig` SET `projectId` = NULL;
