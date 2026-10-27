import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';

import { Injectable } from '@nestjs/common';
import { CdnProvider } from '@prisma/client';
import * as qiniu from 'qiniu';

import type {
  DirectUploadCredential,
  RuntimeCdnConfig,
  StorageAdapter,
  StorageUsageSnapshot,
  StorageUploadParams,
  StoredObject,
} from '../storage.types';
import { configText, publicUrlFromDomain, withScheme } from '../storage.util';

const QINIU_API_HOST = 'https://api.qiniu.com';
const QINIU_UPLOAD_HOST = 'https://upload.qiniup.com';

/** Qiniu Kodo adapter. Config keys: `accessKey`, `secretKey`, `bucket`, `domain`. */
@Injectable()
export class QiniuAdapter implements StorageAdapter {
  readonly provider = CdnProvider.QINIU;

  async upload(config: RuntimeCdnConfig, params: StorageUploadParams): Promise<StoredObject> {
    const mac = this.mac(config);
    const bucket = configText(config, 'bucket');
    const uploadToken = new qiniu.rs.PutPolicy({ scope: `${bucket}:${params.key}` }).uploadToken(mac);
    const uploader = new qiniu.form_up.FormUploader();

    await new Promise<void>((resolve, reject) => {
      void uploader.putStream(
        uploadToken,
        params.key,
        Readable.from(params.buffer),
        new qiniu.form_up.PutExtra(),
        (error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        },
      );
    });

    return { storageKey: params.key, publicUrl: publicUrlFromDomain(config, params.key) };
  }

  async remove(config: RuntimeCdnConfig, key: string): Promise<void> {
    const manager = new qiniu.rs.BucketManager(this.mac(config));
    const bucket = configText(config, 'bucket');

    await new Promise<void>((resolve, reject) => {
      void manager.delete(bucket, key, (error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async getDownloadUrl(config: RuntimeCdnConfig, key: string, expiresSeconds: number): Promise<string> {
    const mac = this.mac(config);
    const domain = withScheme(configText(config, 'domain'));
    const objectUrl = `${domain}/${Buffer.from(key, 'utf8').toString('base64url')}`;
    const deadline = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(expiresSeconds));
    const signed = `${objectUrl}?e=${deadline}`;
    const token = qiniu.util.generateAccessToken(mac, signed);

    return `${signed}&token=${token}`;
  }

  async objectExists(config: RuntimeCdnConfig, key: string): Promise<boolean> {
    const manager = new qiniu.rs.BucketManager(this.mac(config));
    const bucket = configText(config, 'bucket');

    return new Promise<boolean>((resolve, reject) => {
      void manager.stat(bucket, key, (error?: Error) => {
        if (!error) {
          resolve(true);
          return;
        }
        if (qiniuStatus(error) === 612) {
          resolve(false);
          return;
        }
        reject(error);
      });
    });
  }

  async createDirectUpload(
    config: RuntimeCdnConfig,
    params: { key: string; fileName: string; mimeType: string; size: number },
    expiresSeconds: number,
  ): Promise<DirectUploadCredential | null> {
    const bucket = configText(config, 'bucket');
    if (!bucket || !configText(config, 'accessKey') || !configText(config, 'secretKey')) {
      return null;
    }

    const expiresAt = new Date(Date.now() + Math.max(60, expiresSeconds) * 1000);
    const uploadToken = new qiniu.rs.PutPolicy({
      scope: `${bucket}:${params.key}`,
      expires: Math.floor(expiresAt.getTime() / 1000),
    }).uploadToken(this.mac(config));

    return {
      provider: CdnProvider.QINIU,
      storageKey: params.key,
      uploadUrl: QINIU_UPLOAD_HOST,
      method: 'POST',
      uploadToken,
      formFields: { key: params.key },
      publicUrl: publicUrlFromDomain(config, params.key),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async getUsage(config: RuntimeCdnConfig): Promise<StorageUsageSnapshot> {
    const bucket = configText(config, 'bucket');
    const accessKey = configText(config, 'accessKey');
    const secretKey = configText(config, 'secretKey');

    if (!bucket || !accessKey || !secretKey) {
      return { message: '缺少 accessKey / secretKey / bucket，无法查询用量。' };
    }

    const end = new Date();
    const begin = new Date(end.getTime() - 24 * 60 * 60 * 1000);
    const query =
      `bucket=${encodeURIComponent(bucket)}` +
      `&begin=${formatQiniuDay(begin)}` +
      `&end=${formatQiniuDay(end)}` +
      `&g=day`;
    const path = '/v6/space';
    const signature = createHmac('sha1', secretKey).update(`${path}?${query}\n`).digest('base64');

    const response = await fetch(`${QINIU_API_HOST}${path}?${query}`, {
      headers: { Authorization: `QBox ${accessKey}:${signature}` },
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      throw new Error(`七牛用量接口返回 ${response.status}`);
    }

    const payload = (await response.json()) as { datas?: unknown };
    const series = Array.isArray(payload.datas) ? payload.datas : [];
    const latest = series.length > 0 ? Number(series[series.length - 1]) : Number.NaN;

    return {
      storageUsedBytes: Number.isFinite(latest) ? Math.max(0, latest) : null,
      storageQuotaBytes: null,
      trafficUsedBytes: null,
      trafficQuotaBytes: null,
      checkedAt: new Date().toISOString(),
      message: Number.isFinite(latest) ? undefined : '七牛用量接口未返回可解析的存储量。',
    };
  }

  private mac(config: RuntimeCdnConfig): qiniu.auth.digest.Mac {
    return new qiniu.auth.digest.Mac(configText(config, 'accessKey'), configText(config, 'secretKey'));
  }
}

function formatQiniuDay(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function qiniuStatus(error: unknown): number {
  if (!error || typeof error !== 'object') {
    return Number.NaN;
  }
  const candidate = error as { status?: unknown; statusCode?: unknown };
  const parsed = Number(candidate.status ?? candidate.statusCode);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
