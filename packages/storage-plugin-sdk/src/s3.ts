import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { DirectUploadCredential, RuntimeCdnConfig, StorageAdapter, StorageUploadParams, StorageUploadFileParams, StoredObject } from './types';
import { configFlag, configText, publicUrlFromDomain, withScheme } from './utils';

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const MAX_PRESIGN_SECONDS = 604_800;
export type S3Target = { origin: string; host: string; canonicalUri: string };
export type S3Credentials = { accessKeyId: string; secretAccessKey: string; region: string };
export function awsUriEncode(value: string, encodeSlash = true): string {
  return [...value].map((char) => /^[A-Za-z0-9\-._~]$/.test(char) || (!encodeSlash && char === '/') ? char : [...Buffer.from(char)].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('')).join('');
}
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function hmac(key: string | Buffer, value: string): Buffer { return createHmac('sha256', key).update(value).digest(); }
function signingKey(secret: string, date: string, region: string): Buffer { return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), 's3'), 'aws4_request'); }
function stamp(date: Date): string { return date.toISOString().replace(/[:-]|\.\d{3}/g, ''); }
export function signS3Headers(credentials: S3Credentials, method: string, target: S3Target, payloadHash: string, contentType?: string, now = new Date()): Record<string, string> {
  const amzDate = stamp(now);
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: target.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (contentType) headers['content-type'] = contentType.trim().replace(/\s+/g, ' ');
  const names = Object.keys(headers).sort();
  const canonical = [method.toUpperCase(), target.canonicalUri, '', names.map((name) => `${name}:${headers[name]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${date}/${credentials.region}/s3/aws4_request`;
  const signature = hmac(signingKey(credentials.secretAccessKey, date, credentials.region), ['AWS4-HMAC-SHA256', amzDate, scope, hash(canonical)].join('\n')).toString('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}
export function presignS3(credentials: S3Credentials, method: string, target: S3Target, expiresSeconds: number, now = new Date()): string {
  const amzDate = stamp(now);
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${credentials.region}/s3/aws4_request`;
  const parameters: Record<string, string> = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${credentials.accessKeyId}/${scope}`, 'X-Amz-Date': amzDate, 'X-Amz-Expires': String(normalizeExpiry(expiresSeconds)), 'X-Amz-SignedHeaders': 'host' };
  const query = Object.keys(parameters).sort().map((key) => `${awsUriEncode(key)}=${awsUriEncode(parameters[key])}`).join('&');
  const canonical = [method.toUpperCase(), target.canonicalUri, query, `host:${target.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const signature = hmac(signingKey(credentials.secretAccessKey, date, credentials.region), ['AWS4-HMAC-SHA256', amzDate, scope, hash(canonical)].join('\n')).toString('hex');
  return `${query}&X-Amz-Signature=${signature}`;
}
function normalizeExpiry(value: number): number {
  if (!Number.isFinite(value)) throw new Error('S3 签名有效期无效');
  return Math.min(MAX_PRESIGN_SECONDS, Math.max(1, Math.floor(value)));
}
function transportHeaders(headers: Record<string, string>): Record<string, string> { return Object.fromEntries(Object.entries(headers).filter(([key]) => key !== 'host')); }

/** Standalone SigV4 adapter; an injected transport permits protocol tests without relaxing endpoint validation. */
export class S3Adapter implements StorageAdapter {
  readonly provider: string;
  constructor(provider = 'S3', protected readonly transport: typeof fetch = fetch) { this.provider = provider; }
  protected normalizeConfig(config: RuntimeCdnConfig): RuntimeCdnConfig { return config; }
  protected target(input: RuntimeCdnConfig, key: string): S3Target {
    const config = this.normalizeConfig(input);
    const bucket = configText(config, 'bucket');
    if (!bucket) throw new Error('S3 Bucket 未配置');
    const base = new URL(withScheme(configText(config, 'endpoint')));
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('S3 Endpoint 无效');
    const pathStyle = configFlag(config, 'pathStyle', true);
    const path = `${base.pathname.replace(/\/+$/, '')}/${pathStyle ? `${bucket}/` : ''}${key}`;
    const host = pathStyle ? base.host : `${bucket}.${base.host}`;
    return { origin: `${base.protocol}//${host}`, host, canonicalUri: awsUriEncode(path, false) };
  }
  protected credentials(input: RuntimeCdnConfig): S3Credentials {
    const config = this.normalizeConfig(input);
    const accessKeyId = configText(config, 'accessKeyId');
    const secretAccessKey = configText(config, 'secretAccessKey');
    if (!accessKeyId || !secretAccessKey) throw new Error('S3 访问密钥未配置');
    return { accessKeyId, secretAccessKey, region: configText(config, 'region', 'us-east-1') };
  }
  async upload(config: RuntimeCdnConfig, params: StorageUploadParams): Promise<StoredObject> {
    const target = this.target(config, params.key);
    const response = await this.transport(`${target.origin}${target.canonicalUri}`, { method: 'PUT', headers: transportHeaders(signS3Headers(this.credentials(config), 'PUT', target, hash(params.buffer), params.mimeType)), body: new Uint8Array(params.buffer), signal: AbortSignal.timeout(30_000) });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`${this.provider} 上传失败：${response.status}`);
    return { storageKey: params.key, publicUrl: publicUrlFromDomain(config, params.key) };
  }
  async uploadFile(config: RuntimeCdnConfig, params: StorageUploadFileParams): Promise<StoredObject> {
    const target = this.target(config, params.key);
    const body = createReadStream(params.path);
    try {
      const init = { method: 'PUT', headers: { ...transportHeaders(signS3Headers(this.credentials(config), 'PUT', target, params.checksum, params.mimeType)), 'Content-Length': String(params.size) }, body: body as unknown as BodyInit, duplex: 'half', signal: AbortSignal.timeout(600_000) };
      const response = await this.transport(`${target.origin}${target.canonicalUri}`, init);
      await response.body?.cancel();
      if (!response.ok) throw new Error(`${this.provider} 流式上传失败：${response.status}`);
      return { storageKey: params.key, publicUrl: publicUrlFromDomain(config, params.key) };
    } finally { body.destroy(); }
  }
  async remove(config: RuntimeCdnConfig, key: string): Promise<void> {
    const target = this.target(config, key);
    const response = await this.transport(`${target.origin}${target.canonicalUri}`, { method: 'DELETE', headers: transportHeaders(signS3Headers(this.credentials(config), 'DELETE', target, EMPTY_SHA256)), signal: AbortSignal.timeout(30_000) });
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) throw new Error(`${this.provider} 删除失败：${response.status}`);
  }
  async objectExists(config: RuntimeCdnConfig, key: string): Promise<boolean> {
    const target = this.target(config, key);
    const response = await this.transport(`${target.origin}${target.canonicalUri}`, { method: 'HEAD', headers: transportHeaders(signS3Headers(this.credentials(config), 'HEAD', target, EMPTY_SHA256)), signal: AbortSignal.timeout(30_000) });
    await response.body?.cancel();
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`${this.provider} 对象检查失败：${response.status}`);
    return true;
  }
  async getDownloadUrl(config: RuntimeCdnConfig, key: string, expiresSeconds: number): Promise<string> {
    const target = this.target(config, key);
    return `${target.origin}${target.canonicalUri}?${presignS3(this.credentials(config), 'GET', target, expiresSeconds)}`;
  }
  async createDirectUpload(config: RuntimeCdnConfig, params: { key: string; fileName: string; mimeType: string; size: number }, expiresSeconds: number): Promise<DirectUploadCredential> {
    const target = this.target(config, params.key);
    const seconds = normalizeExpiry(expiresSeconds);
    return { provider: this.provider, storageKey: params.key, uploadUrl: `${target.origin}${target.canonicalUri}?${presignS3(this.credentials(config), 'PUT', target, seconds)}`, method: 'PUT', headers: { 'Content-Type': params.mimeType || 'application/octet-stream' }, publicUrl: publicUrlFromDomain(config, params.key), expiresAt: new Date(Date.now() + seconds * 1000).toISOString() };
  }
}
