import type { Request } from 'express';

/**
 * Best-effort client IP behind nginx / docker. Prefer the first X-Forwarded-For
 * hop when trust-proxy is enabled (deployment default).
 */
function normalizeIp(raw: string): string {
  const value = raw.trim().replace(/^::ffff:/i, '');
  return value || 'unknown';
}

export function getClientIp(request: Request): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) {
      return normalizeIp(first);
    }
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    const first = String(forwarded[0]).split(',')[0]?.trim();
    if (first) {
      return normalizeIp(first);
    }
  }

  const realIp = request.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return normalizeIp(realIp);
  }

  // Express may return IPv6-mapped IPv4 like ::ffff:1.2.3.4
  return normalizeIp(request.ip || request.socket?.remoteAddress || 'unknown');
}
