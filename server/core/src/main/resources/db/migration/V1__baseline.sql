-- Unified File Manager v2 baseline.
-- The specification labels this baseline as 24 tables but enumerates 27.
-- Every table in the authoritative list is created here.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- UUIDv7 keeps primary keys time-ordered without requiring a second extension.
CREATE OR REPLACE FUNCTION ufm_uuid_v7()
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    timestamp_ms bigint;
    raw_bytes bytea;
BEGIN
    timestamp_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    raw_bytes := substring(int8send(timestamp_ms) FROM 3 FOR 6) || gen_random_bytes(10);
    raw_bytes := set_byte(raw_bytes, 6, (get_byte(raw_bytes, 6) & 15) | 112);
    raw_bytes := set_byte(raw_bytes, 8, (get_byte(raw_bytes, 8) & 63) | 128);
    RETURN encode(raw_bytes, 'hex')::uuid;
END;
$$;

CREATE OR REPLACE FUNCTION ufm_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    username varchar(64) NOT NULL,
    password_hash varchar(255) NOT NULL,
    display_name varchar(128),
    role varchar(24) NOT NULL DEFAULT 'VIEWER'
        CHECK (role IN ('SUPER_ADMIN', 'ADMIN', 'VIEWER')),
    totp_secret_enc text,
    totp_enabled boolean NOT NULL DEFAULT false,
    enabled boolean NOT NULL DEFAULT true,
    last_login_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    CONSTRAINT uk_users_username UNIQUE (username)
);

CREATE TABLE refresh_tokens (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash varchar(128) NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    replaced_by uuid REFERENCES refresh_tokens(id) ON DELETE SET NULL,
    ip inet,
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    CONSTRAINT uk_refresh_tokens_hash UNIQUE (token_hash),
    CONSTRAINT ck_refresh_tokens_expiry CHECK (expires_at > created_at)
);

CREATE TABLE projects (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    app_id varchar(64) NOT NULL,
    name varchar(128) NOT NULL,
    description text,
    secret_hash varchar(128),
    secret_enc text,
    quota_bytes bigint NOT NULL DEFAULT 0 CHECK (quota_bytes >= 0),
    quota_files bigint NOT NULL DEFAULT 0 CHECK (quota_files >= 0),
    used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
    used_files bigint NOT NULL DEFAULT 0 CHECK (used_files >= 0),
    notify_enabled boolean NOT NULL DEFAULT true,
    library_enabled boolean NOT NULL DEFAULT false,
    library_slug varchar(96),
    webdav_enabled boolean NOT NULL DEFAULT false,
    webdav_username varchar(128),
    webdav_password_enc text,
    allowed_domains jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    CONSTRAINT uk_projects_app_id UNIQUE (app_id),
    CONSTRAINT uk_projects_library_slug UNIQUE (library_slug),
    CONSTRAINT ck_projects_allowed_domains CHECK (jsonb_typeof(allowed_domains) = 'array')
);

CREATE TABLE storage_configs (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    name varchar(128) NOT NULL,
    provider varchar(24) NOT NULL
        CHECK (provider IN ('LOCAL', 'QINIU', 'UPYUN', 'OSS', 'S3')),
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    enabled boolean NOT NULL DEFAULT true,
    priority integer NOT NULL DEFAULT 100,
    is_default boolean NOT NULL DEFAULT false,
    storage_quota_bytes bigint CHECK (storage_quota_bytes IS NULL OR storage_quota_bytes >= 0),
    traffic_quota_bytes bigint CHECK (traffic_quota_bytes IS NULL OR traffic_quota_bytes >= 0),
    failover_threshold_pct smallint NOT NULL DEFAULT 90
        CHECK (failover_threshold_pct BETWEEN 1 AND 100),
    auto_failover boolean NOT NULL DEFAULT false,
    manual_storage_bytes bigint CHECK (manual_storage_bytes IS NULL OR manual_storage_bytes >= 0),
    manual_traffic_bytes bigint CHECK (manual_traffic_bytes IS NULL OR manual_traffic_bytes >= 0),
    last_usage jsonb,
    last_health jsonb,
    last_health_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    CONSTRAINT ck_storage_configs_json CHECK (jsonb_typeof(config) = 'object')
);

