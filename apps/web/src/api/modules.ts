import type {
  AuditAction,
  AuditLog,
  CdnConfig,
  CdnProvider,
  FileCategory,
  FileStatus,
  LocalFileMigrationSummary,
  ManagedFile,
  PageResult,
  Project,
  ProjectSecret,
  PublicShareInfo,
  ProjectStats,
  ShareStatus,
  ShareLink,
  StorageHealthResult,
  StorageUsageResult,
  SystemHealth,
  TaskItem,
  UserProfile,
} from '@/types';

import { http } from './http';


export interface LoginSuccessResult {
  requiresTotp: false;
  /** Cookie-based sessions may omit body tokens. */
  accessToken?: string;
  refreshToken?: string;
  user: UserProfile;
}

export interface LoginTotpRequiredResult {
  requiresTotp: true;
}

export type LoginResult = LoginSuccessResult | LoginTotpRequiredResult;

export interface TotpSetupResult {
  secret: string;
  otpauthUrl: string;
  issuer: string;
  account: string;
  enabled: boolean;
}

export const authApi = {
  login(payload: { username: string; password: string; totpCode?: string }) {
    return http.post<unknown, LoginResult>('/auth/login', payload);
  },
  refresh(refreshToken?: string) {
    return http.post<unknown, LoginSuccessResult>(
      '/auth/refresh',
      refreshToken ? { refreshToken } : {},
      { _silent: true },
    );
  },
  logout(refreshToken?: string) {
    return http.post<unknown, { success: boolean }>(
      '/auth/logout',
      refreshToken ? { refreshToken } : {},
      { _silent: true },
    );
  },
  profile() {
    return http.get<unknown, UserProfile>('/auth/profile');
  },
  totpStatus() {
    return http.get<unknown, { enabled: boolean }>('/auth/2fa/status');
  },
  setupTotp() {
    return http.post<unknown, TotpSetupResult>('/auth/2fa/setup');
  },
  enableTotp(code: string) {
    return http.post<unknown, { enabled: boolean }>('/auth/2fa/enable', { code });
  },
  disableTotp(code: string) {
    return http.post<unknown, { enabled: boolean }>('/auth/2fa/disable', { code });
  },
  changePassword(payload: { currentPassword: string; newPassword: string }) {
    return http.post<unknown, { success: boolean }>('/auth/password', payload);
  },
};

export const projectApi = {
  list(keyword?: string) {
    return http.get<unknown, Project[]>('/projects', { params: { keyword } });
  },
  get(projectId: string) {
    return http.get<unknown, Project>(`/projects/${projectId}`);
  },
  create(payload: {
    name: string;
    description?: string;
    allowedDomains?: string[];
    notifyEnabled?: boolean;
    publicLibraryEnabled?: boolean;
    publicLibrarySlug?: string | null;
    quotaBytes?: number | null;
    quotaFiles?: number | null;
  }) {
    return http.post<unknown, Project & { appSecret: string; secretNotice: string }>('/projects', payload);
  },
  update(
    projectId: string,
    payload: {
      name?: string;
      description?: string;
      allowedDomains?: string[];
      notifyEnabled?: boolean;
      publicLibraryEnabled?: boolean;
      publicLibrarySlug?: string | null;
      quotaBytes?: number | null;
      quotaFiles?: number | null;
    },
  ) {
    return http.put<unknown, Project>(`/projects/${projectId}`, payload);
  },
  remove(projectId: string) {
    return http.delete<unknown, { success: boolean }>(`/projects/${projectId}`);
  },
  resetSecret(projectId: string) {
    return http.post<unknown, { appId: string; appSecret: string; secretNotice: string }>(
      `/projects/${projectId}/secret/reset`,
    );
  },
  stats(projectId: string) {
    return http.get<unknown, ProjectStats>(`/projects/${projectId}/stats`);
  },
  hotspots(projectId: string, params?: { days?: number; limit?: number }) {
    return http.get<
      unknown,
      {
        days: number;
        byReferer: Array<{ refererHost: string; hits: number; bytes: number }>;
        byFile: Array<{
          fileId: string | null;
          originalName: string | null;
          hits: number;
          bytes: number;
        }>;
      }
    >(`/projects/${projectId}/hotspots`, { params });
  },
  export(projectId: string) {
    return http.get<unknown, Record<string, unknown>>(`/projects/${projectId}/export`);
  },
  import(payload: Record<string, unknown>) {
    return http.post<unknown, Project & { appSecret: string; secretNotice: string; fileRecordsImported: number }>(
      '/projects/import',
      payload,
    );
  },
  listSecrets(projectId: string) {
    return http.get<unknown, ProjectSecret[]>(`/projects/${projectId}/secrets`);
  },
  createSecret(projectId: string, payload: { name?: string }) {
    return http.post<unknown, ProjectSecret & { appSecret: string; secretNotice: string }>(
      `/projects/${projectId}/secrets`,
      payload,
    );
  },
  disableSecret(projectId: string, secretId: string) {
    return http.delete<unknown, { success: boolean }>(`/projects/${projectId}/secrets/${secretId}`);
  },
};

