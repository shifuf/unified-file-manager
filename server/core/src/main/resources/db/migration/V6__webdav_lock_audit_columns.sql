ALTER TABLE dav_locks ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE dav_locks ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE TRIGGER trg_dav_locks_updated_at BEFORE UPDATE ON dav_locks
FOR EACH ROW EXECUTE FUNCTION ufm_touch_updated_at();
