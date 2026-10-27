-- Project-level WebDAV credentials (each project owns its own dav account)
ALTER TABLE `Project`
  ADD COLUMN `webdavEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `webdavUsername` VARCHAR(64) NULL,
  ADD COLUMN `webdavPasswordHash` VARCHAR(255) NULL,
  ADD COLUMN `webdavPasswordVault` TEXT NULL;

-- Per-download audit trail: who downloaded which file, from where, how many bytes.
CREATE TABLE `DownloadRecord` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `fileId` VARCHAR(191) NULL,
    `originalName` VARCHAR(255) NULL,
    `size` BIGINT NOT NULL DEFAULT 0,
    `source` ENUM('ADMIN','OPEN_API','PUBLIC','SHARE','FOLDER_SHARE','WEBDAV','BATCH') NOT NULL DEFAULT 'ADMIN',
    `actorId` VARCHAR(191) NULL,
    `shareId` VARCHAR(191) NULL,
    `ip` VARCHAR(64) NULL,
    `userAgent` VARCHAR(512) NULL,
    `referer` VARCHAR(512) NULL,
    `rangeStart` BIGINT NULL,
    `rangeEnd` BIGINT NULL,
    `success` BOOLEAN NOT NULL DEFAULT true,
    `message` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DownloadRecord_projectId_createdAt_idx`(`projectId`, `createdAt`),
    INDEX `DownloadRecord_fileId_createdAt_idx`(`fileId`, `createdAt`),
    INDEX `DownloadRecord_source_createdAt_idx`(`source`, `createdAt`),
    INDEX `DownloadRecord_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Rolled-up counters so the console can render "traffic / hits / top files" cheaply.
CREATE TABLE `DownloadDailyStat` (
    `id` VARCHAR(191) NOT NULL,
    `day` DATE NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `fileId` VARCHAR(191) NULL,
    `source` ENUM('ADMIN','OPEN_API','PUBLIC','SHARE','FOLDER_SHARE','WEBDAV','BATCH') NOT NULL,
    `count` INTEGER NOT NULL DEFAULT 0,
    `bytes` BIGINT NOT NULL DEFAULT 0,
    `successCount` INTEGER NOT NULL DEFAULT 0,
    `failedCount` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DownloadDailyStat_day_projectId_fileId_source_key`(`day`, `projectId`, `fileId`, `source`),
    INDEX `DownloadDailyStat_projectId_day_idx`(`projectId`, `day`),
    INDEX `DownloadDailyStat_fileId_day_idx`(`fileId`, `day`),
    INDEX `DownloadDailyStat_day_bytes_idx`(`day`, `bytes`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `DownloadRecord` ADD CONSTRAINT `DownloadRecord_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `DownloadRecord` ADD CONSTRAINT `DownloadRecord_fileId_fkey` FOREIGN KEY (`fileId`) REFERENCES `ManagedFile`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
-- Explicit folder registry so empty folders survive (folders used to exist only as
-- a side effect of ManagedFile.folderPath). Required for both the console "new
-- folder" action and WebDAV MKCOL, which must round-trip through PROPFIND.
CREATE TABLE `ManagedFolder` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `path` VARCHAR(512) NOT NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ManagedFolder_projectId_path_key`(`projectId`, `path`),
    INDEX `ManagedFolder_projectId_path_idx`(`projectId`, `path`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ManagedFolder` ADD CONSTRAINT `ManagedFolder_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
-- Audit actions for the backup module.
ALTER TABLE `AuditLog` MODIFY COLUMN `action` ENUM('LOGIN','USER_CREATE','USER_UPDATE','USER_DISABLE','USER_PASSWORD_CHANGE','USER_2FA_ENABLE','USER_2FA_DISABLE','PROJECT_CREATE','PROJECT_UPDATE','PROJECT_DELETE','PROJECT_MEMBER_ADD','PROJECT_MEMBER_UPDATE','PROJECT_MEMBER_REMOVE','PROJECT_SECRET_RESET','PROJECT_SECRET_CREATE','PROJECT_SECRET_DISABLE','PROJECT_EXPORT','PROJECT_IMPORT','CDN_CREATE','CDN_UPDATE','CDN_ACTIVATE','CDN_DELETE','CDN_HEALTH_CHECK','FILE_UPLOAD','FILE_DOWNLOAD','FILE_UPDATE','FILE_DELETE','FILE_RESTORE','FILE_PURGE','FILE_MOVE','FILE_COPY','FILE_BATCH_DELETE','FILE_BATCH_RESTORE','FILE_BATCH_PURGE','FILE_BATCH_MOVE','FILE_BATCH_COPY','FILE_SHARE_CREATE','FILE_SHARE_UPDATE','FILE_SHARE_DELETE','FILE_SHARE_DOWNLOAD','FILE_SCAN','FILE_QUARANTINE','FILE_PUBLISH','FILE_UNPUBLISH','SETTING_UPDATE','AUDIT_LOG_CLEANUP','TASK_CREATE','TASK_UPDATE','TASK_CANCEL','TASK_RETRY','TASK_DELETE','SYSTEM_HEALTH_CHECK','NOTIFY_TEST','NOTIFY_SEND','UPLOAD_CREDENTIAL_CREATE','UPLOAD_CREDENTIAL_REVOKE','WEBHOOK_DELIVERY','WEBHOOK_CREATE','WEBHOOK_UPDATE','WEBHOOK_DELETE','FOLDER_PUBLIC_SET','FOLDER_PUBLIC_UNSET','FOLDER_BATCH_PUBLISH','FILE_VERSION_CREATE','FILE_VERSION_RESTORE','STORAGE_MIGRATE','SESSION_REVOKE','LIFECYCLE_RUN','FOLDER_SHARE_CREATE','FOLDER_SHARE_UPDATE','FOLDER_SHARE_DELETE','FOLDER_SHARE_DOWNLOAD','NOTIFICATION_READ','AUDIT_EXPORT','FILE_QUARANTINE_RELEASE','BACKUP_CREATE','BACKUP_DOWNLOAD','BACKUP_RESTORE','BACKUP_DELETE') NOT NULL;

-- Full logical backups (all tables, optionally including LOCAL storage objects).
CREATE TABLE `Backup` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `status` ENUM('PENDING','RUNNING','SUCCEEDED','FAILED') NOT NULL DEFAULT 'PENDING',
    `includeObjects` BOOLEAN NOT NULL DEFAULT false,
    `fileName` VARCHAR(255) NULL,
    `fileSize` BIGINT NOT NULL DEFAULT 0,
    `checksum` VARCHAR(64) NULL,
    `tableCounts` JSON NULL,
    `tableRows` JSON NULL,
    `objectCount` INTEGER NOT NULL DEFAULT 0,
    `objectBytes` BIGINT NOT NULL DEFAULT 0,
    `message` TEXT NULL,
    `createdById` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Backup_createdAt_idx`(`createdAt`),
    INDEX `Backup_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
