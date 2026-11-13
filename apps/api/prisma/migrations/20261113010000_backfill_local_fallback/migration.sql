-- Prior releases used the enabled global LOCAL fallback when no active target
-- was recorded. Preserve that effective target as an explicit binding.
INSERT IGNORE INTO `ProjectStorageBinding` (`projectId`, `configId`)
  SELECT p.`id`, fallback.`id`
  FROM `Project` p
  CROSS JOIN (
    SELECT `id` FROM `CdnConfig`
    WHERE `provider` = 'LOCAL' AND `enabled` = TRUE AND `projectId` IS NULL
    ORDER BY `priority` ASC, `createdAt` ASC
    LIMIT 1
  ) fallback
  WHERE p.`activeCdnConfigId` IS NULL AND p.`deletedAt` IS NULL;

UPDATE `Project`
SET `activeCdnConfigId` = (
  SELECT `id` FROM `CdnConfig`
  WHERE `provider` = 'LOCAL' AND `enabled` = TRUE AND `projectId` IS NULL
  ORDER BY `priority` ASC, `createdAt` ASC
  LIMIT 1
)
WHERE `activeCdnConfigId` IS NULL AND `deletedAt` IS NULL;
