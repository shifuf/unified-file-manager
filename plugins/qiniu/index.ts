import { createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import * as qiniu from 'qiniu';
import { configText, encodeKeyPath, publicUrlFromDomain, withScheme, type RuntimeCdnConfig, type StorageAdapter, type StorageUploadParams, type StorageUploadFileParams, type DirectUploadParams, type DirectUploadCredential } from '@ufm/storage-plugin-sdk';

export class QiniuAdapter implements StorageAdapter {
  readonly provider = 'QINIU';
  private mac(config: RuntimeCdnConfig) { return new qiniu.auth.digest.Mac(configText(config, 'accessKey'), configText(config, 'secretKey')); }
  private manager(config: RuntimeCdnConfig) { return new qiniu.rs.BucketManager(this.mac(config)); }
  private async put(config: RuntimeCdnConfig, key: string, body: Readable) {
    const token = new qiniu.rs.PutPolicy({ scope: `${configText(config, 'bucket')}:${key}` }).uploadToken(this.mac(config));
    await new Promise<void>((resolve, reject) => {
      void new qiniu.form_up.FormUploader().putStream(token, key, body, new qiniu.form_up.PutExtra(), (error?: Error, _response?: unknown, info?: { statusCode?: number }) => {
        if (error) reject(new Error(`七牛上传失败：${status(error) || 'network'}`));
        else if (info?.statusCode && (info.statusCode < 200 || info.statusCode >= 300)) reject(new Error(`七牛上传失败：${info.statusCode}`));
        else resolve();
      });
    });
  }
  async upload(config: RuntimeCdnConfig, params: StorageUploadParams) {
    await this.put(config, params.key, Readable.from(params.buffer));
    return { storageKey: params.key, publicUrl: publicUrlFromDomain(config, params.key) };
  }
  async uploadFile(config: RuntimeCdnConfig, params: StorageUploadFileParams) {
    const body = createReadStream(params.path);
    try { await this.put(config, params.key, body); } finally { body.destroy(); }
    return { storageKey: params.key, publicUrl: publicUrlFromDomain(config, params.key) };
  }
  async remove(config: RuntimeCdnConfig, key: string) {
    await new Promise<void>((resolve, reject) => { void this.manager(config).delete(configText(config, 'bucket'), key, (error?: Error, _body?: unknown, info?: { statusCode?: number }) => {
      const code = info?.statusCode || status(error);
      if (code === 612 || (!error && code >= 200 && code < 300)) resolve();
      else reject(new Error(`七牛删除失败：${code || 'network'}`));
    }); });
  }
  async objectExists(config: RuntimeCdnConfig, key: string) {
    return new Promise<boolean>((resolve, reject) => { void this.manager(config).stat(configText(config, 'bucket'), key, (error?: Error, _body?: unknown, info?: { statusCode?: number }) => {
      const code = info?.statusCode || status(error);
      if (code === 612) resolve(false);
      else if (!error && code >= 200 && code < 300) resolve(true);
      else reject(new Error(`七牛检查失败：${code || 'network'}`));
    }); });
  }
  async getDownloadUrl(config: RuntimeCdnConfig, key: string, expiresSeconds: number) { return this.manager(config).privateDownloadUrl(withScheme(configText(config, 'domain')), encodeKeyPath(key), Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(expiresSeconds))); }
  async createDirectUpload(config: RuntimeCdnConfig, params: DirectUploadParams, expiresSeconds: number): Promise<DirectUploadCredential> {
    const seconds = Math.max(60, Math.floor(expiresSeconds));
    const expiresAt = new Date(Date.now() + seconds * 1000);
    const uploadToken = new qiniu.rs.PutPolicy({ scope: `${configText(config, 'bucket')}:${params.key}`, expires: seconds }).uploadToken(this.mac(config));
    return { provider: this.provider, storageKey: params.key, uploadUrl: 'https://upload.qiniup.com', method: 'POST', uploadToken, formFields: { key: params.key }, publicUrl: publicUrlFromDomain(config, params.key), expiresAt: expiresAt.toISOString() };
  }
  async getUsage(config: RuntimeCdnConfig) {
    const end = new Date(); const begin = new Date(end.getTime() - 86_400_000);
    const day = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
    const path = `/v6/space?bucket=${encodeURIComponent(configText(config, 'bucket'))}&begin=${day(begin)}&end=${day(end)}&g=day`;
    const signature = createHmac('sha1', configText(config, 'secretKey')).update(`${path}\n`).digest('base64').replace(/\+/g, '-').replace(/\//g, '_');
    const response = await fetch(`https://api.qiniu.com${path}`, { headers: { Authorization: `QBox ${configText(config, 'accessKey')}:${signature}` }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`七牛用量接口返回 ${response.status}`); }
    const payload = await response.json() as { datas?: unknown[] };
    const latest = Array.isArray(payload.datas) && payload.datas.length ? Number(payload.datas[payload.datas.length - 1]) : Number.NaN;
    return { storageUsedBytes: Number.isFinite(latest) ? Math.max(0, latest) : null, storageQuotaBytes: null, trafficUsedBytes: null, trafficQuotaBytes: null, checkedAt: end.toISOString(), message: Number.isFinite(latest) ? undefined : '七牛用量接口未返回可解析的存储量。' };
  }
}
function status(error: unknown): number { const e = error as { status?: number; statusCode?: number; resp?: { statusCode?: number } }; return Number(e?.status ?? e?.statusCode ?? e?.resp?.statusCode); }
export function createAdapter() { return new QiniuAdapter(); }
