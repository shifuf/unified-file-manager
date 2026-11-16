import OSS from 'ali-oss';
import { createReadStream } from 'node:fs';
import { configText, hostnameOnly, publicUrlFromDomain, withScheme, type RuntimeCdnConfig, type StorageAdapter, type StorageUploadParams, type StorageUploadFileParams, type DirectUploadParams, type DirectUploadCredential } from '@ufm/storage-plugin-sdk';

export class AliyunOssAdapter implements StorageAdapter {
  readonly provider = 'ALIYUN';
  private client(config: RuntimeCdnConfig) { return new OSS({ accessKeyId: configText(config, 'accessKey'), accessKeySecret: configText(config, 'secretKey'), bucket: configText(config, 'bucket'), region: configText(config, 'region', 'oss-cn-hangzhou'), endpoint: withScheme(configText(config, 'endpoint')) || undefined, secure: true, timeout: 30_000 }); }
  async upload(config: RuntimeCdnConfig, params: StorageUploadParams) {
    await this.client(config).put(params.key, params.buffer, { mime: params.mimeType, headers: { 'Content-Type': params.mimeType } });
    return { storageKey: params.key, publicUrl: publicUrlFromDomain(config, params.key) };
  }
  async uploadFile(config: RuntimeCdnConfig, params: StorageUploadFileParams) {
    const body = createReadStream(params.path);
    try { await this.client(config).putStream(params.key, body, { mime: params.mimeType, timeout: 600_000, contentLength: params.size, headers: { 'Content-Type': params.mimeType } }); }
    finally { body.destroy(); }
    return { storageKey: params.key, publicUrl: publicUrlFromDomain(config, params.key) };
  }
  async remove(config: RuntimeCdnConfig, key: string) {
    try { await this.client(config).delete(key); } catch (error) { if (!missing(error)) throw error; }
  }
  async objectExists(config: RuntimeCdnConfig, key: string) { try { await this.client(config).head(key); return true; } catch (error) { if (missing(error)) return false; throw error; } }
  async getDownloadUrl(config: RuntimeCdnConfig, key: string, expiresSeconds: number) { return this.client(config).signatureUrl(key, { expires: Math.max(1, Math.floor(expiresSeconds)), method: 'GET' }); }
  async createDirectUpload(config: RuntimeCdnConfig, params: DirectUploadParams, expiresSeconds: number): Promise<DirectUploadCredential> {
    const expiresAt = new Date(Date.now() + Math.max(60, expiresSeconds) * 1000);
    const signature = this.client(config).calculatePostSignature({ expiration: expiresAt.toISOString(), conditions: [['content-length-range', 0, Math.max(1, Math.floor(params.size))], ['eq', '$key', params.key]] });
    return { provider: this.provider, storageKey: params.key, uploadUrl: `https://${configText(config, 'bucket')}.${hostnameOnly(configText(config, 'endpoint'))}`, method: 'POST', formFields: { key: params.key, policy: signature.policy, OSSAccessKeyId: configText(config, 'accessKey'), signature: signature.signature, success_action_status: '200', 'Content-Type': params.mimeType }, publicUrl: publicUrlFromDomain(config, params.key), expiresAt: expiresAt.toISOString() };
  }
}
function missing(error: unknown) { const e = error as { status?: number; code?: string }; return e?.status === 404 || e?.code === 'NoSuchKey'; }
export function createAdapter() { return new AliyunOssAdapter(); }
