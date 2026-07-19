type HeaderReader = {
  get(name: string): string | undefined;
  protocol?: string;
  secure?: boolean;
};

/**
 * Whether to trust client-supplied X-Forwarded-* headers (host/proto/ssl). Mirrors
 * the Express `trust proxy` decision: trusted by default because the deployment
 * sits behind nginx, but disabled when TRUST_PROXY is explicitly turned off so a
 * directly-exposed API cannot be tricked into trusting forged forwarding headers.
 */
function shouldTrustProxyHeaders(): boolean {
  const value = (process.env.TRUST_PROXY ?? '').trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(value);
}

export function parseOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      try {
        return new URL(origin).origin;
      } catch {
        return origin.replace(/\/+$/, '');
      }
    });
}

export function buildFrameAncestors(origins: string[]): string {
  return ["'self'", ...new Set(origins)].join(' ');
}

export function normalizePublicBaseUrl(value?: string | null): string | undefined {
  const normalized = value?.trim().replace(/\/+$/, '');

  if (!normalized || /YOUR_SERVER_IP/i.test(normalized)) {
    return undefined;
  }

  return normalized;
}

export function resolvePublicBaseUrl(configured?: string | null, fallback?: string | null): string | undefined {
  return normalizePublicBaseUrl(configured) ?? normalizePublicBaseUrl(fallback);
}

/**
 * Make a site-relative path absolute when a base is known.
 * Leaves already-absolute http(s) URLs unchanged.
 */
export function absolutizePublicUrl(urlOrPath: string, base?: string | null): string {
  const value = urlOrPath.trim();
  if (!value) {
    return value;
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  const site = normalizePublicBaseUrl(base);
  if (!site) {
    return value.startsWith('/') ? value : `/${value}`;
  }
  const path = value.startsWith('/') ? value : `/${value}`;
  return `${site}${path}`;
}

/** Site public origin from PUBLIC_URL. */
export function getConfiguredPublicUrl(getEnv: (key: string) => string | undefined): string | undefined {
  return normalizePublicBaseUrl(getEnv('PUBLIC_URL'));
}

export function buildRequestPublicBaseUrl(request: HeaderReader): string | undefined {
  const forwardedHost = shouldTrustProxyHeaders() ? firstHeaderValue(request.get('x-forwarded-host')) : undefined;
  const host = forwardedHost ?? firstHeaderValue(request.get('host'));

  if (!host) {
    return undefined;
  }

  const protocol = getRequestProtocol(request);

  return `${protocol}://${host}`.replace(/\/+$/, '');
}

export function getRequestProtocol(request: HeaderReader): string {
  if (isSecureRequest(request)) {
    return 'https';
  }

  return proxyProtocolValues(request)[0] ?? request.protocol ?? 'http';
}

export function isSecureRequest(request: HeaderReader): boolean {
  if (request.secure) {
    return true;
  }

  if (proxyProtocolValues(request).includes('https')) {
    return true;
  }

  if (!shouldTrustProxyHeaders()) {
    return false;
  }

  return (
    isTruthyHttpsHeader(request.get('x-forwarded-ssl')) ||
    isTruthyHttpsHeader(request.get('front-end-https')) ||
    Boolean(firstHeaderValue(request.get('x-arr-ssl')))
  );
}

function proxyProtocolValues(request: HeaderReader): string[] {
  if (!shouldTrustProxyHeaders()) {
    return [];
  }

  return [
    ...splitHeaderValues(request.get('x-forwarded-proto')),
    ...splitHeaderValues(request.get('x-forwarded-protocol')),
    ...splitHeaderValues(request.get('x-forwarded-scheme')),
    ...splitHeaderValues(request.get('x-url-scheme')),
    ...forwardedHeaderProtos(request.get('forwarded')),
    cloudflareVisitorScheme(request.get('cf-visitor')) ?? '',
  ]
    .map((value) => value.toLowerCase())
    .filter(Boolean);
}

function firstHeaderValue(value?: string): string | undefined {
  const first = value?.split(',')[0]?.trim();
  return first || undefined;
}

function splitHeaderValues(value?: string): string[] {
  return value
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function forwardedHeaderProtos(value?: string): string[] {
  return value
    ? value
        .split(',')
        .map((item) => item.match(/(?:^|;)\s*proto=(?:"([^"]+)"|([^;,\s]+))/i))
        .map((match) => (match?.[1] ?? match?.[2] ?? '').trim())
        .filter(Boolean)
    : [];
}

function cloudflareVisitorScheme(value?: string): string | undefined {
  const first = firstHeaderValue(value);
  if (!first) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(first) as { scheme?: unknown };
    return typeof parsed.scheme === 'string' ? parsed.scheme.trim() : undefined;
  } catch {
    return undefined;
  }
}

function isTruthyHttpsHeader(value?: string): boolean {
  const normalized = firstHeaderValue(value)?.toLowerCase();
  return normalized === 'on' || normalized === 'https' || normalized === 'true' || normalized === '1';
}
