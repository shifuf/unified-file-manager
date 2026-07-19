/** Console is single super-admin only. */
export type UserRole = 'SUPER_ADMIN';
export type CdnProvider = 'LOCAL' | 'QINIU' | 'UPYUN' | 'ALIYUN' | 'S3';
export type FileCategory = 'IMAGE' | 'DOCUMENT' | 'VIDEO' | 'AUDIO' | 'ARCHIVE' | 'CODE' | 'OTHER';
export type FileStatus = 'ACTIVE' | 'RECYCLED' | 'DELETED' | 'QUARANTINED';
export type ScanStatus = 'SKIPPED' | 'PENDING' | 'CLEAN' | 'INFECTED' | 'ERROR';
export type AuditAction =
  | 'LOGIN'
  | 'USER_CREATE'
  | 'USER_UPDATE'
  | 'USER_DISABLE'
  | 'USER_PASSWORD_CHANGE'
  | 'USER_2FA_ENABLE'
  | 'USER_2FA_DISABLE'
  | 'PROJECT_CREATE'
  | 'PROJECT_UPDATE'
  | 'PROJECT_DELETE'
  | 'PROJECT_MEMBER_ADD'
  | 'PROJECT_MEMBER_UPDATE'
  | 'PROJECT_MEMBER_REMOVE'
  | 'PROJECT_SECRET_RESET'
  | 'PROJECT_SECRET_CREATE'
  | 'PROJECT_SECRET_DISABLE'
  | 'PROJECT_EXPORT'
  | 'PROJECT_IMPORT'
  | 'CDN_CREATE'
  | 'CDN_UPDATE'
  | 'CDN_ACTIVATE'
  | 'CDN_DELETE'
  | 'CDN_HEALTH_CHECK'
  | 'FILE_UPLOAD'
  | 'FILE_DOWNLOAD'
  | 'FILE_UPDATE'
  | 'FILE_DELETE'
  | 'FILE_RESTORE'
  | 'FILE_PURGE'
  | 'FILE_MOVE'
  | 'FILE_COPY'
  | 'FILE_BATCH_DELETE'
  | 'FILE_BATCH_RESTORE'
  | 'FILE_BATCH_PURGE'
  | 'FILE_BATCH_MOVE'
  | 'FILE_BATCH_COPY'
  | 'FILE_SHARE_CREATE'
  | 'FILE_SHARE_UPDATE'
  | 'FILE_SHARE_DELETE'
  | 'FILE_SHARE_DOWNLOAD'
  | 'FILE_SCAN'
  | 'FILE_QUARANTINE'
  | 'FILE_PUBLISH'
  | 'FILE_UNPUBLISH'
  | 'SETTING_UPDATE'
  | 'AUDIT_LOG_CLEANUP'
  | 'TASK_CREATE'
  | 'TASK_UPDATE'
  | 'TASK_CANCEL'
  | 'TASK_RETRY'
  | 'TASK_DELETE'
  | 'SYSTEM_HEALTH_CHECK'
  | 'NOTIFY_TEST'
  | 'NOTIFY_SEND'
  | 'UPLOAD_CREDENTIAL_CREATE'
  | 'UPLOAD_CREDENTIAL_REVOKE'
  | 'WEBHOOK_DELIVERY'
  | 'WEBHOOK_CREATE'
  | 'WEBHOOK_UPDATE'
  | 'WEBHOOK_DELETE'
  | 'FOLDER_PUBLIC_SET'
  | 'FOLDER_PUBLIC_UNSET'
  | 'FOLDER_BATCH_PUBLISH'
  | 'FILE_VERSION_CREATE'
  | 'FILE_VERSION_RESTORE'
  | 'STORAGE_MIGRATE'
  | 'SESSION_REVOKE'
  | 'LIFECYCLE_RUN'
  | 'FOLDER_SHARE_CREATE'
  | 'FOLDER_SHARE_UPDATE'
  | 'FOLDER_SHARE_DELETE'
  | 'FOLDER_SHARE_DOWNLOAD'
  | 'NOTIFICATION_READ'
  | 'AUDIT_EXPORT'
  | 'FILE_QUARANTINE_RELEASE';

export type ShareStatus = 'ACTIVE' | 'DISABLED' | 'EXPIRED' | 'EXHAUSTED';

export interface SharePageBrand {
  title: string;
  subtitle: string;
  logoUrl: string;
  primaryColor: string;
  background: string;
  panelBackground: string;
  footerText: string;
  showPoweredBy: boolean;
}

