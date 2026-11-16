import type { RuntimeCdnConfig } from './types';
export function configText(config: RuntimeCdnConfig, key: string, fallback = ''): string {
  const value = config.config[key];
  return value === undefined || value === null ? fallback : String(value).trim() || fallback;
}
export function configFlag(config: RuntimeCdnConfig, key: string, fallback = false): boolean {
  const value = config.config[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase())) return true;
    if (['false', '0', 'no', 'off'].includes(value.trim().toLowerCase())) return false;
  }
  return fallback;
}
export function withScheme(value: string, fallbackScheme = 'https'): string {
  const text = value.trim().replace(/\/+$/, '');
  return text && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? `${fallbackScheme}://${text}` : text;
}
export function hostnameOnly(value: string): string { return new URL(withScheme(value)).hostname; }
export function encodeKeyPath(key: string): string { return key.split('/').map(encodeURIComponent).join('/'); }
export function joinUrl(base: string, path: string): string { return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`; }
export function publicUrlFromDomain(config: RuntimeCdnConfig, key: string): string | null {
  const domain = configText(config, 'domain');
  return domain ? joinUrl(withScheme(domain), encodeKeyPath(key)) : null;
}
export function rfc1123Date(date = new Date()): string { return date.toUTCString(); }
