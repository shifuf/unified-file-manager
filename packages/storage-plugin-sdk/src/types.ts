import type { Readable } from 'node:stream';

export type RuntimeCdnConfig = { id: string; provider: string; name: string; config: Record<string, unknown> };
export type StorageUploadParams = { key: string; buffer: Buffer; mimeType: string; originalName: string };
/** Immutable object verified by host: upload bytes from path without buffering the whole file. */
export type StorageUploadFileParams = { key: string; path: string; size: number; checksum: string; mimeType: string; originalName: string };
export type StorageObjectFingerprint = { size: number; checksum: string; identity: string };
export type StoredObject = { storageKey: string; publicUrl?: string | null };
export type DownloadStorageIdentity = { configId: string; configName: string; provider: string };
export type DownloadStorageSource = { strategy: 'CLOUD_PRIORITY'; selected: DownloadStorageIdentity; attempts: Array<DownloadStorageIdentity & { outcome: 'SELECTED' | 'FAILED' | 'SKIPPED'; reason?: string }>; omittedAttempts?: number };
export type StorageDownloadTarget = { type: 'stream' | 'redirect'; url?: string; stream?: Readable; contentType?: string; contentLength?: number; verified?: boolean; checksum?: string; storageSource?: DownloadStorageSource };
export type StorageByteRange = { start?: number; end?: number };
export type StorageUsageSnapshot = { storageUsedBytes?: number | null; storageQuotaBytes?: number | null; trafficUsedBytes?: number | null; trafficQuotaBytes?: number | null; checkedAt?: string; message?: string };
export type DirectUploadParams = { key: string; fileName: string; mimeType: string; size: number };
export type DirectUploadCredential = { provider: string; storageKey: string; uploadUrl: string; method: 'POST' | 'PUT'; headers?: Record<string, string>; uploadToken?: string; formFields?: Record<string, string>; publicUrl?: string | null; expiresAt: string };
export interface StorageAdapter {
  readonly provider: string;
  upload(config: RuntimeCdnConfig, params: StorageUploadParams): Promise<StoredObject>;
  uploadFile(config: RuntimeCdnConfig, params: StorageUploadFileParams): Promise<StoredObject>;
  remove(config: RuntimeCdnConfig, key: string): Promise<void>;
  getDownloadUrl(config: RuntimeCdnConfig, key: string, expiresSeconds: number): Promise<string>;
  objectExists(config: RuntimeCdnConfig, key: string): Promise<boolean>;
  getObjectFingerprint?(config: RuntimeCdnConfig, key: string): Promise<StorageObjectFingerprint | null>;
  repairFile?(config: RuntimeCdnConfig, params: StorageUploadFileParams, corrupt: StorageObjectFingerprint): Promise<StoredObject>;
  getDownloadTarget?(config: RuntimeCdnConfig, key: string, range?: StorageByteRange): Promise<StorageDownloadTarget>;
  createDirectUpload?(config: RuntimeCdnConfig, params: DirectUploadParams, expiresSeconds: number): Promise<DirectUploadCredential | null>;
  getUsage?(config: RuntimeCdnConfig): Promise<StorageUsageSnapshot>;
}
export interface StoragePluginModule { createAdapter(): StorageAdapter }
