import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export function randomToken(prefix: string, byteLength = 24): string {
  return `${prefix}${randomBytes(byteLength).toString('base64url')}`;
}

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function resolveCryptoKey(rawKey: string): Buffer {
  const fromBase64 = Buffer.from(rawKey, 'base64');

  if (fromBase64.length === 32) {
    return fromBase64;
  }

  return createHmac('sha256', 'unified-file-manager').update(rawKey).digest();
}

export function encryptText(plainText: string, rawKey: string): string {
  const key = resolveCryptoKey(rawKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return ['v1', iv.toString('base64url'), authTag.toString('base64url'), encrypted.toString('base64url')].join(
    ':',
  );
}

export function decryptText(vault: string, rawKey: string): string {
  const [version, ivValue, authTagValue, encryptedValue] = vault.split(':');

  if (version !== 'v1' || !ivValue || !authTagValue || !encryptedValue) {
    throw new Error('Unsupported secret vault format.');
  }

  const key = resolveCryptoKey(rawKey);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivValue, 'base64url'), {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(Buffer.from(authTagValue, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function canonicalQueryString(query: Record<string, unknown>): string {
  return Object.keys(query)
    .filter((key) => !['signature'].includes(key))
    .sort()
    .map((key) => {
      const value = query[key];
      // Express/Nest may surface repeated query keys as arrays; join so both
      // sides of the signature still get a stable string representation.
      const normalized = Array.isArray(value)
        ? value.map((item) => String(item ?? '')).join(',')
        : String(value ?? '');
      return `${key}=${normalized}`;
    })
    .join('&');
}

/**
 * Open-API signature payload (v2 only): includes SHA-256 hex of the raw body
 * as the 6th line so the body can't be swapped in transit.
 * Lines: METHOD \n path \n timestamp \n nonce \n canonicalQuery \n bodySha256Hex
 */
export function buildSignedPayload(params: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  query: Record<string, unknown>;
  body?: string;
}): string {
  const queryString = canonicalQueryString(params.query);
  const bodyHash = createHash('sha256').update(params.body ?? '').digest('hex');
  return [params.method.toUpperCase(), params.path, params.timestamp, params.nonce, queryString, bodyHash].join('\n');
}