export const cdnApi = {
  list(projectId?: string) {
    const url = projectId ? `/projects/${projectId}/storage-configs` : '/storage-configs';
    return http.get<unknown, CdnConfig[]>(url);
  },
  create(payload: { provider: CdnProvider; name: string; config: Record<string, unknown> }, projectId?: string) {
    const url = projectId ? `/projects/${projectId}/storage-configs` : '/storage-configs';
    return http.post<unknown, CdnConfig>(url, payload);
  },
  update(
    configId: string,
    payload: Partial<{ provider: CdnProvider; name: string; config: Record<string, unknown> }>,
    projectId?: string,
  ) {
    const url = projectId ? `/projects/${projectId}/storage-configs/${configId}` : `/storage-configs/${configId}`;
    return http.put<unknown, CdnConfig>(url, payload);
  },
  activate(projectId: string, configId: string) {
    return http.post<unknown, CdnConfig>(`/projects/${projectId}/storage-configs/${configId}/select`);
  },
  remove(configId: string, projectId?: string) {
    const url = projectId ? `/projects/${projectId}/storage-configs/${configId}` : `/storage-configs/${configId}`;
    return http.delete<unknown, { success: boolean }>(url);
  },
  test(configId: string, projectId?: string) {
    const url = projectId
      ? `/projects/${projectId}/storage-configs/${configId}/test`
      : `/storage-configs/${configId}/test`;
    return http.post<unknown, StorageHealthResult>(url);
  },
  usage(configId: string, projectId?: string) {
    const url = projectId
      ? `/projects/${projectId}/storage-configs/${configId}/usage`
      : `/storage-configs/${configId}/usage`;
    return http.get<unknown, StorageUsageResult>(url);
  },
};

