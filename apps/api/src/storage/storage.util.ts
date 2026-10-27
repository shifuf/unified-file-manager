import { BadRequestException } from '@nestjs/common';
import { CdnProvider } from '@prisma/client';

import type { RuntimeCdnConfig } from './storage.types';

/** Read a trimmed string field out of a runtime config. */
export function configText(config: RuntimeCdnConfig, key: string, fallback = ''): string {
  const value = config.config[key];
  if (value === undefined || value === null) {
    return fallback;
  }
  const text = typeof value === 'string' ? value.trim() : String(value).trim();
  return text || fallback;
}

/** Read a boolean-ish field (`true/1/yes/on`) out of a runtime config. */
export function configFlag(config: RuntimeCdnConfig, key: string, fallback = false): boolean {
  const value = config.config[key];
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

export function withScheme(value: string, fallbackScheme = 'https'): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return '';
  }
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `${fallbackScheme}://${trimmed}`;
}

export function hostnameOnly(value: string): string {
  try {
    return new URL(withScheme(value)).hostname;
  } catch {
    return value.trim().replace(/\/+$/, '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  }
}

export function encodeKeyPath(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function joinUrl(base: string, path: string): string {
  const root = base.replace(/\/+$/, '');
  const suffix = path.replace(/^\/+/, '');
  return suffix ? `${root}/${suffix}` : root;
}

export function publicUrlFromDomain(config: RuntimeCdnConfig, key: string): string | null {
  const domain = configText(config, 'domain');
  return domain ? joinUrl(withScheme(domain), encodeKeyPath(key)) : null;
}

export function rfc1123Date(date = new Date()): string {
  return date.toUTCString();
}

export function assertProviderConfig(config: RuntimeCdnConfig): void {
  if (config.provider === CdnProvider.LOCAL) {
    return;
  }
  if (!config.id) {
    throw new BadRequestException('存储配置缺少标识。');
  }
}
