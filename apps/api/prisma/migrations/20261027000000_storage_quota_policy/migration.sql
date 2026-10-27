ALTER TABLE `CdnConfig`
  ADD COLUMN `priority` INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN `storageQuotaBytes` BIGINT NULL,
  ADD COLUMN `manualStorageUsedBytes` BIGINT NULL,
  ADD COLUMN `trafficQuotaBytes` BIGINT NULL,
  ADD COLUMN `manualTrafficUsedBytes` BIGINT NULL,
  ADD COLUMN `failoverThresholdPercent` DOUBLE NOT NULL DEFAULT 90,
  ADD COLUMN `autoFailover` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `manualUsageUpdatedAt` DATETIME(3) NULL;