export const fileApi = {
  list(params: {
    projectId?: string;
    keyword?: string;
    category?: FileCategory | '';
    status?: FileStatus;
    tag?: string;
    folderPath?: string;
    extension?: string;
    cdnProvider?: CdnProvider | '';
    minSize?: number;
    maxSize?: number;
    uploadedStartAt?: string;
    uploadedEndAt?: string;
    duplicateOnly?: boolean;
    page?: number;
    pageSize?: number;
  }) {
    return http.get<unknown, PageResult<ManagedFile>>('/files', { params: compactParams(params) });
  },
  upload(
    projectId: string,
    formData: FormData,
    options: {
      folderPath?: string;
      duplicateStrategy?: 'reject' | 'reuse' | 'replace';
      targetFileId?: string;
      onUploadProgress?: (progress: number) => void;
    } = {},
  ) {
    return http.post<unknown, ManagedFile[]>(`/projects/${projectId}/files`, formData, {
      timeout: 0,
      params: compactParams({
        folderPath: options.folderPath,
        duplicateStrategy: options.duplicateStrategy,
        targetFileId: options.targetFileId,
      }),
      onUploadProgress: (event) => {
        if (event.total && options.onUploadProgress) {
          options.onUploadProgress(Math.round((event.loaded / event.total) * 100));
        }
      },
    });
  },
  initChunkedUpload(
    projectId: string,
    payload: {
      fileName: string;
      size: number;
      totalChunks: number;
      mimeType?: string;
      folderPath?: string;
      duplicateStrategy?: 'reject' | 'reuse' | 'replace';
      targetFileId?: string;
    },
  ) {
    return http.post<unknown, { uploadId: string; received: number[]; totalChunks: number }>(
      `/projects/${projectId}/uploads/init`,
      compactParams(payload),
    );
  },
  getChunkStatus(projectId: string, uploadId: string) {
    return http.get<unknown, { uploadId: string; fileName: string; totalChunks: number; received: number[] }>(
      `/projects/${projectId}/uploads/${uploadId}`,
    );
  },
  uploadChunk(projectId: string, uploadId: string, chunkIndex: number, chunk: Blob) {
    const formData = new FormData();
    formData.append('files', chunk, `chunk-${chunkIndex}`);
    return http.put<unknown, { received: number; totalChunks: number }>(
      `/projects/${projectId}/uploads/${uploadId}/chunks/${chunkIndex}`,
      formData,
      { timeout: 0 },
    );
  },
  completeChunkedUpload(projectId: string, uploadId: string) {
    return http.post<unknown, ManagedFile>(`/projects/${projectId}/uploads/${uploadId}/complete`, {});
  },
  abortChunkedUpload(projectId: string, uploadId: string) {
    return http.delete<unknown, { success: boolean }>(`/projects/${projectId}/uploads/${uploadId}`);
  },
  /**
   * Upload one file in resumable chunks. Each chunk is retried independently so a
   * transient failure only re-sends that chunk instead of the whole file.
   */
  async uploadResumable(
    projectId: string,
    file: File,
    options: {
      folderPath?: string;
      chunkSize?: number;
      duplicateStrategy?: 'reject' | 'reuse' | 'replace';
      targetFileId?: string;
      onProgress?: (progress: number) => void;
    } = {},
  ): Promise<ManagedFile> {
    const chunkSize = options.chunkSize ?? 5 * 1024 * 1024;
    const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
    const init = await fileApi.initChunkedUpload(projectId, {
      fileName: file.name,
      size: file.size,
      totalChunks,
      mimeType: file.type || undefined,
      folderPath: options.folderPath,
      duplicateStrategy: options.duplicateStrategy,
      targetFileId: options.targetFileId,
    });
    const received = new Set(init.received);

    for (let index = 0; index < totalChunks; index += 1) {
      if (!received.has(index)) {
        const start = index * chunkSize;
        const chunk = file.slice(start, Math.min(start + chunkSize, file.size));
        await uploadChunkWithRetry(projectId, init.uploadId, index, chunk);
      }
      options.onProgress?.(Math.round(((index + 1) / totalChunks) * 100));
    }

    return fileApi.completeChunkedUpload(projectId, init.uploadId);
  },
  update(fileId: string, payload: {
    originalName?: string;
    remark?: string;
    tags?: string[];
    folderPath?: string;
    isPublic?: boolean;
  }) {
    return http.put<unknown, ManagedFile>(`/files/${fileId}`, payload);
  },
  remove(fileId: string) {
    return http.delete<unknown, { success: boolean }>(`/files/${fileId}`);
  },
  restore(fileId: string) {
    return http.post<unknown, ManagedFile>(`/files/${fileId}/restore`);
  },
  purge(fileId: string) {
    return http.delete<unknown, { success: boolean }>(`/files/${fileId}/purge`);
  },
  batchDownload(fileIds: string[]) {
    return http.post<unknown, Blob>(
      '/files/batch-download',
      { fileIds },
      {
        responseType: 'blob',
        timeout: 0,
      },
    );
  },
  batchRecycle(fileIds: string[]) {
    return http.post<unknown, { success: boolean; total: number }>('/files/batch/recycle', { fileIds });
  },
  batchRestore(fileIds: string[]) {
    return http.post<unknown, { success: boolean; total: number }>('/files/batch/restore', { fileIds });
  },
  batchPurge(fileIds: string[]) {
    return http.post<unknown, { success: boolean; total: number; purged: number; failed: number }>('/files/batch/purge', {
      fileIds,
    });
  },
  move(fileId: string, payload: { folderPath?: string | null }) {
    return http.post<unknown, ManagedFile>(`/files/${fileId}/move`, payload);
  },
  copy(fileId: string, payload: { projectId?: string; folderPath?: string | null }) {
    return http.post<unknown, ManagedFile>(`/files/${fileId}/copy`, compactUndefinedParams(payload));
  },
  batchMove(fileIds: string[], folderPath?: string | null) {
    return http.post<unknown, { success: boolean; total: number }>('/files/batch/move', { fileIds, folderPath });
  },
  batchCopy(fileIds: string[], folderPath?: string | null, projectId?: string) {
    return http.post<unknown, { success: boolean; total: number; copied: number; failed: number }>(
      '/files/batch/copy',
      compactUndefinedParams({ fileIds, folderPath, projectId }),
    );
  },
  download(fileId: string) {
    return http.get<unknown, Blob>(`/files/${fileId}/download`, {
      responseType: 'blob',
      timeout: 0,
    });
  },
  migrateLocalFiles(projectId: string) {
    return http.post<unknown, LocalFileMigrationSummary>(`/projects/${projectId}/files/migrate-local`);
  },
  listFolders(projectId: string) {
    return http.get<unknown, string[]>(`/projects/${projectId}/files/folders`);
  },
  listFolderTree(projectId: string) {
    return http.get<
      unknown,
      Array<{ name: string; path: string; fileCount: number; children: unknown[] }>
    >(`/projects/${projectId}/files/folder-tree`);
  },
  createShare(
    fileId: string,
    payload: {
      password?: string;
      expiresAt?: string;
      maxDownloads?: number | null;
      previewOnly?: boolean;
      allowedIps?: string[];
      watermarkText?: string;
      customPath?: string;
    },
  ) {
    return http.post<unknown, ShareLink>(`/files/${fileId}/shares`, compactParams(payload));
  },
  listShares(fileId: string) {
    return http.get<unknown, ShareLink[]>(`/files/${fileId}/shares`);
  },
  updateShare(
    shareId: string,
    payload: {
      password?: string;
      clearPassword?: boolean;
      expiresAt?: string | null;
      maxDownloads?: number | null;
      enabled?: boolean;
      previewOnly?: boolean;
      allowedIps?: string[];
      watermarkText?: string;
      customPath?: string | null;
    },
  ) {
    // No compaction here: undefined fields are dropped by JSON serialization, while
    // explicit '' / null / [] are sent so the caller can clear watermark/expiry/IPs/path.
    return http.put<unknown, ShareLink>(`/file-shares/${shareId}`, payload);
  },
  disableShare(shareId: string) {
    return http.delete<unknown, { success: boolean }>(`/file-shares/${shareId}`);
  },
  listAllShares(params: {
    projectId?: string;
    keyword?: string;
    status?: ShareStatus | '';
    page?: number;
    pageSize?: number;
  }) {
    return http.get<unknown, PageResult<ShareLink>>('/file-shares', { params: compactParams(params) });
  },
  listVersions(fileId: string) {
    return http.get<
      unknown,
      Array<{
        id: string;
        version: number;
        size: number;
        originalName: string;
        mimeType: string;
        checksum?: string | null;
        createdAt: string;
        remark?: string | null;
      }>
    >(`/files/${fileId}/versions`);
  },
  restoreVersion(fileId: string, version: number) {
    return http.post<unknown, ManagedFile>(`/files/${fileId}/versions/${version}/restore`);
  },
};

