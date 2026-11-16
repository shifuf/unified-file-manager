-- Preserve existing provider values and config IDs; plugins can introduce new IDs.
ALTER TABLE `CdnConfig` MODIFY `provider` VARCHAR(64) NOT NULL;
