import { isIP } from 'node:net';

/** Strip an IPv6-mapped IPv4 prefix and normalize for comparison. */
export function normalizeClientIp(ip?: string): string {
  if (!ip) {
    return '';
  }

  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  return (mapped ? mapped[1] : ip).trim().toLowerCase();
}

/** Clean a user-supplied IP allowlist: trim, drop blanks, dedupe, cap length. */
export function sanitizeIpAllowlist(value: unknown): string[] {
  const entries = Array.isArray(value) ? value.map((item) => String(item)) : [];
  return [...new Set(entries.map((entry) => entry.trim()).filter(Boolean))].slice(0, 100);
}

/**
 * Whether a client IP is permitted by an allowlist of exact IPs and IPv4 CIDR
 * ranges. An empty allowlist means "no restriction".
 */
export function isIpAllowed(ip: string | undefined, allowlist: string[]): boolean {
  if (allowlist.length === 0) {
    return true;
  }

  const client = normalizeClientIp(ip);
  if (!client) {
    return false;
  }

  return allowlist.some((entry) => matchEntry(client, entry.trim().toLowerCase()));
}

function matchEntry(client: string, entry: string): boolean {
  if (!entry) {
    return false;
  }

  if (entry.includes('/')) {
    return matchIpv4Cidr(client, entry);
  }

  return normalizeClientIp(entry) === client;
}

function matchIpv4Cidr(client: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);

  if (isIP(range) !== 4 || isIP(client) !== 4 || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }

  const toInt = (ip: string): number => ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(client) & mask) === (toInt(range) & mask);
}
