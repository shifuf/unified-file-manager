ALTER TABLE files ADD COLUMN note text;
ALTER TABLE files DROP CONSTRAINT uk_files_storage_key;
CREATE INDEX idx_files_storage_object ON files(storage_config_id,storage_key);
CREATE INDEX idx_files_dedup ON files(project_id,checksum,size) WHERE status='ACTIVE' AND deleted_at IS NULL;
