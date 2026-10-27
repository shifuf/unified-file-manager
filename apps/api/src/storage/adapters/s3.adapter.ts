import { createHash, createHmac } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { CdnProvider } from '@prisma/client';

import type {
  DirectUploadCredential,
  RuntimeCdnConfig,
  StorageAdapter,
  StorageUploadParams,
  StoredObject,
} from '../storage.types';
import { configFlag, configText, publicUrlFromDomain, withScheme } from '../storage.util';

const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const MAX_PRESIGN_SECONDS = 604_800;

type S3Target = { origin: string; host: string; canonicalUri: string };

/** S3 / S3-compatible adapter (AWS Signature V4, no SDK required). */
@Injectable()
export class S3Adapter implements StorageAdapter {
  readonly provider = CdnProvider.S3;

  async upload(config: RuntimeCdnConfig, params: StorageUploadParams): Promise<StoredObject> {
    const target = this.target(config, params.key);
    const payloadHash = sha256Hex(params.buffer);
    const headers = this.signHeaders(config, 'PUT', target, payloadHash, params.mimeType);
    const response = await fetch(`${target.origin}${target.canonicalUri}`, {
      method: 'PUT',
      headers: transportHeaders(headers),
      body: new Uint8Array(params.buffer),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`S3 上传失败：${response.status} ${await safeText(response)}`);
    }

    return { storageKey: params.key, publicUrl: publicUrlFromDomain(config, params.key) };
  }

  async remove(config: RuntimeCdnConfig, key: string): Promise<void> {
    const target = this.target(config, key);
    const headers = this.signHeaders(config, 'DELETE', target, EMPTY_SHA256);
    const response = await fetch(`${target.origin}${target.canonicalUri}`, {
      method: 'DELETE',
      headers: transportHeaders(headers),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(`S3 删除失败：${response.status} ${await safeText(response)}`);
    }
  }

  async getDownloadUrl(config: RuntimeCdnConfig, key: string, expiresSeconds: number): Promise<string> {
    const target = this.target(config, key);
    return `${target.origin}${target.canonicalUri}?${this.presign(config, 'GET', target, expiresSeconds)}`;
  }

  async objectExists(config: RuntimeCdnConfig, key: string): Promise<boolean> {
    const target = this.target(config, key);
    const headers = this.signHeaders(config, 'HEAD', target, EMPTY_SHA256);
    const response = await fetch(`${target.origin}${target.canonicalUri}`, {
      method: 'HEAD',
      headers: transportHeaders(headers),
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status === 404) {
      return false;
    }
    if (!response.ok) {
      throw new Error(`S3 探测对象失败：${response.status}`);
    }
    return true;
  }

  async createDirectUpload(
    config: RuntimeCdnConfig,
    params: { key: string; fileName: string; mimeType: string; size: number },
    expiresSeconds: number,
  ): Promise<DirectUploadCredential> {
    const target = this.target(config, params.key);
    const query = this.presign(config, 'PUT', target, Math.min(expiresSeconds, MAX_PRESIGN_SECONDS));

    return {
      provider: CdnProvider.S3,
      storageKey: params.key,
      uploadUrl: `${target.origin}${target.canonicalUri}?${query}`,
      method: 'PUT',
      headers: { 'Content-Type': params.mimeType || 'application/octet-stream' },
      publicUrl: publicUrlFromDomain(config, params.key),
      expiresAt: new Date(Date.now() + Math.max(60, expiresSeconds) * 1000).toISOString(),
    };
  }

  private target(config: RuntimeCdnConfig, key: string): S3Target {
    const endpoint = withScheme(configText(config, 'endpoint'));
    const bucket = configText(config, 'bucket');
    const pathStyle = configFlag(config, 'pathStyle', true);
    let base: URL;

    try {
      base = new URL(endpoint);
    } catch {
      throw new Error('S3 Endpoint 无效，请填写完整地址（如 https://s3.amazonaws.com）。');
    }

    if (!bucket) {
      throw new Error('S3 Bucket 未配置。');
    }

    const basePath = base.pathname.replace(/\/+$/, '');
    const rawPath = pathStyle ? `${basePath}/${bucket}/${key}` : `${basePath}/${key}`;
    const host = pathStyle ? base.host : `${bucket}.${base.host}`;

    return { origin: `${base.protocol}//${host}`, host, canonicalUri: awsUriEncode(rawPath, false) || '/' };
  }

  private signHeaders(
    config: RuntimeCdnConfig,
    method: string,
    target: S3Target,
    payloadHash: string,
    contentType?: string,
  ): Record<string, string> {
    const { accessKeyId, secretAccessKey, region } = this.credentials(config);
    const amzDate = amzDateString(new Date());
    const dateStamp = amzDate.slice(0, 8);
    const headers: Record<string, string> = {
      host: target.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (contentType) {
      headers['content-type'] = contentType;
    }

    const names = Object.keys(headers).sort();
    const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join('');
    const signedHeaders = names.join(';');
    const canonicalRequest = [method, target.canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signature = hmacHex(signingKey(secretAccessKey, dateStamp, region), stringToSign);

    return {
      ...headers,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }

  private presign(config: RuntimeCdnConfig, method: string, target: S3Target, expiresSeconds: number): string {
    const { accessKeyId, secretAccessKey, region } = this.credentials(config);
    const amzDate = amzDateString(new Date());
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const parameters: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(Math.min(MAX_PRESIGN_SECONDS, Math.max(1, Math.floor(expiresSeconds)))),
      'X-Amz-SignedHeaders': 'host',
    };
    const canonicalQuery = Object.keys(parameters)
      .sort()
      .map((name) => `${awsUriEncode(name, true)}=${awsUriEncode(parameters[name], true)}`)
      .join('&');
    const canonicalRequest = [method, target.canonicalUri, canonicalQuery, `host:${target.host}\n`, 'host', UNSIGNED_PAYLOAD].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signature = hmacHex(signingKey(secretAccessKey, dateStamp, region), stringToSign);

    return `${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  private credentials(config: RuntimeCdnConfig) {
    return {
      accessKeyId: configText(config, 'accessKeyId'),
      secretAccessKey: configText(config, 'secretAccessKey'),
      region: configText(config, 'region', 'us-east-1'),
    };
  }
}

function transportHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'host'));
}

function amzDateString(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function signingKey(secretAccessKey: string, dateStamp: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function hmacHex(key: string | Buffer, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

function awsUriEncode(value: string, encodeSlash: boolean): string {
  let encoded = '';
  for (const char of value) {
    if (/[A-Za-z0-9\-._~]/.test(char)) {
      encoded += char;
      continue;
    }
    if (char === '/') {
      encoded += encodeSlash ? '%2F' : '/';
      continue;
    }
    for (const byte of Buffer.from(char, 'utf8')) {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return encoded;
}

async function safeText(response: Response): Promise<string> {
  return response.text().catch(() => '');
}