export const folderPublicApi = {
  list(projectId: string) {
    return http.get<
      unknown,
      Array<{ id: string; projectId: string; folderPath: string; isPublic: boolean; createdAt: string; updatedAt: string }>
    >(`/projects/${projectId}/folder-public`);
  },
  upsert(projectId: string, payload: { folderPath?: string | null; isPublic: boolean }) {
    return http.put<
      unknown,
      { id: string; projectId: string; folderPath: string; isPublic: boolean }
    >(`/projects/${projectId}/folder-public`, payload);
  },
  remove(projectId: string, folderPath?: string | null) {
    return http.delete<unknown, { success: boolean }>(`/projects/${projectId}/folder-public`, {
      data: { folderPath: folderPath ?? '' },
    });
  },
  batchPublish(
    projectId: string,
    payload: { folderPath?: string | null; isPublic: boolean; recursive?: boolean },
  ) {
    return http.post<unknown, { success: boolean; updated: number }>(
      `/projects/${projectId}/folder-public/batch-publish`,
      payload,
    );
  },
};

export const uploadCredentialApi = {
  list(projectId: string) {
    return http.get<
      unknown,
      Array<{
        id: string;
        name: string;
        tokenPrefix: string;
        maxBytes?: number | null;
        usedBytes: number;
        maxFiles?: number | null;
        usedFiles: number;
        expiresAt: string;
        revokedAt?: string | null;
        status: string;
        scope?: Record<string, unknown>;
        createdAt: string;
      }>
    >(`/projects/${projectId}/upload-credentials`);
  },
  create(
    projectId: string,
    payload: {
      name: string;
      expiresInSeconds?: number;
      maxBytes?: number | null;
      maxFiles?: number | null;
      folderPath?: string | null;
      allowedMimeTypes?: string[];
    },
  ) {
    return http.post<
      unknown,
      {
        id: string;
        name: string;
        token: string;
        tokenPrefix: string;
        expiresAt: string;
        notice?: string;
      }
    >(`/projects/${projectId}/upload-credentials`, payload);
  },
  revoke(projectId: string, credentialId: string) {
    return http.delete<unknown, { success: boolean }>(
      `/projects/${projectId}/upload-credentials/${credentialId}`,
    );
  },
  presign(
    projectId: string,
    payload: { fileName: string; size: number; mimeType?: string; folderPath?: string | null },
  ) {
    return http.post<
      unknown,
      {
        supported: boolean;
        mode?: string;
        message?: string;
        provider?: string;
        storageKey?: string;
        uploadUrl?: string;
        uploadToken?: string;
        formFields?: Record<string, string>;
        headers?: Record<string, string>;
        publicUrl?: string;
        expiresAt?: string;
        method?: 'POST' | 'PUT';
        folderPath?: string | null;
        credentialId?: string | null;
      }
    >(`/projects/${projectId}/uploads/presign`, payload);
  },
  completePresign(
    projectId: string,
    payload: {
      storageKey: string;
      fileName: string;
      size: number;
      mimeType?: string;
      folderPath?: string | null;
      publicUrl?: string | null;
      checksum?: string | null;
      credentialId?: string | null;
      cdnConfigId?: string | null;
      duplicateStrategy?: 'reject' | 'reuse' | 'replace';
    },
  ) {
    return http.post<unknown, ManagedFile>(`/projects/${projectId}/uploads/complete-presign`, payload);
  },
  /**
   * Try direct-to-CDN upload; fall back to chunked upload when unsupported.
   */
  async uploadDirectOrResumable(
    projectId: string,
    file: File,
    options: {
      folderPath?: string;
      duplicateStrategy?: 'reject' | 'reuse' | 'replace';
      targetFileId?: string;
      onProgress?: (progress: number) => void;
    } = {},
  ): Promise<ManagedFile> {
    const DIRECT_THRESHOLD = 8 * 1024 * 1024;
    if (file.size < DIRECT_THRESHOLD || options.duplicateStrategy === 'replace' || options.targetFileId) {
      return fileApi.uploadResumable(projectId, file, options);
    }

    try {
      const presign = await uploadCredentialApi.presign(projectId, {
        fileName: file.name,
        size: file.size,
        mimeType: file.type || undefined,
        folderPath: options.folderPath,
      });
      if (!presign.supported || !presign.storageKey) {
        return fileApi.uploadResumable(projectId, file, options);
      }

      if (presign.method === 'PUT' && presign.uploadUrl) {
        await putWithProgress(presign.uploadUrl, file, presign.headers || {}, options.onProgress);
      } else if (presign.uploadUrl) {
        const form = new FormData();
        for (const [key, value] of Object.entries(presign.formFields || {})) {
          form.append(key, value);
        }
        if (presign.uploadToken && !presign.formFields?.token) {
          form.append('token', presign.uploadToken);
        }
        form.append('file', file, file.name);
        await postFormWithProgress(presign.uploadUrl, form, options.onProgress);
      } else {
        return fileApi.uploadResumable(projectId, file, options);
      }

      options.onProgress?.(100);
      const checksum = await sha256Hex(file);
      return uploadCredentialApi.completePresign(projectId, {
        storageKey: presign.storageKey,
        fileName: file.name,
        size: file.size,
        mimeType: file.type || undefined,
        folderPath: options.folderPath ?? presign.folderPath,
        publicUrl: presign.publicUrl,
        credentialId: presign.credentialId,
        checksum,
        duplicateStrategy: options.duplicateStrategy,
      });
    } catch {
      return fileApi.uploadResumable(projectId, file, options);
    }
  },
};