CREATE TABLE project_storage (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    config_id uuid NOT NULL REFERENCES storage_configs(id) ON DELETE RESTRICT,
    is_active boolean NOT NULL DEFAULT false,
    priority integer NOT NULL DEFAULT 100,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    CONSTRAINT uk_project_storage_binding UNIQUE (project_id, config_id)
);

CREATE TABLE files (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    storage_config_id uuid REFERENCES storage_configs(id) ON DELETE RESTRICT,
    original_name varchar(512) NOT NULL,
    storage_key text NOT NULL,
    mime varchar(255),
    ext varchar(32),
    size bigint NOT NULL DEFAULT 0 CHECK (size >= 0),
    category varchar(24) NOT NULL DEFAULT 'OTHER'
        CHECK (category IN ('IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'ARCHIVE', 'CODE', 'OTHER')),
    status varchar(24) NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'RECYCLED', 'DELETED', 'QUARANTINED')),
    is_public boolean NOT NULL DEFAULT false,
    checksum varchar(128),
    content_text text,
    search_text text,
    content_tsv tsvector GENERATED ALWAYS AS (
        to_tsvector('simple'::regconfig, coalesce(search_text, content_text, ''))
    ) STORED,
    tags jsonb NOT NULL DEFAULT '[]'::jsonb,
    folder_path varchar(2048) NOT NULL DEFAULT '/',
    thumb_url text,
    duplicate_of uuid REFERENCES files(id) ON DELETE SET NULL,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    purge_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    CONSTRAINT uk_files_storage_key UNIQUE (storage_config_id, storage_key),
    CONSTRAINT ck_files_tags CHECK (jsonb_typeof(tags) = 'array'),
    CONSTRAINT ck_files_folder_path CHECK (folder_path LIKE '/%')
);

CREATE TABLE file_versions (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    version integer NOT NULL CHECK (version > 0),
    original_name varchar(512) NOT NULL,
    storage_config_id uuid REFERENCES storage_configs(id) ON DELETE RESTRICT,
    storage_key text NOT NULL,
    mime varchar(255),
    ext varchar(32),
    size bigint NOT NULL DEFAULT 0 CHECK (size >= 0),
    checksum varchar(128),
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    CONSTRAINT uk_file_versions_number UNIQUE (file_id, version)
);

CREATE TABLE file_derivatives (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    kind varchar(24) NOT NULL
        CHECK (kind IN ('THUMB', 'WEBP', 'MP4_720', 'HLS', 'COVER')),
    storage_config_id uuid REFERENCES storage_configs(id) ON DELETE RESTRICT,
    storage_key text NOT NULL,
    mime varchar(255),
    size bigint CHECK (size IS NULL OR size >= 0),
    status varchar(24) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'RUNNING', 'READY', 'FAILED')),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    CONSTRAINT uk_file_derivatives_kind UNIQUE (file_id, kind),
    CONSTRAINT ck_file_derivatives_metadata CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE folders (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path varchar(2048) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    CONSTRAINT uk_folders_path UNIQUE (project_id, path),
    CONSTRAINT ck_folders_path CHECK (path LIKE '/%')
);

CREATE TABLE folder_public_policies (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    folder_path varchar(2048) NOT NULL,
    is_public boolean NOT NULL DEFAULT true,
    allowed_domains jsonb NOT NULL DEFAULT '[]'::jsonb,
    expires_at timestamptz,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    CONSTRAINT uk_folder_public_policies_path UNIQUE (project_id, folder_path),
    CONSTRAINT ck_folder_public_policies_domains CHECK (jsonb_typeof(allowed_domains) = 'array'),
    CONSTRAINT ck_folder_public_policies_path CHECK (folder_path LIKE '/%')
);

