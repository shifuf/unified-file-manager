import { AsyncLocalStorage } from 'node:async_hooks';

type RequestContextStore = {
  /** Scheme + host from the current HTTP request (e.g. http://1.2.3.4:60558). */
  publicBaseUrl?: string;
};

const storage = new AsyncLocalStorage<RequestContextStore>();

/** Run work with a request-scoped public base URL (middleware). */
export function runWithRequestContext<T>(ctx: RequestContextStore, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Public base captured for the active request, if any. */
export function getRequestPublicBaseUrl(): string | undefined {
  return storage.getStore()?.publicBaseUrl;
}
