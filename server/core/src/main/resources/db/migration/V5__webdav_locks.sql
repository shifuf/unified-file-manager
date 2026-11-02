CREATE TABLE dav_locks (
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path text NOT NULL,
    token varchar(96) NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (project_id,path)
);
CREATE INDEX idx_dav_locks_expiry ON dav_locks(expires_at);
