import type { ConfigService } from '@nestjs/config';

const INSECURE_SECRET_VALUES = new Set([
  'local-development-secret',
  'local-development-crypto-key',
  'replace-with-production-random-secret',
  'replace-with-production-32-byte-base64-key',
  'change-this-password',
  'change-this-root-password',
]);

export function getRequiredSecret(configService: ConfigService, key: string, developmentFallback: string): string {
  const configured = configService.get<string>(key);
  const secret = configured?.trim() || developmentFallback;

  if (isProduction(configService) && isWeakProductionSecret(secret)) {
    throw new Error(`${key} must be set to a strong production value before starting the API.`);
  }

  return secret;
}

export function getConfigBoolean(configService: ConfigService, key: string, fallback: boolean): boolean {
  const value = configService.get<unknown>(key);
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

export function isProduction(configService: ConfigService): boolean {
  const env = configService.get<string>('NODE_ENV', '').trim().toLowerCase();
  return env !== 'development' && env !== 'test';
}

function isWeakProductionSecret(secret: string): boolean {
  return secret.length < 32 || isInsecureSecretValue(secret);
}

function isInsecureSecretValue(secret: string): boolean {
  const normalized = secret.trim().toLowerCase();
  return (
    INSECURE_SECRET_VALUES.has(normalized) ||
    normalized.startsWith('replace-with-') ||
    normalized.startsWith('change-this-')
  );
}
