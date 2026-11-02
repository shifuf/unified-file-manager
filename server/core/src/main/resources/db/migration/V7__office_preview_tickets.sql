-- 外部 Office 预览的一次性取件票据：只保存令牌摘要，短时有效，单次消费。
CREATE TABLE office_preview_tickets (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    token_hash char(64) NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_office_preview_tickets_token UNIQUE (token_hash)
);

CREATE INDEX idx_office_preview_tickets_expiry ON office_preview_tickets (expires_at);
