import type { Readable } from 'node:stream';

export type RuntimeCdnConfig = { id: string; provider: string; name: string; config: Record<string, unknown> };
/** Stable business identity; adapters may use the display name to organize cloud objects. */
export type StorageProjectIdentity = { id: string; name: string };
export type StorageUploadParams = { key: string; buffer: Buffer; mimeType: string; originalName: string; project?: StorageProjectIdentity; folderPath?: string };
/** Immutable object verified by host: upload bytes from path without buffering the whole file. */
export type StorageUploadFileParams = { key: string; path: string; size: number; checksum: string; mimeType: string; originalName: string; project?: StorageProjectIdentity; folderPath?: string };
/** Metadata confirmation of a backup; does not certify a downloaded SHA256. */
export type StorageBackupParams = { key: string; size: number; checksum: string };
export type StorageObjectFingerprint = { size: number; checksum: string; identity: string };
export type StoredObject = { storageKey: string; publicUrl?: string | null };
export type DownloadStorageIdentity = { configId: string; configName: string; provider: string };
export type DownloadStorageSource = { strategy: 'CLOUD_PRIORITY'; selected: DownloadStorageIdentity; attempts: Array<DownloadStorageIdentity & { outcome: 'SELECTED' | 'FAILED' | 'SKIPPED'; reason?: string; route?: 'CDN' | 'ORIGIN' }>; omittedAttempts?: number };
export type StorageDownloadTarget = { type: 'stream' | 'redirect'; url?: string; stream?: Readable; contentType?: string; contentLength?: number; verified?: boolean; checksum?: string; storageSource?: DownloadStorageSource };
export type StorageByteRange = { start?: number; end?: number };
export type StorageUsageSnapshot = { storageUsedBytes?: number | null; storageQuotaBytes?: number | null; trafficUsedBytes?: number | null; trafficQuotaBytes?: number | null; checkedAt?: string; message?: string };
export type DirectUploadParams = { key: string; fileName: string; mimeType: string; size: number };
export type DirectUploadCredential = { provider: string; storageKey: string; uploadUrl: string; method: 'POST' | 'PUT'; headers?: Record<string, string>; uploadToken?: string; formFields?: Record<string, string>; publicUrl?: string | null; expiresAt: string };
/** Explicit administrator retrieval, independent of automatic replica download routing. */
export type StorageRemoteFile = { id: string; parentId: string; name: string; type: 'file' | 'folder'; size: number; mimeType?: string; sha1?: string; updatedAt?: string; originalName?: string; storageKey?: string; checksum?: string; project?: StorageProjectIdentity; folderPath?: string };
export type StorageRemotePage = { parentId: string; items: StorageRemoteFile[]; nextCursor: string };
export type StorageRemoteRead = { stream: Readable; name: string; size: number; mimeType: string; sha1?: string };
export interface StorageAdapter {
  readonly provider: string;
  startLogin?(accountId?: string): Promise<PluginLoginSession>;
  pollLogin?(sessionId: string): Promise<PluginLoginResult>;
  cancelLogin?(sessionId: string): Promise<void>;
  accountStatus?(accountId: string): Promise<PluginAccount>;
  disconnectAccount?(accountId: string): Promise<void>;
  upload(config: RuntimeCdnConfig, params: StorageUploadParams): Promise<StoredObject>;
  uploadFile(config: RuntimeCdnConfig, params: StorageUploadFileParams): Promise<StoredObject>;
  remove(config: RuntimeCdnConfig, key: string): Promise<void>;
  getDownloadUrl(config: RuntimeCdnConfig, key: string, expiresSeconds: number): Promise<string>;
  objectExists(config: RuntimeCdnConfig, key: string): Promise<boolean>;
  /** Metadata-only confirmation; backupOnly adapters do not expose content reads. */
  verifyBackup?(config: RuntimeCdnConfig, params: StorageBackupParams): Promise<void>;
  getObjectFingerprint?(config: RuntimeCdnConfig, key: string): Promise<StorageObjectFingerprint | null>;
  repairFile?(config: RuntimeCdnConfig, params: StorageUploadFileParams, corrupt: StorageObjectFingerprint): Promise<StoredObject>;
  getDownloadTarget?(config: RuntimeCdnConfig, key: string, range?: StorageByteRange): Promise<StorageDownloadTarget>;
  /** Optional CDN stream; host must verify the full object and fall back to origin on failure. */
  getCdnDownloadTarget?(config: RuntimeCdnConfig, key: string): Promise<StorageDownloadTarget | null>;
  createDirectUpload?(config: RuntimeCdnConfig, params: DirectUploadParams, expiresSeconds: number): Promise<DirectUploadCredential | null>;
  getUsage?(config: RuntimeCdnConfig): Promise<StorageUsageSnapshot>;
  listRemoteFiles?(config: RuntimeCdnConfig, options: { parentId?: string; cursor?: string }): Promise<StorageRemotePage>;
  readRemoteFile?(config: RuntimeCdnConfig, id: string, options?: { maxBytes?: number; timeoutMs?: number }): Promise<StorageRemoteRead>;
}
export type PluginAccount = { accountId: string; userId: string; name: string; connected: boolean; drives: Array<{ id: string; name: string }> };
export type PluginLoginSession = { sessionId: string; qrCode: string; expiresAt: string };
export type PluginLoginResult = { status: 'WAITING' | 'SCANNED' | 'CONFIRMED' | 'EXPIRED'; account?: PluginAccount };
export interface PluginContext {
  getState<T = Record<string, unknown>>(key: string): Promise<T | null>;
  setState(key: string, value: unknown): Promise<void>;
  withLock<T>(key: string, action: () => Promise<T>): Promise<T>;
}
export interface StoragePluginModule { createAdapter(context?: PluginContext): StorageAdapter }
