ALTER TABLE `Task`
  ADD COLUMN `leaseOwner` VARCHAR(128) NULL,
  ADD COLUMN `leaseUntil` DATETIME(3) NULL;

CREATE INDEX `Task_type_status_leaseUntil_idx` ON `Task`(`type`, `status`, `leaseUntil`);
