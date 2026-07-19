import axios from 'axios';
import type { AxiosError } from 'axios';
import { ElMessage } from 'element-plus';
import type { Router } from 'vue-router';

// Custom per-request flags read by the interceptors below.
declare module 'axios' {
  export interface AxiosRequestConfig {
    /** Internal: set once a request has already been retried after a token refresh. */
    _retried?: boolean;
    /** Suppress the automatic error toast for this request. */
    _silent?: boolean;
  }
}

export const http = axios.create({
  baseURL: '/api',
  timeout: 30000,
  withCredentials: true,
});

// Endpoints that must not trigger the refresh/logout machinery (they ARE the auth flow).
const AUTH_ENDPOINTS = ['/auth/login', '/auth/refresh', '/auth/logout'];

// Single-flight refresh: concurrent 401s share one refresh attempt and one logout.
let refreshInFlight: Promise<string | null> | null = null;
// Guards the session-expired handling so a burst of concurrent 401s produces a
// single "登录已过期" message and a single redirect, not one per failed request.
let sessionExpiredHandled = false;
const recentMessages = new Map<string, number>();

/**
 * Lazy accessors — avoid top-level imports of router / auth store here.
 * Those modules import modules.ts which imports this file, forming a cycle that
 * collapses to a TDZ error (`Cannot access 'E' before initialization`) after Vite
 * production bundling. Runtime dynamic import breaks the cycle cleanly.
 */
async function getAuthStore() {
  const { useAuthStore } = await import('@/stores/auth');
  return useAuthStore();
}

async function getRouter(): Promise<Router> {
  const mod = await import('@/router');
  return mod.default;
}

http.interceptors.request.use((config) => {
  // Cookie session is sent automatically via withCredentials. No Authorization header needed
  // for the admin console. Open API clients still send their own HMAC headers.
  return config;
});

http.interceptors.response.use(
  (response) => response.data,
  async (error: AxiosError<{ message?: string | string[] } | Blob>) => {
    const authStore = await getAuthStore();
    const original = error.config;
    const status = error.response?.status;
    const isAuthCall = isAuthEndpoint(original?.url);

    // On a 401 for a normal API call, try one silent token refresh and replay the request.
    if (status === 401 && original && !original._retried && !isAuthCall && authStore.loggedIn) {
      original._retried = true;
      const newToken = await runSingleFlightRefresh(authStore);
      if (newToken) {
        return http(original);
      }
    }

    // A 401 we couldn't recover from means the session is gone. Clear it, show one
    // friendly notice, and redirect — suppressing the raw per-request "Unauthorized"
    // toast that would otherwise fire (twice, for concurrent requests) below.
    if (status === 401 && !isAuthCall) {
      await handleSessionExpired(authStore);
      return Promise.reject(error);
    }

    if (!original?._silent) {
      notifyError((await readErrorMessage(error)) || '请求失败，请稍后重试。');
    }

    return Promise.reject(error);
  },
);

/**
 * Handle an unrecoverable 401: clear the session, surface a single notice, and send
 * the user back to the public homepage. Re-entrant calls (from concurrent 401s) are
 * collapsed into the first one until a fresh login resets the guard.
 */
async function handleSessionExpired(
  authStore: Awaited<ReturnType<typeof getAuthStore>>,
): Promise<void> {
  if (sessionExpiredHandled) {
    return;
  }
  sessionExpiredHandled = true;
  authStore.logoutLocal();
  notifyError('登录已过期，请重新登录。');
  const router = await getRouter();
  void router.push({ name: 'home' });
}

function runSingleFlightRefresh(
  authStore: Awaited<ReturnType<typeof getAuthStore>>,
): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = authStore
      .refreshSession()
      .catch(() => null)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

function isAuthEndpoint(url?: string): boolean {
  if (!url) {
    return false;
  }
  return AUTH_ENDPOINTS.some((path) => url.includes(path));
}

function notifyError(message: string): void {
  const now = Date.now();
  const last = recentMessages.get(message);
  if (last && now - last < 1500) {
    return;
  }
  recentMessages.set(message, now);
  ElMessage.error(message);
}

async function readErrorMessage(error: AxiosError<{ message?: string | string[] } | Blob>): Promise<string> {
  const data = error.response?.data;
  if (!data) {
    return error.message;
  }
  if (data instanceof Blob) {
    try {
      const text = await data.text();
      const json = JSON.parse(text) as { message?: string | string[] };
      return Array.isArray(json.message) ? json.message.join('；') : json.message || text;
    } catch {
      return '请求失败，请稍后重试。';
    }
  }
  if (typeof data === 'object' && data && 'message' in data) {
    const message = (data as { message?: string | string[] }).message;
    return Array.isArray(message) ? message.join('；') : message || '请求失败，请稍后重试。';
  }
  return '请求失败，请稍后重试。';
}

// Reset the session-expired guard after a successful login path navigates away.
export function resetSessionExpiredGuard(): void {
  sessionExpiredHandled = false;
}

/** Wire router lifecycle hooks once the app has created the router instance. */
export function bindHttpRouter(router: Router): void {
  router.afterEach((to) => {
    if (to.name === 'login' || to.name === 'home') {
      resetSessionExpiredGuard();
    }
  });
}
