import type { Readable } from 'node:stream';
import type { StorageRemotePage, StorageRemoteRead } from '@ufm/storage-plugin-sdk';

type CdnProvider = string;

export type RuntimeCdnConfig = {
  id: string;
  provider: CdnProvider;
  name: string;
  config: Record<string, unknown>;
};

export type StorageProjectIdentity = {
  id: string;
  name: string;
};

export type StorageUploadParams = {
  key: string;
  buffer: Buffer;
  mimeType: string;
  originalName: string;
  project?: StorageProjectIdentity;
  folderPath?: string;
};

/** A verified disk object for bounded-memory background replication. */
export type StorageUploadFileParams = {
  key: string;
  path: string;
  size: number;
  checksum: string;
  mimeType: string;
  originalName: string;
  project?: StorageProjectIdentity;
  folderPath?: string;
};

export type StorageObjectFingerprint = {
  size: number;
  checksum: string;
  /** Filesystem identity and modification stamp captured from one open file. */
  identity: string;
};

export type StoredObject = {
  storageKey: string;
  publicUrl?: string | null;
};

export type StorageDownloadTarget = {
  type: 'stream' | 'redirect';
  url?: string;
  stream?: Readable;
  contentType?: string;
  contentLength?: number;
  verified?: boolean;
  checksum?: string;
  storageSource?: DownloadStorageSource;
};

export type DownloadStorageIdentity = { configId: string; configName: string; provider: CdnProvider };
export type DownloadStorageSource = {
  strategy: 'CLOUD_PRIORITY';
  selected: DownloadStorageIdentity;
  attempts: Array<DownloadStorageIdentity & { outcome: 'SELECTED' | 'FAILED' | 'SKIPPED'; reason?: string }>;
  omittedAttempts?: number;
};

export type StorageByteRange = {
  start?: number;
  end?: number;
};

export type StorageUsageSnapshot = {
  storageUsedBytes?: number | null;
  storageQuotaBytes?: number | null;
  trafficUsedBytes?: number | null;
  trafficQuotaBytes?: number | null;
  checkedAt?: string;
  message?: string;
};

export type DirectUploadParams = {
  key: string;
  fileName: string;
  mimeType: string;
  size: number;
};

export type DirectUploadCredential = {
  provider: CdnProvider;
  storageKey: string;
  uploadUrl: string;
  method: 'POST' | 'PUT';
  headers?: Record<string, string>;
  uploadToken?: string;
  formFields?: Record<string, string>;
  publicUrl?: string | null;
  expiresAt: string;
};

export interface StorageAdapter {
  readonly provider: CdnProvider;

  listRemoteFiles?(config: RuntimeCdnConfig, options: { parentId?: string; cursor?: string }): Promise<StorageRemotePage>;

  readRemoteFile?(config: RuntimeCdnConfig, id: string, options?: { maxBytes?: number; timeoutMs?: number }): Promise<StorageRemoteRead>;

  verifyBackup?(config: RuntimeCdnConfig, params: { key: string; size: number; checksum: string }): Promise<void>;

  upload(config: RuntimeCdnConfig, params: StorageUploadParams): Promise<StoredObject>;

  uploadFile?(config: RuntimeCdnConfig, params: StorageUploadFileParams): Promise<StoredObject>;

  getObjectFingerprint?(config: RuntimeCdnConfig, key: string): Promise<StorageObjectFingerprint | null>;

  repairFile?(config: RuntimeCdnConfig, params: StorageUploadFileParams, corrupt: StorageObjectFingerprint): Promise<StoredObject>;

  remove(config: RuntimeCdnConfig, key: string): Promise<void>;

  getDownloadUrl(config: RuntimeCdnConfig, key: string, expiresSeconds: number): Promise<string>;

  getDownloadTarget?(
    config: RuntimeCdnConfig,
    key: string,
    range?: StorageByteRange,
  ): Promise<StorageDownloadTarget>;

  objectExists?(config: RuntimeCdnConfig, key: string): Promise<boolean>;

  createDirectUpload?(
    config: RuntimeCdnConfig,
    params: DirectUploadParams,
    expiresSeconds: number,
  ): Promise<DirectUploadCredential | null>;

  getUsage?(config: RuntimeCdnConfig): Promise<StorageUsageSnapshot>;
}
