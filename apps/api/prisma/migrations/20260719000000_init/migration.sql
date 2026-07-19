-- Unified File Manager · baseline schema
-- Single init migration for fresh deploys (Prisma migrate deploy).
-- Generated from prisma/schema.prisma.

-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(191) NOT NULL,
    `username` VARCHAR(64) NOT NULL,
    `displayName` VARCHAR(64) NOT NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `role` ENUM('SUPER_ADMIN') NOT NULL DEFAULT 'SUPER_ADMIN',
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `mustChangePassword` BOOLEAN NOT NULL DEFAULT false,
    `totpSecret` VARCHAR(512) NULL,
    `totpEnabled` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_username_key`(`username`),
    INDEX `User_role_enabled_idx`(`role`, `enabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Project` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `description` VARCHAR(512) NULL,
    `appId` VARCHAR(48) NOT NULL,
    `appSecretHash` VARCHAR(255) NOT NULL,
    `appSecretVault` TEXT NOT NULL,
    `activeCdnConfigId` VARCHAR(191) NULL,
    `allowedDomains` JSON NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `notifyEnabled` BOOLEAN NOT NULL DEFAULT true,
    `publicLibraryEnabled` BOOLEAN NOT NULL DEFAULT false,
    `publicLibrarySlug` VARCHAR(64) NULL,
    `quotaBytes` BIGINT NULL,
    `quotaFiles` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Project_appId_key`(`appId`),
    UNIQUE INDEX `Project_publicLibrarySlug_key`(`publicLibrarySlug`),
    INDEX `Project_name_idx`(`name`),
    INDEX `Project_activeCdnConfigId_idx`(`activeCdnConfigId`),
    INDEX `Project_publicLibraryEnabled_publicLibrarySlug_idx`(`publicLibraryEnabled`, `publicLibrarySlug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CdnConfig` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NULL,
    `provider` ENUM('LOCAL', 'QINIU', 'UPYUN', 'ALIYUN', 'S3') NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `config` JSON NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT false,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CdnConfig_projectId_active_idx`(`projectId`, `active`),
    INDEX `CdnConfig_enabled_provider_idx`(`enabled`, `provider`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ManagedFile` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `cdnConfigId` VARCHAR(191) NULL,
    `originalName` VARCHAR(255) NOT NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `mimeType` VARCHAR(128) NOT NULL,
    `extension` VARCHAR(32) NOT NULL,
    `size` BIGINT NOT NULL,
    `category` ENUM('IMAGE', 'DOCUMENT', 'VIDEO', 'AUDIO', 'ARCHIVE', 'CODE', 'OTHER') NOT NULL,
    `status` ENUM('ACTIVE', 'RECYCLED', 'DELETED', 'QUARANTINED') NOT NULL DEFAULT 'ACTIVE',
    `scanStatus` ENUM('SKIPPED', 'PENDING', 'CLEAN', 'INFECTED', 'ERROR') NOT NULL DEFAULT 'SKIPPED',
    `scanDetail` VARCHAR(512) NULL,
    `scannedAt` DATETIME(3) NULL,
    `isPublic` BOOLEAN NOT NULL DEFAULT false,
    `indexedAt` DATETIME(3) NULL,
    `contentText` LONGTEXT NULL,
    `checksum` VARCHAR(128) NULL,
    `publicUrl` VARCHAR(1024) NULL,
    `remark` VARCHAR(512) NULL,
    `tags` VARCHAR(512) NULL,
    `folderPath` VARCHAR(512) NULL,
    `thumbnailUrl` VARCHAR(1024) NULL,
    `duplicateOfId` VARCHAR(191) NULL,
    `uploadedById` VARCHAR(191) NULL,
    `currentVersion` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,
    `purgeAt` DATETIME(3) NULL,

    INDEX `ManagedFile_projectId_status_category_idx`(`projectId`, `status`, `category`),
    INDEX `ManagedFile_projectId_status_folderPath_idx`(`projectId`, `status`, `folderPath`),
    INDEX `ManagedFile_projectId_checksum_idx`(`projectId`, `checksum`),
    INDEX `ManagedFile_projectId_isPublic_status_idx`(`projectId`, `isPublic`, `status`),
    INDEX `ManagedFile_projectId_scanStatus_idx`(`projectId`, `scanStatus`),
    INDEX `ManagedFile_duplicateOfId_idx`(`duplicateOfId`),
    INDEX `ManagedFile_originalName_idx`(`originalName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FileDerivative` (
    `id` VARCHAR(191) NOT NULL,
    `fileId` VARCHAR(191) NOT NULL,
    `kind` ENUM('THUMB', 'WEBP', 'MP4_720', 'HLS', 'COVER') NOT NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `mimeType` VARCHAR(128) NOT NULL,
    `size` BIGINT NOT NULL DEFAULT 0,
    `status` ENUM('PENDING', 'READY', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `publicUrl` VARCHAR(1024) NULL,
    `meta` JSON NULL,
    `error` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `FileDerivative_status_createdAt_idx`(`status`, `createdAt`),
    UNIQUE INDEX `FileDerivative_fileId_kind_key`(`fileId`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShareLink` (
    `id` VARCHAR(191) NOT NULL,
    `fileId` VARCHAR(191) NOT NULL,
    `token` VARCHAR(64) NOT NULL,
    `customPath` VARCHAR(200) NULL,
    `passwordHash` VARCHAR(255) NULL,
    `expiresAt` DATETIME(3) NULL,
    `maxDownloads` INTEGER NULL,
    `downloadCount` INTEGER NOT NULL DEFAULT 0,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `previewOnly` BOOLEAN NOT NULL DEFAULT false,
    `allowedIps` JSON NULL,
    `watermarkText` VARCHAR(128) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ShareLink_token_key`(`token`),
    UNIQUE INDEX `ShareLink_customPath_key`(`customPath`),
    INDEX `ShareLink_fileId_enabled_idx`(`fileId`, `enabled`),
    INDEX `ShareLink_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProjectSecret` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `secretHash` VARCHAR(255) NOT NULL,
    `secretVault` TEXT NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `lastUsedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ProjectSecret_projectId_enabled_idx`(`projectId`, `enabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UploadCredential` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `tokenHash` VARCHAR(128) NOT NULL,
    `tokenPrefix` VARCHAR(16) NOT NULL,
    `scope` JSON NOT NULL,
    `maxBytes` BIGINT NULL,
    `usedBytes` BIGINT NOT NULL DEFAULT 0,
    `maxFiles` INTEGER NULL,
    `usedFiles` INTEGER NOT NULL DEFAULT 0,
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `UploadCredential_tokenHash_key`(`tokenHash`),
    INDEX `UploadCredential_projectId_expiresAt_idx`(`projectId`, `expiresAt`),
    INDEX `UploadCredential_revokedAt_expiresAt_idx`(`revokedAt`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OutboundWebhook` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NULL,
    `name` VARCHAR(128) NOT NULL,
    `url` VARCHAR(1024) NOT NULL,
    `secret` VARCHAR(255) NULL,
    `events` JSON NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `OutboundWebhook_enabled_idx`(`enabled`),
    INDEX `OutboundWebhook_projectId_enabled_idx`(`projectId`, `enabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WebhookDelivery` (
    `id` VARCHAR(191) NOT NULL,
    `webhookId` VARCHAR(191) NOT NULL,
    `event` VARCHAR(64) NOT NULL,
    `success` BOOLEAN NOT NULL,
    `statusCode` INTEGER NULL,
    `error` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `WebhookDelivery_webhookId_createdAt_idx`(`webhookId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FolderPublicPolicy` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `folderPath` VARCHAR(512) NOT NULL,
    `isPublic` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `FolderPublicPolicy_projectId_isPublic_idx`(`projectId`, `isPublic`),
    UNIQUE INDEX `FolderPublicPolicy_projectId_folderPath_key`(`projectId`, `folderPath`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FileVersion` (
    `id` VARCHAR(191) NOT NULL,
    `fileId` VARCHAR(191) NOT NULL,
    `version` INTEGER NOT NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `cdnConfigId` VARCHAR(191) NULL,
    `size` BIGINT NOT NULL,
    `checksum` VARCHAR(128) NULL,
    `mimeType` VARCHAR(128) NOT NULL,
    `originalName` VARCHAR(255) NOT NULL,
    `createdById` VARCHAR(191) NULL,
    `remark` VARCHAR(256) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `FileVersion_fileId_createdAt_idx`(`fileId`, `createdAt`),
    UNIQUE INDEX `FileVersion_fileId_version_key`(`fileId`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Notification` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(160) NOT NULL,
    `body` VARCHAR(1024) NULL,
    `level` VARCHAR(16) NOT NULL,
    `href` VARCHAR(512) NULL,
    `readAt` DATETIME(3) NULL,
    `meta` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Notification_userId_readAt_createdAt_idx`(`userId`, `readAt`, `createdAt`),
    INDEX `Notification_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LifecyclePolicy` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `folderPath` VARCHAR(512) NULL,
    `category` ENUM('IMAGE', 'DOCUMENT', 'VIDEO', 'AUDIO', 'ARCHIVE', 'CODE', 'OTHER') NULL,
    `ttlDays` INTEGER NOT NULL,
    `action` VARCHAR(32) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `lastRunAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `LifecyclePolicy_projectId_enabled_idx`(`projectId`, `enabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FolderShareLink` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `folderPath` VARCHAR(512) NOT NULL,
    `token` VARCHAR(64) NOT NULL,
    `passwordHash` VARCHAR(255) NULL,
    `expiresAt` DATETIME(3) NULL,
    `maxDownloads` INTEGER NULL,
    `downloadCount` INTEGER NOT NULL DEFAULT 0,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `previewOnly` BOOLEAN NOT NULL DEFAULT false,
    `allowedIps` JSON NULL,
    `watermarkText` VARCHAR(128) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `FolderShareLink_token_key`(`token`),
    INDEX `FolderShareLink_projectId_folderPath_enabled_idx`(`projectId`, `folderPath`, `enabled`),
    INDEX `FolderShareLink_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Task` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NULL,
    `type` VARCHAR(64) NOT NULL,
    `title` VARCHAR(160) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `progress` INTEGER NOT NULL DEFAULT 0,
    `detail` JSON NULL,
    `result` JSON NULL,
    `error` VARCHAR(1024) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `finishedAt` DATETIME(3) NULL,

    INDEX `Task_projectId_createdAt_idx`(`projectId`, `createdAt`),
    INDEX `Task_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `Task_type_createdAt_idx`(`type`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuditLog` (
    `id` VARCHAR(191) NOT NULL,
    `action` ENUM('LOGIN', 'USER_CREATE', 'USER_UPDATE', 'USER_DISABLE', 'USER_PASSWORD_CHANGE', 'USER_2FA_ENABLE', 'USER_2FA_DISABLE', 'PROJECT_CREATE', 'PROJECT_UPDATE', 'PROJECT_DELETE', 'PROJECT_MEMBER_ADD', 'PROJECT_MEMBER_UPDATE', 'PROJECT_MEMBER_REMOVE', 'PROJECT_SECRET_RESET', 'PROJECT_SECRET_CREATE', 'PROJECT_SECRET_DISABLE', 'PROJECT_EXPORT', 'PROJECT_IMPORT', 'CDN_CREATE', 'CDN_UPDATE', 'CDN_ACTIVATE', 'CDN_DELETE', 'CDN_HEALTH_CHECK', 'FILE_UPLOAD', 'FILE_DOWNLOAD', 'FILE_UPDATE', 'FILE_DELETE', 'FILE_RESTORE', 'FILE_PURGE', 'FILE_MOVE', 'FILE_COPY', 'FILE_BATCH_DELETE', 'FILE_BATCH_RESTORE', 'FILE_BATCH_PURGE', 'FILE_BATCH_MOVE', 'FILE_BATCH_COPY', 'FILE_SHARE_CREATE', 'FILE_SHARE_UPDATE', 'FILE_SHARE_DELETE', 'FILE_SHARE_DOWNLOAD', 'FILE_SCAN', 'FILE_QUARANTINE', 'FILE_PUBLISH', 'FILE_UNPUBLISH', 'SETTING_UPDATE', 'AUDIT_LOG_CLEANUP', 'TASK_CREATE', 'TASK_UPDATE', 'TASK_CANCEL', 'TASK_RETRY', 'TASK_DELETE', 'SYSTEM_HEALTH_CHECK', 'NOTIFY_TEST', 'NOTIFY_SEND', 'UPLOAD_CREDENTIAL_CREATE', 'UPLOAD_CREDENTIAL_REVOKE', 'WEBHOOK_DELIVERY', 'WEBHOOK_CREATE', 'WEBHOOK_UPDATE', 'WEBHOOK_DELETE', 'FOLDER_PUBLIC_SET', 'FOLDER_PUBLIC_UNSET', 'FOLDER_BATCH_PUBLISH', 'FILE_VERSION_CREATE', 'FILE_VERSION_RESTORE', 'STORAGE_MIGRATE', 'SESSION_REVOKE', 'LIFECYCLE_RUN', 'FOLDER_SHARE_CREATE', 'FOLDER_SHARE_UPDATE', 'FOLDER_SHARE_DELETE', 'FOLDER_SHARE_DOWNLOAD', 'NOTIFICATION_READ', 'AUDIT_EXPORT', 'FILE_QUARANTINE_RELEASE') NOT NULL,
    `actorId` VARCHAR(191) NULL,
    `projectId` VARCHAR(191) NULL,
    `ip` VARCHAR(64) NULL,
    `userAgent` VARCHAR(255) NULL,
    `detail` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AuditLog_action_createdAt_idx`(`action`, `createdAt`),
    INDEX `AuditLog_projectId_createdAt_idx`(`projectId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SystemSetting` (
    `key` VARCHAR(128) NOT NULL,
    `value` JSON NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShareIpStat` (
    `id` VARCHAR(191) NOT NULL,
    `ip` VARCHAR(64) NOT NULL,
    `downloadCount` INTEGER NOT NULL DEFAULT 0,
    `rateLimitCount` INTEGER NOT NULL DEFAULT 0,
    `lastDownloadAt` DATETIME(3) NULL,
    `lastRateLimitedAt` DATETIME(3) NULL,
    `permanentBan` BOOLEAN NOT NULL DEFAULT false,
    `banUntil` DATETIME(3) NULL,
    `banReason` VARCHAR(512) NULL,
    `notes` VARCHAR(512) NULL,
    `lastShareId` VARCHAR(64) NULL,
    `lastFileName` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ShareIpStat_ip_key`(`ip`),
    INDEX `ShareIpStat_permanentBan_banUntil_idx`(`permanentBan`, `banUntil`),
    INDEX `ShareIpStat_downloadCount_idx`(`downloadCount`),
    INDEX `ShareIpStat_rateLimitCount_idx`(`rateLimitCount`),
    INDEX `ShareIpStat_lastDownloadAt_idx`(`lastDownloadAt`),
    INDEX `ShareIpStat_updatedAt_idx`(`updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OpenApiNonce` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(48) NOT NULL,
    `nonce` VARCHAR(128) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OpenApiNonce_expiresAt_idx`(`expiresAt`),
    UNIQUE INDEX `OpenApiNonce_appId_nonce_key`(`appId`, `nonce`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RefreshToken` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(128) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `replacedById` VARCHAR(191) NULL,
    `userAgent` VARCHAR(255) NULL,
    `ip` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `RefreshToken_tokenHash_key`(`tokenHash`),
    INDEX `RefreshToken_userId_idx`(`userId`),
    INDEX `RefreshToken_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FileAccessDailyStat` (
    `id` VARCHAR(191) NOT NULL,
    `day` DATE NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `fileId` VARCHAR(191) NULL,
    `refererHost` VARCHAR(255) NOT NULL DEFAULT '',
    `hits` INTEGER NOT NULL DEFAULT 0,
    `bytes` BIGINT NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `FileAccessDailyStat_projectId_day_idx`(`projectId`, `day`),
    INDEX `FileAccessDailyStat_day_hits_idx`(`day`, `hits`),
    INDEX `FileAccessDailyStat_day_bytes_idx`(`day`, `bytes`),
    UNIQUE INDEX `FileAccessDailyStat_day_projectId_fileId_refererHost_key`(`day`, `projectId`, `fileId`, `refererHost`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Project` ADD CONSTRAINT `Project_activeCdnConfigId_fkey` FOREIGN KEY (`activeCdnConfigId`) REFERENCES `CdnConfig`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CdnConfig` ADD CONSTRAINT `CdnConfig_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ManagedFile` ADD CONSTRAINT `ManagedFile_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ManagedFile` ADD CONSTRAINT `ManagedFile_cdnConfigId_fkey` FOREIGN KEY (`cdnConfigId`) REFERENCES `CdnConfig`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ManagedFile` ADD CONSTRAINT `ManagedFile_uploadedById_fkey` FOREIGN KEY (`uploadedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FileDerivative` ADD CONSTRAINT `FileDerivative_fileId_fkey` FOREIGN KEY (`fileId`) REFERENCES `ManagedFile`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShareLink` ADD CONSTRAINT `ShareLink_fileId_fkey` FOREIGN KEY (`fileId`) REFERENCES `ManagedFile`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProjectSecret` ADD CONSTRAINT `ProjectSecret_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UploadCredential` ADD CONSTRAINT `UploadCredential_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UploadCredential` ADD CONSTRAINT `UploadCredential_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OutboundWebhook` ADD CONSTRAINT `OutboundWebhook_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WebhookDelivery` ADD CONSTRAINT `WebhookDelivery_webhookId_fkey` FOREIGN KEY (`webhookId`) REFERENCES `OutboundWebhook`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FolderPublicPolicy` ADD CONSTRAINT `FolderPublicPolicy_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FileVersion` ADD CONSTRAINT `FileVersion_fileId_fkey` FOREIGN KEY (`fileId`) REFERENCES `ManagedFile`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Notification` ADD CONSTRAINT `Notification_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LifecyclePolicy` ADD CONSTRAINT `LifecyclePolicy_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FolderShareLink` ADD CONSTRAINT `FolderShareLink_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Task` ADD CONSTRAINT `Task_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AuditLog` ADD CONSTRAINT `AuditLog_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AuditLog` ADD CONSTRAINT `AuditLog_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RefreshToken` ADD CONSTRAINT `RefreshToken_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