/** SHA-256 hex digest of a File/Blob via SubtleCrypto (browser). */
async function sha256Hex(file: Blob): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function putWithProgress(
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress?: (progress: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`直传失败 HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('直传网络错误'));
    xhr.send(file);
  });
}

function postFormWithProgress(
  url: string,
  form: FormData,
  onProgress?: (progress: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`直传失败 HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('直传网络错误'));
    xhr.send(form);
  });
}

export const publicShareApi = {
  get(token: string) {
    return http.get<unknown, PublicShareInfo>(`/shares/${token}`);
  },
  /** Resolve by multi-segment customPath (e.g. docs/readme) or token. */
  resolve(path: string) {
    return http.get<unknown, PublicShareInfo>('/shares/resolve', { params: { path } });
  },
  download(token: string, password?: string) {
    return http.post<unknown, Blob>(`/shares/${token}/download`, compactParams({ password }), {
      responseType: 'blob',
      timeout: 0,
    });
  },
  createDownloadSession(token: string, password?: string) {
    return http.post<unknown, { url: string; expiresAt: string }>(
      `/shares/${token}/download-session`,
      compactParams({ password }),
      // Share page shows its own ElMessageBox for 429/ban; avoid double toast.
      { _silent: true },
    );
  },
  preview(token: string, password?: string) {
    return http.post<unknown, Blob>(`/shares/${token}/preview`, compactParams({ password }), {
      responseType: 'blob',
      timeout: 0,
    });
  },
};