CREATE TABLE share_links (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    token varchar(96) NOT NULL,
    custom_path varchar(96),
    password_hash varchar(255),
    expires_at timestamptz,
    max_downloads bigint CHECK (max_downloads IS NULL OR max_downloads >= 0),
    download_count bigint NOT NULL DEFAULT 0 CHECK (download_count >= 0),
    preview_only boolean NOT NULL DEFAULT false,
    allowed_ips jsonb NOT NULL DEFAULT '[]'::jsonb,
    watermark text,
    enabled boolean NOT NULL DEFAULT true,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    CONSTRAINT uk_share_links_token UNIQUE (token),
    CONSTRAINT uk_share_links_custom_path UNIQUE (custom_path),
    CONSTRAINT ck_share_links_ips CHECK (jsonb_typeof(allowed_ips) = 'array')
);

CREATE TABLE folder_share_links (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    folder_id uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    token varchar(96) NOT NULL,
    custom_path varchar(96),
    password_hash varchar(255),
    expires_at timestamptz,
    max_downloads bigint CHECK (max_downloads IS NULL OR max_downloads >= 0),
    download_count bigint NOT NULL DEFAULT 0 CHECK (download_count >= 0),
    preview_only boolean NOT NULL DEFAULT false,
    allowed_ips jsonb NOT NULL DEFAULT '[]'::jsonb,
    watermark text,
    enabled boolean NOT NULL DEFAULT true,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    CONSTRAINT uk_folder_share_links_token UNIQUE (token),
    CONSTRAINT uk_folder_share_links_custom_path UNIQUE (custom_path),
    CONSTRAINT ck_folder_share_links_ips CHECK (jsonb_typeof(allowed_ips) = 'array')
);

CREATE TABLE upload_credentials (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    token_hash varchar(128) NOT NULL,
    scope jsonb NOT NULL DEFAULT '{}'::jsonb,
    max_bytes bigint NOT NULL DEFAULT 0 CHECK (max_bytes >= 0),
    used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
    max_files bigint NOT NULL DEFAULT 0 CHECK (max_files >= 0),
    used_files bigint NOT NULL DEFAULT 0 CHECK (used_files >= 0),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    CONSTRAINT uk_upload_credentials_hash UNIQUE (token_hash),
    CONSTRAINT ck_upload_credentials_scope CHECK (jsonb_typeof(scope) = 'object'),
    CONSTRAINT ck_upload_credentials_usage CHECK (
        used_bytes <= max_bytes AND used_files <= max_files
    )
);

CREATE TABLE project_secrets (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name varchar(96) NOT NULL,
    secret_hash varchar(128) NOT NULL,
    secret_enc text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    CONSTRAINT uk_project_secrets_name UNIQUE (project_id, name)
);

CREATE TABLE tasks (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
    type varchar(48) NOT NULL
        CHECK (type IN (
            'MEDIA_IMAGE', 'MEDIA_VIDEO', 'SEARCH_INDEX', 'STORAGE_MIGRATION',
            'PROJECT_IMPORT', 'PROJECT_PURGE', 'LIFECYCLE', 'BACKUP',
            'NOTIFY', 'MAINTENANCE'
        )),
    status varchar(16) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'RUNNING', 'PAUSED', 'FAILED', 'DONE', 'CANCELED')),
    priority smallint NOT NULL DEFAULT 100,
    progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    result jsonb,
    error text,
    locked_by varchar(128),
    locked_until timestamptz,
    run_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts smallint NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 100),
    idempotency_key varchar(200),
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    started_at timestamptz,
    finished_at timestamptz,
    paused_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    CONSTRAINT ck_tasks_payload CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT ck_tasks_result CHECK (result IS NULL OR jsonb_typeof(result) = 'object')
);

