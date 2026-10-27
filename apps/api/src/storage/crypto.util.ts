import { createDecipheriv, createHmac } from 'node:crypto';

export function resolveCryptoKey(rawKey: string): Buffer {
  const fromBase64 = Buffer.from(rawKey, 'base64');
  if (fromBase64.length === 32) {
    return fromBase64;
  }
  return createHmac('sha256', 'unified-file-manager').update(rawKey).digest();
}

export function decryptText(vault: string, rawKey: string): string {
  const [version, ivValue, authTagValue, encryptedValue] = vault.split(':');
  if (version !== 'v1' || !ivValue || !authTagValue || !encryptedValue) {
    throw new Error('Unsupported secret vault format.');
  }

  const decipher = createDecipheriv('aes-256-gcm', resolveCryptoKey(rawKey), Buffer.from(ivValue, 'base64url'), {
    authTagLength: 16,
  });
  decipher.setAuthTag(Buffer.from(authTagValue, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function getSigningSecret(): string {
  const dedicated = (process.env.PUBLIC_URL_SIGNING_KEY ?? '').trim();
  if (dedicated) {
    return dedicated;
  }
  return (process.env.JWT_SECRET ?? '').trim() || 'local-development-secret';
}

export function hmacSha256Base64Url(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}
