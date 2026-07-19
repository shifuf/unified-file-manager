import { createHash, createHmac, randomBytes } from 'node:crypto';

export interface UfmClientOptions {
  baseUrl: string;
  appId: string;
  appSecret: string;
  /** Optional fetch implementation (defaults to global fetch). */
  fetch?: typeof fetch;
}

export interface ListFilesParams {
  page?: number;
  pageSize?: number;
  keyword?: string;
  category?: string;
  folderPath?: string;
  status?: string;
}

/** Single file item returned by list / get / upload / restore endpoints. */
export interface FileListItem {
  id: string;
  projectId: string;
  projectName?: string | null;
  originalName: string;
  mimeType: string;
  extension?: string | null;
  size: number;
  category?: string | null;
  status?: string | null;
  scanStatus?: string | null;
  scanDetail?: string | null;
  scannedAt?: string | Date | null;
  isPublic?: boolean;
  checksum?: string | null;
  /** Stable public display URL (`/api/public/files/:id`). Prefer for images / CDN. */
  accessUrl?: string | null;
  /** Alias of accessUrl for backward compatibility. */
  publicUrl?: string | null;
  /** Thumbnail / preview URL when available (often accessUrl?w=320&format=webp). */
  thumbnailUrl?: string | null;
  remark?: string | null;
  tags?: string[];
  folderPath?: string | null;
  duplicateOfId?: string | null;
  duplicate?: boolean;
  previewable?: boolean;
  cdnProvider?: string | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  deletedAt?: string | Date | null;
  purgeAt?: string | Date | null;
}

export interface FileVersionItem {
  id: string;
  version: number;
  size: number;
  originalName: string;
  mimeType: string;
  checksum?: string | null;
  createdAt: string | Date;
  remark?: string | null;
}

export interface ProjectUsage {
  projectId: string;
  projectName?: string | null;
  usedBytes: number;
  usedFiles: number;
  quotaBytes: number | null;
  quotaFiles: number | null;
  bytesUsagePercent: number | null;
  filesUsagePercent: number | null;
}

export interface BatchResult {
  success: boolean;
  total: number;
  disabledShareCount?: number;
}

export interface ImageTransformParams {
  /** Target width in px (scale; or crop width when x/y present). */
  w?: number;
  /** Target height in px. */
  h?: number;
  /** Crop origin x (px). When set with y, w/h become crop box. */
  x?: number;
  /** Crop origin y (px). */
  y?: number;
  /** Explicit crop width (px); can combine with scale w. */
  cw?: number;
  /** Explicit crop height (px). */
  ch?: number;
  /** Output format: webp | avif | auto. */
  format?: 'webp' | 'avif' | 'auto' | string;
}

/**
 * Append image transform query params to a public accessUrl.
 * Example: buildTransformUrl(url, { w: 320, format: 'webp' })
 * → `${url}?w=320&format=webp`
 *
 * Does not require signing; works on GET /api/public/files/:id.
 */
