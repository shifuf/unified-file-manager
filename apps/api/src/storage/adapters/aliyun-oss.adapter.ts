import { Injectable } from '@nestjs/common';
import { CdnProvider } from '@prisma/client';
import OSS from 'ali-oss';

import type {
  DirectUploadCredential,
  RuntimeCdnConfig,
  StorageAdapter,
  StorageUploadParams,
  StoredObject,
} from '../storage.types';
import { configText, hostnameOnly, publicUrlFromDomain, withScheme } from '../storage.util';

/** Aliyun OSS adapter. Config keys: `accessKey`, `secretKey`, `bucket`, `endpoint`, `domain?`. */
@Injectable()
export class AliyunOssAdapter implements StorageAdapter {
  readonly provider = CdnProvider.ALIYUN;

  async upload(config: RuntimeCdnConfig, params: StorageUploadParams): Promise<StoredObject> {
    await this.client(config).put(params.key, params.buffer, {
      mime: params.mimeType,
      headers: { 'Content-Type': params.mimeType },
    });

    return { storageKey: params.key, publicUrl: publicUrlFromDomain(config, params.key) };
  }

  async remove(config: RuntimeCdnConfig, key: string): Promise<void> {
    await this.client(config).delete(key);
  }

  async getDownloadUrl(config: RuntimeCdnConfig, key: string, expiresSeconds: number): Promise<string> {
    return this.client(config).signatureUrl(key, {
      expires: Math.max(1, Math.floor(expiresSeconds)),
      method: 'GET',
    });
  }

  async objectExists(config: RuntimeCdnConfig, key: string): Promise<boolean> {
    try {
      await this.client(config).head(key);
      return true;
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }
      throw error;
    }
  }

  async createDirectUpload(
    config: RuntimeCdnConfig,
    params: { key: string; fileName: string; mimeType: string; size: number },
    expiresSeconds: number,
  ): Promise<DirectUploadCredential | null> {
    const client = this.client(config);
    const accessKeyId = configText(config, 'accessKey');
    const bucket = configText(config, 'bucket');
    const endpoint = hostnameOnly(configText(config, 'endpoint'));

    if (!accessKeyId || !bucket || !endpoint) {
      return null;
    }

    const expiresAt = new Date(Date.now() + Math.max(60, expiresSeconds) * 1000);
    const signature = client.calculatePostSignature({
      expiration: expiresAt.toISOString(),
      conditions: [
        ['content-length-range', 0, Math.max(1, Math.floor(params.size))],
        ['eq', '$key', params.key],
      ],
    });

    return {
      provider: CdnProvider.ALIYUN,
      storageKey: params.key,
      uploadUrl: `https://${bucket}.${endpoint}`,
      method: 'POST',
      formFields: {
        key: params.key,
        policy: signature.policy,
        OSSAccessKeyId: accessKeyId,
        signature: signature.signature,
        success_action_status: '200',
        'Content-Type': params.mimeType,
      },
      publicUrl: publicUrlFromDomain(config, params.key),
      expiresAt: expiresAt.toISOString(),
    };
  }

  private client(config: RuntimeCdnConfig) {
    return new OSS({
      accessKeyId: configText(config, 'accessKey'),
      accessKeySecret: configText(config, 'secretKey'),
      bucket: configText(config, 'bucket'),
      region: configText(config, 'region', 'oss-cn-hangzhou'),
      endpoint: withScheme(configText(config, 'endpoint')) || undefined,
      secure: true,
      timeout: 30_000,
    });
  }
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as { status?: number; code?: string; name?: string };
  return candidate.status === 404 || candidate.code === 'NoSuchKey' || candidate.name === 'NoSuchKey';
}
