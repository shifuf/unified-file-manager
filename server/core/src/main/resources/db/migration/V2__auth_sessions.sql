ALTER TABLE users
    ADD COLUMN password_changed_at timestamptz NOT NULL DEFAULT clock_timestamp();

ALTER TABLE refresh_tokens
    ADD COLUMN last_used_at timestamptz;

CREATE INDEX idx_refresh_tokens_active
    ON refresh_tokens (user_id, expires_at)
    WHERE revoked_at IS NULL AND deleted_at IS NULL;
