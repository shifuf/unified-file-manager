/** Cookie names for the admin console session (httpOnly). */
export const ACCESS_COOKIE = 'ufm_access';
export const REFRESH_COOKIE = 'ufm_refresh';

export function parseCookieHeader(header: string | undefined, name: string): string | undefined {
  if (!header) {
    return undefined;
  }

  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (key === name) {
      return decodeURIComponent(trimmed.slice(eq + 1));
    }
  }

  return undefined;
}
