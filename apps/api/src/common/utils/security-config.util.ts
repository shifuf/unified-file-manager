import type { ConfigService } from '@nestjs/config';

const INSECURE_SECRET_VALUES = new Set([
  'local-development-secret',
  'local-development-crypto-key',
  'replace-with-production-random-secret',
  'replace-with-production-32-byte-base64-key',
  'change-this-password',
  'change-this-root-password',
]);

export function getJwtSecret(configService: ConfigService): string {
  return getRequiredSecret(configService, 'JWT_SECRET', 'local-development-secret');
}

/**
 * HMAC key for public/share temporary access URLs.
 * Prefer a dedicated PUBLIC_URL_SIGNING_KEY so a leaked signed URL material
 * does not expand into session JWT forgery. Falls back to JWT_SECRET when unset.
 */
export function getPublicUrlSigningSecret(configService: ConfigService): string {
  const dedicated = configService.get<string>('PUBLIC_URL_SIGNING_KEY')?.trim();
  if (dedicated) {
    if (isProduction(configService) && isWeakProductionSecret(dedicated)) {
      throw new Error(
        'PUBLIC_URL_SIGNING_KEY must be set to a strong production value before starting the API.',
      );
    }
    return dedicated;
  }
  return getJwtSecret(configService);
}

export function getAppCryptoKey(configService: ConfigService): string {
  return getRequiredSecret(configService, 'APP_CRYPTO_KEY', 'local-development-crypto-key');
}

export function getPreviousAppCryptoKeys(configService: ConfigService): string[] {
  return configService
    .get<string>('APP_CRYPTO_KEY_PREVIOUS', '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)
    .filter((key) => !isInsecureSecretValue(key));
}

/**
 * Secure by default: only an explicit development/test environment relaxes the
 * strong-secret and default-credential requirements. Any other value — including
 * 'production', 'prod', 'staging', a typo, or an unset NODE_ENV — is treated as
 * production so the API refuses to boot with insecure fallback secrets instead of
 * silently using them (which would let an attacker forge JWTs or use default admin
 * credentials).
 */
export function isProduction(configService: ConfigService): boolean {
  const env = configService.get<string>('NODE_ENV', '').trim().toLowerCase();
  return env !== 'development' && env !== 'test';
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

export function assertStrongProductionValue(
  configService: ConfigService,
  key: string,
  value: string,
  minLength = 32,
): void {
  if (isProduction(configService) && (value.length < minLength || isInsecureSecretValue(value))) {
    throw new Error(`${key} must be set to a strong production value before starting the API.`);
  }
}

function getRequiredSecret(configService: ConfigService, key: string, developmentFallback: string): string {
  const configured = configService.get<string>(key);
  const secret = configured?.trim() || developmentFallback;

  if (isProduction(configService) && isWeakProductionSecret(secret)) {
    throw new Error(`${key} must be set to a strong production value before starting the API.`);
  }

  return secret;
}

function isWeakProductionSecret(secret: string): boolean {
  return secret.length < 32 || isInsecureSecretValue(secret);
}

function isInsecureSecretValue(secret: string): boolean {
  const normalized = secret.trim().toLowerCase();
  return INSECURE_SECRET_VALUES.has(normalized) || normalized.startsWith('replace-with-') || normalized.startsWith('change-this-');
}
