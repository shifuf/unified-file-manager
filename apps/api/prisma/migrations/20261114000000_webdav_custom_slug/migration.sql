ALTER TABLE `Project` ADD COLUMN `webdavSlug` VARCHAR(64) NULL;
CREATE UNIQUE INDEX `Project_webdavSlug_key` ON `Project`(`webdavSlug`);
UPDATE `Project` SET `webdavSlug` = LOWER(HEX(RANDOM_BYTES(12)))
WHERE `webdavEnabled` = true AND `webdavSlug` IS NULL;
