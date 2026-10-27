import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * SSRF guard for adapter-side outbound requests (remote object fetches, health
 * probes). Mirrors the main `ssrf-guard.util` rules but stays self-contained so
 * the storage module does not depend on feature modules.
 */
export async function assertAdapterUrlAllowed(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('远程地址格式无效。');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`不支持的远程协议：${url.protocol}`);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isPrivateAddress(hostname)) {
    throw new Error(`禁止访问内部地址：${hostname}`);
  }

  if (isIP(hostname)) {
    return;
  }

  let resolved: Array<{ address: string }>;
  try {
    resolved = await lookup(hostname, { all: true });
  } catch {
    throw new Error(`无法解析目标主机：${hostname}`);
  }

  for (const entry of resolved) {
    if (isPrivateAddress(entry.address)) {
      throw new Error(`目标主机解析到内部地址，已拒绝：${hostname}`);
    }
  }
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return isPrivateIpv4(address);
  }
  if (family === 6) {
    return isPrivateIpv6(address);
  }
  // Hostnames are resolved by the caller.
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0];
  if (addr === '::1' || addr === '::') return true;

  const mapped = addr.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (mapped) {
    return isPrivateIpv4(mapped[1]);
  }

  if (/^fe[89ab]/.test(addr)) return true;
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true;
  if (addr.startsWith('ff')) return true;
  return false;
}