CREATE TABLE download_records (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_id uuid REFERENCES files(id) ON DELETE SET NULL,
    source varchar(24) NOT NULL
        CHECK (source IN ('ADMIN', 'OPEN_API', 'PUBLIC', 'SHARE', 'FOLDER_SHARE', 'WEBDAV', 'BATCH')),
    ip inet,
    user_agent text,
    referer text,
    range_start bigint CHECK (range_start IS NULL OR range_start >= 0),
    range_end bigint CHECK (range_end IS NULL OR range_end >= 0),
    bytes_sent bigint NOT NULL DEFAULT 0 CHECK (bytes_sent >= 0),
    success boolean NOT NULL,
    failure_reason text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE download_daily_stats (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    day date NOT NULL,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_id uuid REFERENCES files(id) ON DELETE SET NULL,
    source varchar(24) NOT NULL
        CHECK (source IN ('ADMIN', 'OPEN_API', 'PUBLIC', 'SHARE', 'FOLDER_SHARE', 'WEBDAV', 'BATCH')),
    download_count bigint NOT NULL DEFAULT 0 CHECK (download_count >= 0),
    bytes_sent bigint NOT NULL DEFAULT 0 CHECK (bytes_sent >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_download_daily_stats UNIQUE (day, project_id, file_id, source)
);

CREATE TABLE access_daily_stats (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    day date NOT NULL,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_id uuid REFERENCES files(id) ON DELETE SET NULL,
    referer_host varchar(255) NOT NULL DEFAULT '',
    access_count bigint NOT NULL DEFAULT 0 CHECK (access_count >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_access_daily_stats UNIQUE (day, project_id, file_id, referer_host)
);

CREATE TABLE share_ip_stats (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    ip inet NOT NULL,
    download_count bigint NOT NULL DEFAULT 0 CHECK (download_count >= 0),
    rate_limit_count bigint NOT NULL DEFAULT 0 CHECK (rate_limit_count >= 0),
    last_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
    last_access_at timestamptz,
    ban_until timestamptz,
    permanent_ban boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_share_ip_stats_ip UNIQUE (ip)
);

CREATE TABLE ip_bans (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    ip inet NOT NULL,
    until timestamptz,
    permanent boolean NOT NULL DEFAULT false,
    reason text,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_ip_bans_ip UNIQUE (ip),
    CONSTRAINT ck_ip_bans_expiry CHECK (permanent OR until IS NOT NULL)
);

CREATE TABLE audit_logs (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    action varchar(96) NOT NULL,
    actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
    project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
    ip inet,
    ua text,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_audit_logs_detail CHECK (jsonb_typeof(detail) = 'object')
);

CREATE TABLE notify_channels (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
    name varchar(128) NOT NULL,
    type varchar(24) NOT NULL CHECK (type IN ('WEBHOOK', 'PUSH_PLATFORM')),
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    events jsonb NOT NULL DEFAULT '[]'::jsonb,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    CONSTRAINT ck_notify_channels_config CHECK (jsonb_typeof(config) = 'object'),
    CONSTRAINT ck_notify_channels_events CHECK (jsonb_typeof(events) = 'array')
);

CREATE TABLE notify_deliveries (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    channel_id uuid NOT NULL REFERENCES notify_channels(id) ON DELETE CASCADE,
    event varchar(96) NOT NULL,
    success boolean NOT NULL,
    status_code integer,
    error text,
    attempt smallint NOT NULL DEFAULT 1 CHECK (attempt > 0),
    response_body text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE notifications (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
    title varchar(255) NOT NULL,
    body text,
    level varchar(16) NOT NULL DEFAULT 'INFO'
        CHECK (level IN ('INFO', 'SUCCESS', 'WARNING', 'ERROR')),
    href text,
    read_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz
);

CREATE TABLE settings (
    key varchar(128) PRIMARY KEY,
    value jsonb NOT NULL,
    description text,
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE backups (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    status varchar(16) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'RUNNING', 'FAILED', 'DONE', 'CANCELED')),
    include_objects boolean NOT NULL DEFAULT false,
    file_name varchar(255) NOT NULL,
    size bigint CHECK (size IS NULL OR size >= 0),
    checksum varchar(128),
    scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
    storage_path text,
    error text,
    started_at timestamptz,
    finished_at timestamptz,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    CONSTRAINT ck_backups_scopes CHECK (jsonb_typeof(scopes) = 'array')
);

CREATE TABLE nonces (
    id uuid PRIMARY KEY DEFAULT ufm_uuid_v7(),
    app_id varchar(64) NOT NULL,
    nonce varchar(128) NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_nonces_app_nonce UNIQUE (app_id, nonce)
);

CREATE UNIQUE INDEX uk_storage_configs_default
    ON storage_configs (is_default)
    WHERE is_default AND deleted_at IS NULL;

CREATE UNIQUE INDEX uk_project_storage_active
    ON project_storage (project_id)
    WHERE is_active AND deleted_at IS NULL;

CREATE UNIQUE INDEX uk_tasks_idempotency
    ON tasks (type, idempotency_key)
    WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX idx_refresh_tokens_user
    ON refresh_tokens (user_id, expires_at)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_projects_deleted
    ON projects (deleted_at)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_storage_configs_priority
    ON storage_configs (priority, created_at)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_project_storage_project
    ON project_storage (project_id)
    WHERE deleted_at IS NULL;

CREATE INDEX idx_files_project_folder
    ON files (project_id, folder_path, created_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_files_project_status
    ON files (project_id, status, created_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_files_checksum
    ON files (project_id, checksum, size)
    WHERE checksum IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_files_storage
    ON files (storage_config_id)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_files_tags ON files USING GIN (tags);
CREATE INDEX idx_files_fts ON files USING GIN (content_tsv);
CREATE INDEX idx_files_purge_at
    ON files (purge_at)
    WHERE purge_at IS NOT NULL AND status = 'RECYCLED';

CREATE INDEX idx_file_versions_file
    ON file_versions (file_id, version DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_file_derivatives_status
    ON file_derivatives (status, created_at)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_folders_project
    ON folders (project_id, path)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_folder_public_policies_public
    ON folder_public_policies (project_id, is_public)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_share_links_file
    ON share_links (file_id, created_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_folder_share_links_folder
    ON folder_share_links (folder_id, created_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_upload_credentials_expiry
    ON upload_credentials (expires_at)
    WHERE revoked_at IS NULL AND deleted_at IS NULL;
CREATE INDEX idx_project_secrets_project
    ON project_secrets (project_id)
    WHERE deleted_at IS NULL;

CREATE INDEX idx_tasks_claim
    ON tasks (priority, created_at)
    WHERE status = 'PENDING' AND deleted_at IS NULL;
CREATE INDEX idx_tasks_expired_lease
    ON tasks (locked_until)
    WHERE status = 'RUNNING' AND deleted_at IS NULL;
CREATE INDEX idx_tasks_project_created
    ON tasks (project_id, created_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX idx_download_records_project_time
    ON download_records (project_id, created_at DESC);
CREATE INDEX idx_download_records_file_time
    ON download_records (file_id, created_at DESC)
    WHERE file_id IS NOT NULL;
CREATE INDEX idx_download_daily_stats_project_day
    ON download_daily_stats (project_id, day DESC);
CREATE INDEX idx_access_daily_stats_project_day
    ON access_daily_stats (project_id, day DESC);
CREATE INDEX idx_ip_bans_until
    ON ip_bans (until)
    WHERE NOT permanent;
CREATE INDEX idx_audit_logs_project_time
    ON audit_logs (project_id, created_at DESC);
CREATE INDEX idx_audit_logs_actor_time
    ON audit_logs (actor_id, created_at DESC);
CREATE INDEX idx_notify_channels_project
    ON notify_channels (project_id)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_notify_deliveries_channel_time
    ON notify_deliveries (channel_id, created_at DESC);
CREATE INDEX idx_notifications_user_unread
    ON notifications (user_id, created_at DESC)
    WHERE read_at IS NULL AND deleted_at IS NULL;
CREATE INDEX idx_backups_status
    ON backups (status, created_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_nonces_expiry ON nonces (expires_at);

CREATE OR REPLACE FUNCTION ufm_claim_task(
    p_worker_id text,
    p_lease_seconds integer DEFAULT 600
)
RETURNS SETOF tasks
LANGUAGE plpgsql
AS $$
DECLARE
    claimed_id uuid;
BEGIN
    IF p_worker_id IS NULL OR btrim(p_worker_id) = '' THEN
        RAISE EXCEPTION 'worker id is required';
    END IF;
    IF p_lease_seconds < 1 OR p_lease_seconds > 86400 THEN
        RAISE EXCEPTION 'lease seconds must be between 1 and 86400';
    END IF;

    SELECT candidate.id
    INTO claimed_id
    FROM tasks candidate
    WHERE candidate.status = 'PENDING'
      AND candidate.run_at <= clock_timestamp()
      AND candidate.attempts < candidate.max_attempts
      AND candidate.deleted_at IS NULL
    ORDER BY candidate.priority, candidate.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1;

    IF claimed_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    UPDATE tasks task
    SET status = 'RUNNING',
        locked_by = p_worker_id,
        locked_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
        attempts = task.attempts + 1,
        started_at = coalesce(task.started_at, clock_timestamp()),
        finished_at = NULL,
        error = NULL
    WHERE task.id = claimed_id
    RETURNING task.*;
END;
$$;

CREATE OR REPLACE FUNCTION ufm_heartbeat_task(
    p_task_id uuid,
    p_worker_id text,
    p_lease_seconds integer DEFAULT 600
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    renewed boolean := false;
BEGIN
    IF p_lease_seconds < 1 OR p_lease_seconds > 86400 THEN
        RAISE EXCEPTION 'lease seconds must be between 1 and 86400';
    END IF;

    UPDATE tasks
    SET locked_until = clock_timestamp() + make_interval(secs => p_lease_seconds)
    WHERE id = p_task_id
      AND status = 'RUNNING'
      AND locked_by = p_worker_id
      AND deleted_at IS NULL
    RETURNING true INTO renewed;

    RETURN coalesce(renewed, false);
END;
$$;

CREATE OR REPLACE FUNCTION ufm_recover_expired_tasks()
RETURNS TABLE (task_id uuid, final_status varchar)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    UPDATE tasks task
    SET status = CASE
            WHEN task.attempts >= task.max_attempts THEN 'FAILED'
            ELSE 'PENDING'
        END,
        locked_by = NULL,
        locked_until = NULL,
        finished_at = CASE
            WHEN task.attempts >= task.max_attempts THEN clock_timestamp()
            ELSE NULL
        END,
        error = concat_ws(E'\n', task.error, 'worker lease expired')
    WHERE task.status = 'RUNNING'
      AND task.locked_until < clock_timestamp()
      AND task.deleted_at IS NULL
    RETURNING task.id, task.status::varchar;
END;
$$;

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'users', 'refresh_tokens', 'projects', 'storage_configs', 'project_storage',
        'files', 'file_versions', 'file_derivatives', 'folders',
        'folder_public_policies', 'share_links', 'folder_share_links',
        'upload_credentials', 'project_secrets', 'tasks', 'download_records',
        'download_daily_stats', 'access_daily_stats', 'share_ip_stats', 'ip_bans',
        'audit_logs', 'notify_channels', 'notify_deliveries', 'notifications',
        'settings', 'backups', 'nonces'
    ]
    LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION ufm_touch_updated_at()',
            table_name,
            table_name
        );
    END LOOP;
END;
$$;

COMMENT ON COLUMN files.search_text IS
    'Application-tokenized text. The future upload pipeline writes jieba tokens here.';
COMMENT ON COLUMN files.content_tsv IS
    'Generated simple-configuration tsvector over search_text with content_text fallback.';