export function buildTransformUrl(
  accessUrl: string,
  params: ImageTransformParams = {},
): string {
  if (!accessUrl) {
    return accessUrl;
  }
  const url = new URL(accessUrl, 'http://local.invalid');
  const isAbsolute = /^https?:\/\//i.test(accessUrl);
  if (params.w != null) url.searchParams.set('w', String(params.w));
  if (params.h != null) url.searchParams.set('h', String(params.h));
  if (params.x != null) url.searchParams.set('x', String(params.x));
  if (params.y != null) url.searchParams.set('y', String(params.y));
  if (params.cw != null) url.searchParams.set('cw', String(params.cw));
  if (params.ch != null) url.searchParams.set('ch', String(params.ch));
  if (params.format) url.searchParams.set('format', params.format);
  if (isAbsolute) {
    return url.toString();
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function buildSignedPayload(params: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  query: Record<string, unknown>;
  bodyHash: string;
}): string {
  const queryString = Object.keys(params.query)
    .filter((key) => key !== 'signature')
    .sort()
    .map((key) => `${key}=${String(params.query[key] ?? '')}`)
    .join('&');

  return [
    params.method.toUpperCase(),
    params.path,
    params.timestamp,
    params.nonce,
    queryString,
    params.bodyHash,
  ].join('\n');
}

export class UfmClient {
  private readonly baseUrl: string;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: UfmClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listFiles(params: ListFilesParams = {}): Promise<unknown> {
    return this.request('GET', '/api/open/files', { ...params });
  }

  async getFile(fileId: string): Promise<FileListItem> {
    return this.request('GET', `/api/open/files/${fileId}`) as Promise<FileListItem>;
  }

  /**
   * Display / hotlink URL for browsers, img tags, CDNs.
   * Prefer this over download() for images: public accessUrl supports HTTP cache
   * (max-age + ETag). Does not require open-API signing at request time.
   *
   * Returns null when the file is not ACTIVE / has no accessUrl.
   */
  async getAccessUrl(fileId: string): Promise<string | null> {
    const file = await this.getFile(fileId);
    return file.accessUrl || file.publicUrl || null;
  }

  /**
   * Thumbnail / preview URL when available (often a cached ?w=320&format=webp path).
   */
  async getThumbnailUrl(fileId: string): Promise<string | null> {
    const file = await this.getFile(fileId);
    return file.thumbnailUrl || file.accessUrl || null;
  }

  /**
   * Build a transformed public image URL for the given file.
   * Fetches accessUrl then applies w/h/format (etc.) query params.
   */
  async getTransformUrl(
    fileId: string,
    params: ImageTransformParams = {},
  ): Promise<string | null> {
    const accessUrl = await this.getAccessUrl(fileId);
    if (!accessUrl) return null;
    return buildTransformUrl(accessUrl, params);
  }

  async uploadFile(file: Buffer | Uint8Array, options: {
    fileName: string;
    mimeType?: string;
    folderPath?: string;
    duplicateStrategy?: 'reject' | 'reuse' | 'replace';
  }): Promise<unknown> {
    const form = new FormData();
    const blob = new Blob([file as BlobPart], { type: options.mimeType || 'application/octet-stream' });
    form.append('file', blob, options.fileName);
    if (options.folderPath) form.append('folderPath', options.folderPath);
    if (options.duplicateStrategy) form.append('duplicateStrategy', options.duplicateStrategy);
    return this.request('POST', '/api/open/files', {}, form);
  }

  /**
   * Authenticated no-store download stream URL.
   * Use for force-download / private binary transfer.
   * For image display, use getAccessUrl() / getThumbnailUrl() instead
   * (public accessUrl supports Cache-Control + ETag).
   *
   * Note: the open download endpoint streams bytes (not JSON). This method
   * returns a base URL path; callers that need a signed request should use
   * the low-level request() flow or attach open-API headers themselves.
   */
  async downloadUrl(fileId: string): Promise<string> {
    // Download is a binary stream endpoint (Cache-Control: no-store), not JSON.
    // Return the absolute path so callers can issue a signed GET themselves.
    return `${this.baseUrl}/api/open/files/${fileId}/download`;
  }

  async createShare(
    fileId: string,
    payload: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.request('POST', `/api/open/files/${fileId}/shares`, {}, payload);
  }

  async updateFile(fileId: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.request('PUT', `/api/open/files/${fileId}`, {}, payload);
  }

  async deleteFile(fileId: string): Promise<unknown> {
    return this.request('DELETE', `/api/open/files/${fileId}`);
  }

  async restoreFile(fileId: string): Promise<unknown> {
    return this.request('POST', `/api/open/files/${fileId}/restore`);
  }

  async listVersions(fileId: string): Promise<FileVersionItem[]> {
    return this.request('GET', `/api/open/files/${fileId}/versions`) as Promise<FileVersionItem[]>;
  }

  async restoreVersion(fileId: string, version: number): Promise<FileListItem> {
    return this.request(
      'POST',
      `/api/open/files/${fileId}/versions/${version}/restore`,
    ) as Promise<FileListItem>;
  }

  async batchRecycle(fileIds: string[]): Promise<BatchResult> {
    return this.request('POST', '/api/open/files/batch/recycle', {}, { fileIds }) as Promise<BatchResult>;
  }

  async batchRestore(fileIds: string[]): Promise<BatchResult> {
    return this.request('POST', '/api/open/files/batch/restore', {}, { fileIds }) as Promise<BatchResult>;
  }

  async getQuota(): Promise<ProjectUsage> {
    return this.request('GET', '/api/open/files/quota') as Promise<ProjectUsage>;
  }

  /** Alias of getQuota(). */
  async getUsage(): Promise<ProjectUsage> {
    return this.getQuota();
  }

  async listFolders(): Promise<unknown> {
    return this.request('GET', '/api/open/files/folders');
  }

  async folderTree(): Promise<unknown> {
    return this.request('GET', '/api/open/files/folder-tree');
  }

  async search(q: string, params: { page?: number; pageSize?: number } = {}): Promise<unknown> {
    return this.request('GET', '/api/open/files/search', { q, ...params });
  }

  async setPublic(fileId: string, isPublic: boolean): Promise<unknown> {
    return this.updateFile(fileId, { isPublic });
  }

  async listShares(fileId: string): Promise<unknown> {
    return this.request('GET', `/api/open/files/${fileId}/shares`);
  }

  async updateShare(shareId: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.request('PUT', `/api/open/files/shares/${shareId}`, {}, payload);
  }

  async disableShare(shareId: string): Promise<unknown> {
    return this.request('DELETE', `/api/open/files/shares/${shareId}`);
  }

  private async request(
    method: string,
    path: string,
    query: Record<string, unknown> = {},
    body?: BodyInit | Record<string, unknown> | null,
  ): Promise<unknown> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const cleanQuery = Object.fromEntries(
      Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''),
    );

    let bodyInit: BodyInit | undefined;
    let bodyHash = sha256Hex('');
    const headers: Record<string, string> = {
      'x-app-id': this.appId,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
    };

    if (body instanceof FormData) {
      bodyInit = body;
      // Multipart: body hash is empty-string hash (same as open-api guard for multipart).
      bodyHash = sha256Hex('');
    } else if (body && typeof body === 'object') {
      const json = JSON.stringify(body);
      bodyInit = json;
      bodyHash = sha256Hex(json);
      headers['Content-Type'] = 'application/json';
    }

    const signature = hmacSha256Hex(
      this.appSecret,
      buildSignedPayload({
        method,
        path,
        timestamp,
        nonce,
        query: cleanQuery,
        bodyHash,
      }),
    );
    headers['x-signature'] = signature;

    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(cleanQuery)) {
      url.searchParams.set(key, String(value));
    }

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: bodyInit,
    });

    const text = await response.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // keep text
    }

    if (!response.ok) {
      const message =
        data && typeof data === 'object' && data !== null && 'message' in data
          ? String((data as { message: unknown }).message)
          : text || `HTTP ${response.status}`;
      throw new Error(message);
    }

    return data;
  }
}

export default UfmClient;
