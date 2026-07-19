import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF protection for server-initiated outbound requests (remote storage health
 * checks, object downloads, upyun uploads, etc.).
 *
 * Project administrators control storage `endpoint` / `domain` values, so without
 * a guard they could point the server at internal addresses such as
 * `http://169.254.169.254/...` (cloud metadata) or `http://10.x.x.x/...` and have
 * the API issue requests on their behalf — including upyun Basic-auth credentials.
 *
 * The guard:
 *  - allows only http/https schemes (blocks file:, gopher:, data:, …);
 *  - resolves the hostname and rejects private, loopback, link-local, CGNAT,
 *    multicast and reserved addresses (DNS-rebinding aware: every resolved
 *    address must be public);
 *  - optionally enforces an allowlist of hostnames.
 *
 * `safeFetch` additionally follows redirects manually, re-validating every hop,
 * so a public URL cannot 3xx-redirect into the internal network.
 */

export interface OutboundUrlOptions {
  /** Restrict to these hostnames (case-insensitive, supports `*.example.com`). Empty = any public host. */
  allowedHosts?: string[];
  /** Reject non-https URLs when true. */
  requireHttps?: boolean;
  /** Permit private/internal targets (on-prem S3-compatible gateways). Defaults to STORAGE_ALLOW_PRIVATE_ENDPOINTS. */
  allowPrivate?: boolean;
}

export interface SafeFetchOptions extends OutboundUrlOptions {
  /** Maximum number of redirects to follow (each re-validated). Default 3. */
  maxRedirects?: number;
}

export class UnsafeOutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeOutboundUrlError';
  }
}

function envAllowsPrivate(): boolean {
  const value = (process.env.STORAGE_ALLOW_PRIVATE_ENDPOINTS ?? '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

/**
 * Normalize a possibly scheme-less endpoint (e.g. aliyun `oss-cn-hangzhou.aliyuncs.com`)
 * into an absolute https URL so it can be validated and compared as a URL.
 */
export function normalizeOutboundUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true; // Unparseable — treat as unsafe.
  }

  const [a, b, c] = parts;
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

export function isPrivateIpv6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0]; // strip zone id

  if (addr === '::1' || addr === '::') {
    return true;
  }

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible addresses.
  const mapped = addr.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (mapped) {
    return isPrivateIpv4(mapped[1]);
  }

  if (addr.startsWith('fe8') || addr.startsWith('fe9') || addr.startsWith('fea') || addr.startsWith('feb')) {
    return true; // link-local fe80::/10
  }

  if (addr.startsWith('fc') || addr.startsWith('fd')) {
    return true; // unique local fc00::/7
  }

  if (addr.startsWith('ff')) {
    return true; // multicast
  }

  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    return isPrivateIpv4(ip);
  }
  if (family === 6) {
    return isPrivateIpv6(ip);
  }
  return true; // Not an IP literal — caller should resolve first; unknown is unsafe.
}

function hostMatchesAllowlist(hostname: string, allowlist: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowlist.some((pattern) => {
    const normalized = pattern.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    if (normalized.startsWith('*.')) {
      const suffix = normalized.slice(1); // ".example.com"
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === normalized;
  });
}

/**
 * Validate that a URL is safe to request from the server. Throws
 * {@link UnsafeOutboundUrlError} when it targets an internal/forbidden address.
 */
export async function assertSafeOutboundUrl(rawUrl: string, options: OutboundUrlOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeOutboundUrlError('请求地址格式无效。');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeOutboundUrlError(`不支持的请求协议：${url.protocol}`);
  }

  if (options.requireHttps && url.protocol !== 'https:') {
    throw new UnsafeOutboundUrlError('出站请求必须使用 HTTPS。');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  if (options.allowedHosts && options.allowedHosts.length > 0 && !hostMatchesAllowlist(hostname, options.allowedHosts)) {
    throw new UnsafeOutboundUrlError(`目标域名不在允许列表内：${hostname}`);
  }

  const allowPrivate = options.allowPrivate ?? envAllowsPrivate();
  if (allowPrivate) {
    return url;
  }

  // If the host is an IP literal, classify it directly; otherwise resolve every address.
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new UnsafeOutboundUrlError(`禁止访问内部地址：${hostname}`);
    }
    return url;
  }

  let resolved: Array<{ address: string }>; // dns lookup with all:true
  try {
    resolved = await lookup(hostname, { all: true });
  } catch {
    throw new UnsafeOutboundUrlError(`无法解析目标主机：${hostname}`);
  }

  if (resolved.length === 0) {
    throw new UnsafeOutboundUrlError(`无法解析目标主机：${hostname}`);
  }

  for (const entry of resolved) {
    if (isPrivateAddress(entry.address)) {
      throw new UnsafeOutboundUrlError(`目标主机解析到内部地址，已拒绝：${hostname}`);
    }
  }

  return url;
}

/**
 * SSRF-safe fetch: validates the URL, then follows redirects manually so each hop
 * is re-validated against the same policy.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? 3;
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertSafeOutboundUrl(currentUrl, options);
    const response = await fetch(currentUrl, { ...init, redirect: 'manual' });

    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      const location = response.headers.get('location') ?? '';
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return response;
  }

  throw new UnsafeOutboundUrlError('重定向次数过多，已终止远程请求。');
}
