CREATE TABLE `StorageReplica` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(128) NOT NULL,
  `configId` VARCHAR(128) NOT NULL,
  `storageKey` VARCHAR(512) NOT NULL,
  `size` BIGINT NOT NULL,
  `checksum` VARCHAR(128) NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `leaseOwner` VARCHAR(128) NULL,
  `leaseUntil` DATETIME(3) NULL,
  `lastError` VARCHAR(512) NULL,
  `verifiedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `StorageReplica_projectId_storageKey_configId_key` (`projectId`, `storageKey`, `configId`),
  INDEX `StorageReplica_status_nextAttemptAt_idx` (`status`, `nextAttemptAt`),
  INDEX `StorageReplica_leaseUntil_idx` (`leaseUntil`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ShareDownloadSession` (
  `id` VARCHAR(191) NOT NULL,
  `ticketHash` VARCHAR(64) NOT NULL,
  `shareId` VARCHAR(191) NULL,
  `folderShareId` VARCHAR(191) NULL,
  `fileId` VARCHAR(191) NOT NULL,
  `policyHash` VARCHAR(64) NOT NULL,
  `ip` VARCHAR(64) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `consumedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `ShareDownloadSession_ticketHash_key` (`ticketHash`),
  INDEX `ShareDownloadSession_shareId_idx` (`shareId`),
  INDEX `ShareDownloadSession_folderShareId_idx` (`folderShareId`),
  INDEX `ShareDownloadSession_expiresAt_idx` (`expiresAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `StorageReplica` ADD CONSTRAINT `StorageReplica_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `StorageReplica` ADD CONSTRAINT `StorageReplica_configId_fkey` FOREIGN KEY (`configId`) REFERENCES `CdnConfig` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ShareDownloadSession` ADD CONSTRAINT `ShareDownloadSession_shareId_fkey` FOREIGN KEY (`shareId`) REFERENCES `ShareLink` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ShareDownloadSession` ADD CONSTRAINT `ShareDownloadSession_folderShareId_fkey` FOREIGN KEY (`folderShareId`) REFERENCES `FolderShareLink` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