/**
 * Drop undefined/null params. Empty strings are kept only for known sentinels
 * (folderPath='' means root-only). Other empty strings (e.g. action='', projectId='')
 * are stripped so class-validator @IsEnum / optional fields don't reject them.
 */
function compactParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(([key, value]) => {
      if (value === undefined || value === null) {
        return false;
      }
      if (value === '' && key !== 'folderPath') {
        return false;
      }
      return true;
    }),
  );
}

async function uploadChunkWithRetry(
  projectId: string,
  uploadId: string,
  index: number,
  chunk: Blob,
  attempts = 3,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fileApi.uploadChunk(projectId, uploadId, index, chunk);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

function compactUndefinedParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== '' && value !== undefined));
}

export type ShareIpStatRow = {
  id: string;
  ip: string;
  downloadCount: number;
  rateLimitCount: number;
  lastDownloadAt?: string | null;
  lastRateLimitedAt?: string | null;
  permanentBan: boolean;
  banUntil?: string | null;
  banReason?: string | null;
  notes?: string | null;
  lastShareId?: string | null;
  lastFileName?: string | null;
  createdAt: string;
  updatedAt: string;
  banned: boolean;
  banStatus: 'permanent' | 'temporary' | 'none';
  banRemainingMinutes?: number | null;
};

export const shareIpAbuseApi = {
  list(params?: { page?: number; pageSize?: number; keyword?: string; bannedOnly?: boolean }) {
    return http.get<unknown, { items: ShareIpStatRow[]; total: number; page: number; pageSize: number }>(
      '/admin/share-ip-stats',
      {
        params: compactParams({
          page: params?.page,
          pageSize: params?.pageSize,
          keyword: params?.keyword,
          bannedOnly: params?.bannedOnly ? '1' : undefined,
        }),
      },
    );
  },
  ban(payload: { ip: string; permanent?: boolean; minutes?: number; reason?: string; notes?: string }) {
    return http.post<unknown, ShareIpStatRow>('/admin/share-ip-stats/ban', payload);
  },
  unban(ip: string) {
    return http.post<unknown, ShareIpStatRow | { success: boolean; ip: string }>('/admin/share-ip-stats/unban', {
      ip,
    });
  },
};

