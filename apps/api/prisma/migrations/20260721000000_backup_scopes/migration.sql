-- Selective backup/restore: record which data domains a backup covers.
ALTER TABLE `Backup` ADD COLUMN `scopes` JSON NULL AFTER `tableRows`;
