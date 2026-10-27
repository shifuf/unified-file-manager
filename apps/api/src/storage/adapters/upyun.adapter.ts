import { createHmac } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { CdnProvider } from '@prisma/client';

import type {
  RuntimeCdnConfig,
  StorageAdapter,
  StorageUsageSnapshot,
  StorageUploadParams,
  StoredObject,
} from '../storage.types';
import {
  configText,
  encodeKeyPath,
  joinUrl,
  publicUrlFromDomain,
  rfc1123Date,
  withScheme,
} from '../storage.util';

const DEFAULT_UPYUN_ENDPOINT = 'https://v0.api.upyun.com';

/** Upyun adapter (REST API, HTTP Basic auth). Config keys: `operator`, `password`, `bucket`, `domain`, `endpoint?`. */
@Injectable()
export class UpyunAdapter implements StorageAdapter {
  readonly provider = CdnProvider.UPYUN;

  async upload(config: RuntimeCdnConfig, params: StorageUploadParams): Promise<StoredObject> {
    const response = await this.request(config, 'PUT', params.key, params.buffer, {
      'Content-Type': params.mimeType,
    });

    if (!response.ok) {
      throw new Error(`又拍云上传失败：${response.status} ${await safeText(response)}`);
    }

    return { storageKey: params.key, publicUrl: publicUrlFromDomain(config, params.key) };
  }

  async remove(config: RuntimeCdnConfig, key: string): Promise<void> {
    const response = await this.request(config, 'DELETE', key);
    if (!response.ok && response.status !== 404) {
      throw new Error(`又拍云删除失败：${response.status} ${await safeText(response)}`);
    }
  }

  async getDownloadUrl(config: RuntimeCdnConfig, key: string, expiresSeconds: number): Promise<string> {
    const objectUrl = joinUrl(withScheme(configText(config, 'domain')), encodeKeyPath(key));
    const tokenSecret = configText(config, 'tokenSecret') || configText(config, 'secret');

    if (!tokenSecret) {
      return objectUrl;
    }

    const expires = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(expiresSeconds));
    const content = `GET&/${configText(config, 'bucket')}/${key}&${expires}`;
    const signature = createHmac('sha1', tokenSecret).update(content).digest('base64url');

    return `${objectUrl}?_upt=${expires}_${signature}`;
  }

  async objectExists(config: RuntimeCdnConfig, key: string): Promise<boolean> {
    const response = await this.request(config, 'HEAD', key);
    if (response.status === 404) {
      return false;
    }
    if (!response.ok) {
      throw new Error(`又拍云探测对象失败：${response.status}`);
    }
    return true;
  }

  async getUsage(): Promise<StorageUsageSnapshot> {
    return {
      checkedAt: new Date().toISOString(),
      message: '又拍云未提供稳定的用量查询接口，请在又拍云控制台查看空间与流量。',
    };
  }

  private async request(
    config: RuntimeCdnConfig,
    method: string,
    key: string,
    body?: Buffer,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const endpoint = withScheme(configText(config, 'endpoint', DEFAULT_UPYUN_ENDPOINT));
    const bucket = configText(config, 'bucket');
    const url = `${endpoint.replace(/\/+$/, '')}/${encodeURIComponent(bucket)}/${encodeKeyPath(key)}`;
    const credentials = Buffer.from(
      `${configText(config, 'operator')}:${configText(config, 'password')}`,
      'utf8',
    ).toString('base64');

    return fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${credentials}`,
        Date: rfc1123Date(),
        ...extraHeaders,
      },
      body: body ? new Uint8Array(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  }
}

async function safeText(response: Response): Promise<string> {
  return response.text().catch(() => '');
}
