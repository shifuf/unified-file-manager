import { createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { configText, encodeKeyPath, joinUrl, publicUrlFromDomain, withScheme, StoragePluginError, type RuntimeCdnConfig, type StorageAdapter, type StorageUploadParams, type StorageUploadFileParams, type StorageByteRange, type StorageDownloadTarget } from '@ufm/storage-plugin-sdk';

export class UpyunAdapter implements StorageAdapter {
  readonly provider = 'UPYUN';
  private url(config: RuntimeCdnConfig, key: string) { return `${withScheme(configText(config, 'endpoint', 'https://v0.api.upyun.com'))}/${encodeURIComponent(configText(config, 'bucket'))}/${encodeKeyPath(key)}`; }
  private headers(config: RuntimeCdnConfig) { return { Authorization: `Basic ${Buffer.from(`${configText(config, 'operator')}:${configText(config, 'password')}`).toString('base64')}`, Date: new Date().toUTCString() }; }
  private request(config: RuntimeCdnConfig, key: string, method: string, headers = {}) { return fetch(this.url(config, key), { method, headers: { ...this.headers(config), ...headers }, signal: AbortSignal.timeout(30_000) }); }
  async upload(config: RuntimeCdnConfig, params: StorageUploadParams) {
    const response = await fetch(this.url(config, params.key), { method: 'PUT', headers: { ...this.headers(config), 'Content-Type': params.mimeType }, body: new Uint8Array(params.buffer), signal: AbortSignal.timeout(30_000) });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`又拍云上传失败：${response.status}`);
    return { storageKey: params.key, publicUrl: publicUrlFromDomain(config, params.key) };
  }
  async uploadFile(config: RuntimeCdnConfig, params: StorageUploadFileParams) {
    const body = createReadStream(params.path);
    try {
      const init = { method: 'PUT', headers: { ...this.headers(config), 'Content-Type': params.mimeType, 'Content-Length': String(params.size) }, body: body as unknown as BodyInit, duplex: 'half', signal: AbortSignal.timeout(600_000) };
      const response = await fetch(this.url(config, params.key), init);
      await response.body?.cancel();
      if (!response.ok) throw new Error(`又拍云流式上传失败：${response.status}`);
      return { storageKey: params.key, publicUrl: publicUrlFromDomain(config, params.key) };
    } finally { body.destroy(); }
  }
  async remove(config: RuntimeCdnConfig, key: string) {
    const response = await this.request(config, key, 'DELETE');
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) throw new Error(`又拍云删除失败：${response.status}`);
  }
  async objectExists(config: RuntimeCdnConfig, key: string) {
    const response = await this.request(config, key, 'HEAD');
    await response.body?.cancel();
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`又拍云对象检查失败：${response.status}`);
    return true;
  }
  async getDownloadUrl(config: RuntimeCdnConfig, key: string, expiresSeconds: number) {
    const url = joinUrl(withScheme(configText(config, 'domain')), encodeKeyPath(key));
    const secret = configText(config, 'tokenSecret') || configText(config, 'secret');
    if (!secret) return url;
    const expires = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(expiresSeconds));
    const signature = createHmac('sha1', secret).update(`GET&/${configText(config, 'bucket')}/${key}&${expires}`).digest('base64url');
    return `${url}?_upt=${expires}_${signature}`;
  }
  async getDownloadTarget(config: RuntimeCdnConfig, key: string, range?: StorageByteRange): Promise<StorageDownloadTarget> {
    const response = await this.request(config, key, 'GET', range ? { Range: `bytes=${range.start ?? 0}-${range.end ?? ''}` } : {});
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new StoragePluginError(`又拍云源站读取失败：${response.status}`, response.status); }
    const length = response.headers.get('content-length');
    return { type: 'stream', stream: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), contentType: response.headers.get('content-type') ?? undefined, contentLength: length === null ? undefined : Number(length) };
  }
  async getUsage() { return { checkedAt: new Date().toISOString(), message: '又拍云未提供稳定的用量查询接口，请在又拍云控制台查看空间与流量。' }; }
}
export function createAdapter() { return new UpyunAdapter(); }