export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  totpEnabled: boolean;
  mustChangePassword?: boolean;
}

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  appId: string;
  allowedDomains: string[];
  activeCdnProvider?: CdnProvider | null;
  activeCdnName?: string | null;
  fileCount: number;
  enabled: boolean;
  notifyEnabled?: boolean;
  publicLibraryEnabled?: boolean;
  publicLibrarySlug?: string | null;
  quotaBytes?: number | null;
  quotaFiles?: number | null;
  canManage: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CdnConfig {
  id: string;
  projectId?: string | null;
  provider: CdnProvider;
  name: string;
  config: Record<string, unknown>;
  active: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedFile {
  id: string;
  projectId: string;
  projectName?: string | null;
  originalName: string;
  mimeType: string;
  extension: string;
  size: number;
  category: FileCategory;
  status: FileStatus;
  scanStatus?: ScanStatus;
  scanDetail?: string | null;
  scannedAt?: string | null;
  isPublic?: boolean;
  checksum?: string | null;
  publicUrl?: string | null;
  accessUrl?: string | null;
  remark?: string | null;
  tags: string[];
  folderPath?: string | null;
  thumbnailUrl?: string | null;
  duplicateOfId?: string | null;
  duplicate: boolean;
  /** True when this upload response reused an existing content-addressed object. */
  duplicateReused?: boolean;
  currentVersion?: number;
  previewable: boolean;
  progressiveUrl?: string | null;
  hlsUrl?: string | null;
  cdnProvider?: CdnProvider | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  purgeAt?: string | null;
}

export interface ShareLink {
  id: string;
  fileId: string;
  projectId: string;
  projectName?: string | null;
  fileName: string;
  fileSize: number;
  fileCategory: FileCategory;
  token: string;
  customPath?: string | null;
  url: string;
  downloadUrl: string;
  hasPassword: boolean;
  expiresAt?: string | null;
  maxDownloads?: number | null;
  downloadCount: number;
  remainingDownloads?: number | null;
  enabled: boolean;
  previewOnly: boolean;
  allowedIps: string[];
  watermarkText?: string | null;
  status: ShareStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PublicShareInfo {
  token: string;
  customPath?: string | null;
  fileName: string;
  mimeType: string;
  category: FileCategory;
  size: number;
  previewable: boolean;
  previewOnly: boolean;
  hasWatermark: boolean;
  hasPassword: boolean;
  expiresAt?: string | null;
  maxDownloads?: number | null;
  downloadCount: number;
  remainingDownloads?: number | null;
  enabled: boolean;
  status: ShareStatus;
  brand?: SharePageBrand;
}

export interface ProjectSecret {
  id: string;
  name: string;
  enabled: boolean;
  lastUsedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectStats {
  projectId: string;
  fileCount: number;
  totalSize: number;
  usedBytes?: number;
  usedFiles?: number;
  quotaBytes?: number | null;
  quotaFiles?: number | null;
  bytesUsagePercent?: number | null;
  filesUsagePercent?: number | null;
  notifyEnabled?: boolean;
  publicLibraryEnabled?: boolean;
  publicLibrarySlug?: string | null;
  duplicateCount: number;
  shareLinkCount: number;
  activeSecretCount: number;
  byStatus: Record<string, number>;
  byCategory: Partial<Record<FileCategory, { count: number; size: number }>>;
  byProvider: Record<string, { count: number; size: number }>;
  byFolder: Record<string, { count: number; size: number }>;
  uploadTrend?: Array<{ date: string; count: number; size: number }>;
  topFilesBySize?: Array<{
    id: string;
    originalName: string;
    size: number;
    category: FileCategory;
    folderPath?: string | null;
    mimeType?: string;
    createdAt?: string;
  }>;
}

export interface TaskItem {
  id: string;
  projectId?: string | null;
  project?: { id: string; name: string } | null;
  type: string;
  title: string;
  status: string;
  progress: number;
  detail?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string | null;
}

export interface StorageUsageResult {
  provider: CdnProvider;
  name: string;
  configId: string;
  supported: boolean;
  storageUsedBytes: number | null;
  storageQuotaBytes: number | null;
  trafficUsedBytes: number | null;
  trafficQuotaBytes: number | null;
  checkedAt: string;
  message?: string;
}

export interface StorageHealthResult {
  success: boolean;
  provider: CdnProvider;
  name: string;
  checkedAt: string;
  checks: Array<{
    name: string;
    status: 'PASS' | 'WARN' | 'FAIL';
    message: string;
  }>;
  usage?: StorageUsageResult | null;
}

export interface SystemHealth {
  status: 'OK' | 'DEGRADED';
  checkedAt: string;
  database: Record<string, unknown>;
  runtime: Record<string, unknown>;
  counts: Record<string, number>;
  settings: Record<string, unknown>;
}

export interface LocalFileMigrationSummary {
  projectId: string;
  targetConfigId: string;
  targetProvider: CdnProvider;
  scanned: number;
  migrated: number;
  skipped: number;
  failed: number;
  failures: Array<{
    fileId: string;
    originalName: string;
    reason: string;
  }>;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AuditLog {
  id: string;
  action: AuditAction;
  actor?: { id: string; username: string; displayName: string } | null;
  project?: { id: string; name: string } | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown> | null;
  createdAt: string;
}
