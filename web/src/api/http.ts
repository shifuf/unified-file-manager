import { ofetch, type FetchOptions } from 'ofetch'
import { ErrorCode } from './error-codes'
import { UfmError, toUfmError } from './error'

/**
 * 统一 HTTP 客户端。
 *
 * 约定：
 * - 401 只做一次静默刷新 + 重放（阶段 3 接入真实 refresh 接口）；
 * - 失败一律抛 UfmError，UI 层集中 toast；
 * - 携带 X-Request-Id 便于和后端日志对账。
 */
const baseURL = import.meta.env.VITE_UFM_API_BASE ?? '/api'

let refreshHandler: (() => Promise<boolean>) | null = null
let accessToken: (() => string) = () => ''

export function registerAccessToken(handler: () => string) { accessToken = handler }

/** 由 auth store 在启动时注册刷新逻辑，避免 HTTP 层依赖 Pinia。 */
export function registerRefreshHandler(handler: () => Promise<boolean>) {
  refreshHandler = handler
}

const client = ofetch.create({
  baseURL,
  credentials: 'include',
  retry: 0,
  timeout: 30_000,
  onRequest({ options }) {
    const token = accessToken()
    if (token) options.headers.set('Authorization', `Bearer ${token}`)
  },
})

async function request<T>(path: string, options: FetchOptions<'json'> = {}): Promise<T> {
  try {
    return await client<T>(path, options)
  } catch (raw) {
    const err = normalizeFetchError(raw)

    // 401 静默刷新一次并重放
    if (err.status === 401 && refreshHandler && !(options as { _retried?: boolean })._retried) {
      const refreshed = await refreshHandler().catch(() => false)
      if (refreshed) {
        return await client<T>(path, { ...options, _retried: true } as FetchOptions<'json'>)
      }
    }
    throw err
  }
}

function normalizeFetchError(raw: unknown): UfmError {
  const err = raw as {
    status?: number
    statusCode?: number
    data?: unknown
    response?: { status?: number; _data?: unknown }
    message?: string
  }

  const status = err?.response?.status ?? err?.status ?? err?.statusCode ?? 0
  const body = err?.response?._data ?? err?.data

  if (body && typeof body === 'object' && 'error' in (body as Record<string, unknown>)) {
    const ufm = toUfmError(body)
    const messages: Partial<Record<string, string>> = {
      STORAGE_PATH_INVALID: '存储路径不存在或当前用户没有写入权限，请确认后重试',
    }
    return new UfmError({
      code: ufm.code,
      message: messages[ufm.code] ?? ufm.message,
      status,
      details: ufm.details,
      requestId: ufm.requestId,
    })
  }

  if (!status) {
    return new UfmError({
      code: ErrorCode.NETWORK_ERROR,
      message: '网络异常，请检查连接后重试',
      status: 0,
    })
  }

  return new UfmError({
    code: status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.UNKNOWN_ERROR,
    message: err?.message ?? `请求失败（HTTP ${status}）`,
    status,
  })
}

export const http = {
  get: <T>(path: string, options?: FetchOptions<'json'>) => request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: Record<string, unknown> | BodyInit | null, options?: FetchOptions<'json'>) =>
    request<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: Record<string, unknown> | BodyInit | null, options?: FetchOptions<'json'>) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  put: <T>(path: string, body?: Record<string, unknown> | BodyInit | null, options?: FetchOptions<'json'>) =>
    request<T>(path, { ...options, method: 'PUT', body }),
  delete: <T>(path: string, options?: FetchOptions<'json'>) =>
    request<T>(path, { ...options, method: 'DELETE' }),
  /** 二进制下载（项目导出包等）；同样静默刷新一次 401。 */
  blob: async (path: string): Promise<Blob> => {
    const options = { method: 'GET', responseType: 'blob' } as unknown as FetchOptions<'json'>
    try {
      return (await client(path, options)) as unknown as Blob
    } catch (raw) {
      const err = normalizeFetchError(raw)
      if (err.status === 401 && refreshHandler) {
        const refreshed = await refreshHandler().catch(() => false)
        if (refreshed) return (await client(path, options)) as unknown as Blob
      }
      throw err
    }
  },
}
