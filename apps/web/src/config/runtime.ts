/**
 * Runtime / build-time configuration shared by the SPA.
 * Docker writes `runtime-config.js` at container start so ADMIN_LOGIN_PATH
 * takes effect on restart without rebuilding the image.
 */

declare global {
  interface Window {
    __UFM_RUNTIME__?: {
      adminLoginPath?: string;
    };
  }
}

const DEFAULT_ADMIN_LOGIN_PATH = '/console-login';

/** Normalize a path to a single absolute segment list, e.g. `admin` → `/admin`. */
export function normalizeAdminLoginPath(raw: string | undefined | null): string {
  const value = String(raw ?? '').trim();
  if (!value) {
    return DEFAULT_ADMIN_LOGIN_PATH;
  }

  let path = value.startsWith('/') ? value : `/${value}`;
  path = path.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (!path || path === '/') {
    return DEFAULT_ADMIN_LOGIN_PATH;
  }

  // Reject characters that would break routing or inject into runtime-config.js.
  if (!/^\/[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(path) || path.includes('//') || path.includes('..')) {
    return DEFAULT_ADMIN_LOGIN_PATH;
  }

  return path;
}

/**
 * Admin console login entry path.
 * Priority: runtime-config.js (Docker / nginx) → VITE_ADMIN_LOGIN_PATH → default.
 */
export function getAdminLoginPath(): string {
  if (typeof window !== 'undefined') {
    const fromRuntime = window.__UFM_RUNTIME__?.adminLoginPath;
    if (fromRuntime) {
      return normalizeAdminLoginPath(fromRuntime);
    }
  }

  const fromVite = import.meta.env.VITE_ADMIN_LOGIN_PATH as string | undefined;
  return normalizeAdminLoginPath(fromVite);
}

export { DEFAULT_ADMIN_LOGIN_PATH };
