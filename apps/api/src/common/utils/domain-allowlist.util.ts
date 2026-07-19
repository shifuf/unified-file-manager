export function normalizeDomainAllowlist(value: unknown): string[] {
  const entries = Array.isArray(value)
    ? value.map((item) => String(item))
    : typeof value === 'string'
      ? value.split(/[\s,;]+/)
      : [];

  return [...new Set(entries.map(normalizeHostPattern).filter(Boolean))];
}

export function isHostAllowed(hostHeader: string | undefined, allowlist: string[]): boolean {
  if (allowlist.length === 0) {
    return true;
  }

  const requestHost = splitHostAndPort(normalizeHostPattern(hostHeader ?? ''));
  if (!requestHost.hostname) {
    return false;
  }

  return allowlist.some((pattern) => matchHostPattern(requestHost, pattern));
}

export function isUrlHostAllowed(value: string | undefined, allowlist: string[]): boolean {
  if (!value) {
    return true;
  }

  try {
    return isHostAllowed(new URL(value).host, allowlist);
  } catch {
    return false;
  }
}

function matchHostPattern(requestHost: HostParts, pattern: string): boolean {
  if (pattern === '*') {
    return true;
  }

  const allowedHost = splitHostAndPort(pattern);
  if (!allowedHost.hostname) {
    return false;
  }

  if (allowedHost.port && allowedHost.port !== requestHost.port) {
    return false;
  }

  if (allowedHost.hostname.startsWith('*.')) {
    const suffix = allowedHost.hostname.slice(1);
    return requestHost.hostname.endsWith(suffix) && requestHost.hostname.length > suffix.length;
  }

  return requestHost.hostname === allowedHost.hostname;
}

function normalizeHostPattern(value: string): string {
  let normalized = value.trim().toLowerCase();
  if (!normalized || normalized === '*') {
    return normalized;
  }

  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    try {
      normalized = new URL(normalized).host;
    } catch {
      return '';
    }
  }

  if (normalized.startsWith('//')) {
    try {
      normalized = new URL(`http:${normalized}`).host;
    } catch {
      return '';
    }
  }

  normalized = normalized.replace(/\/+$/, '');
  const slashIndex = normalized.indexOf('/');
  if (slashIndex >= 0) {
    normalized = normalized.slice(0, slashIndex);
  }

  if (normalized.startsWith('.')) {
    normalized = `*${normalized}`;
  }

  return normalized;
}

interface HostParts {
  hostname: string;
  port?: string;
}

function splitHostAndPort(host: string): HostParts {
  if (!host || host === '*') {
    return { hostname: host };
  }

  if (host.startsWith('[')) {
    const bracketIndex = host.indexOf(']');
    if (bracketIndex < 0) {
      return { hostname: '' };
    }

    const hostname = host.slice(0, bracketIndex + 1);
    const port = host.slice(bracketIndex + 1).replace(/^:/, '') || undefined;
    return { hostname, port };
  }

  const colonIndex = host.lastIndexOf(':');
  if (colonIndex > -1 && host.indexOf(':') === colonIndex) {
    const port = host.slice(colonIndex + 1);
    if (/^\d+$/.test(port)) {
      return { hostname: host.slice(0, colonIndex), port };
    }
  }

  return { hostname: host };
}
