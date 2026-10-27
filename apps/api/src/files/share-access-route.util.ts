export type AdminAccessMode = 'ACCELERATED' | 'DIRECT';

export type AdminAccessRoute = {
  mode: AdminAccessMode;
  label: '加速访问' | '源站/直连';
  host: string | null;
};

export function getAdminAccessRoute(
  provider: string | null | undefined,
  config: Record<string, unknown> | null | undefined,
): AdminAccessRoute {
  const configuredDomain = typeof config?.domain === 'string' ? config.domain.trim() : '';
  const host = parseHost(configuredDomain);
  const accelerated = provider !== 'LOCAL' && configuredDomain.length > 0;

  return {
    mode: accelerated ? 'ACCELERATED' : 'DIRECT',
    label: accelerated ? '加速访问' : '源站/直连',
    host,
  };
}

function parseHost(domain: string): string | null {
  if (!domain) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(domain) ? domain : `https://${domain}`).host;
  } catch {
    return domain.replace(/^https?:\/\//i, '').split('/')[0] || null;
  }
}
