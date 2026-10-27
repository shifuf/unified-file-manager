import type { Readable } from 'node:stream';

import type { CdnProvider } from '@prisma/client';

export type RuntimeCdnConfig = {
  id: string;
  provider: CdnProvider;
  name: string;
  config: Record<string, unknown>;
};

export type StorageUploadParams = {
  key: string;
  buffer: Buffer;
  mimeType: string;
  originalName: string;
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

  upload(config: RuntimeCdnConfig, params: StorageUploadParams): Promise<StoredObject>;

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