export const settingsApi = {
  list() {
    return http.get<unknown, Record<string, unknown>>('/settings');
  },
  update(payload: { key: string; value: unknown }) {
    return http.post<unknown, { key: string; value: unknown; updatedAt: string }>('/settings', payload);
  },
  getNotify() {
    return http.get<
      unknown,
      { enabled: boolean; baseUrl: string; apiKeyConfigured: boolean; events: string[] }
    >('/settings/notify');
  },
  updateNotify(payload: {
    enabled?: boolean;
    baseUrl?: string;
    apiKey?: string;
    clearApiKey?: boolean;
    events?: string[];
  }) {
    return http.post<
      unknown,
      { enabled: boolean; baseUrl: string; apiKeyConfigured: boolean; events: string[] }
    >('/settings/notify', payload);
  },
  testNotify() {
    return http.post<unknown, { success: boolean; skipped?: boolean; reason?: string; messageId?: string }>(
      '/settings/notify/test',
    );
  },
  auditLogs(params: {
    page?: number;
    pageSize?: number;
    projectId?: string;
    action?: AuditAction | '';
    keyword?: string;
    startAt?: string;
    endAt?: string;
  }) {
    return http.get<unknown, PageResult<AuditLog>>('/audit-logs', { params: compactParams(params) });
  },
  cleanupAuditLogs(payload: {
    beforeAt: string;
    projectId?: string;
    action?: AuditAction | '';
    keyword?: string;
  }) {
    return http.post<unknown, { success: boolean; deleted: number }>('/audit-logs/cleanup', compactParams(payload));
  },
  exportAuditLogs(params: {
    format?: 'csv' | 'json';
    projectId?: string;
    action?: AuditAction | '';
    keyword?: string;
    startAt?: string;
    endAt?: string;
  }) {
    return http.get<unknown, Blob>('/audit-logs/export', {
      params: compactParams(params),
      responseType: 'blob',
      timeout: 0,
    });
  },
  health() {
    return http.get<unknown, SystemHealth>('/system/health');
  },
};

export const notificationApi = {
  list(params?: { unreadOnly?: boolean; page?: number; pageSize?: number }) {
    return http.get<
      unknown,
      {
        items: Array<{
          id: string;
          title: string;
          body?: string | null;
          level: string;
          href?: string | null;
          readAt?: string | null;
          createdAt: string;
        }>;
        total: number;
        page: number;
        pageSize: number;
      }
    >('/notifications', {
      params: compactParams({
        unreadOnly: params?.unreadOnly ? '1' : undefined,
        page: params?.page,
        pageSize: params?.pageSize,
      }),
    });
  },
  unreadCount() {
    return http.get<unknown, { count: number }>('/notifications/unread-count');
  },
  markRead(payload: { ids?: string[]; all?: boolean }) {
    return http.post<unknown, { success: boolean }>('/notifications/read', payload);
  },
};

export const sessionApi = {
  list() {
    return http.get<
      unknown,
      Array<{
        id: string;
        ip?: string | null;
        userAgent?: string | null;
        createdAt: string;
        expiresAt: string;
        current: boolean;
      }>
    >('/auth/sessions');
  },
  revoke(sessionId: string) {
    return http.delete<unknown, { success: boolean }>(`/auth/sessions/${sessionId}`);
  },
  revokeOthers() {
    return http.delete<unknown, { success: boolean; revoked: number }>('/auth/sessions');
  },
};

export const taskApi = {
  list(params: { projectId?: string; status?: string; type?: string; page?: number; pageSize?: number }) {
    return http.get<unknown, PageResult<TaskItem>>('/tasks', { params: compactParams(params) });
  },
  get(taskId: string) {
    return http.get<unknown, TaskItem>(`/tasks/${taskId}`);
  },
  cancel(taskId: string) {
    return http.post<unknown, TaskItem>(`/tasks/${taskId}/cancel`);
  },
  retry(taskId: string) {
    return http.post<unknown, TaskItem>(`/tasks/${taskId}/retry`);
  },
  remove(taskId: string) {
    return http.delete<unknown, { success: boolean }>(`/tasks/${taskId}`);
  },
};

