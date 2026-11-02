import { ErrorCode, type ErrorCodeValue } from './error-codes'

/** 后端统一错误体：{ error: { code, message, details, requestId } } */
export interface ApiErrorPayload {
  code: string
  message: string
  details?: Record<string, unknown> | null
  requestId?: string | null
}

/** 前端统一异常：所有 API 调用失败都抛这个，UI 层只认它。 */
export class UfmError extends Error {
  readonly code: ErrorCodeValue | string
  readonly status: number
  readonly details: Record<string, unknown> | null
  readonly requestId: string | null

  constructor(init: {
    code: ErrorCodeValue | string
    message: string
    status?: number
    details?: Record<string, unknown> | null
    requestId?: string | null
  }) {
    super(init.message)
    this.name = 'UfmError'
    this.code = init.code
    this.status = init.status ?? 0
    this.details = init.details ?? null
    this.requestId = init.requestId ?? null
  }

  /** 是否属于「重新登录可解」的错误 */
  get isAuthError(): boolean {
    return (
      this.code === ErrorCode.UNAUTHORIZED ||
      this.code === ErrorCode.TOKEN_EXPIRED ||
      this.code === ErrorCode.TOKEN_INVALID
    )
  }

  /** 字段级校验明细（若有） */
  get fieldErrors(): Record<string, string> {
    const fields = this.details?.fields
    if (fields && typeof fields === 'object') {
      return fields as Record<string, string>
    }
    return {}
  }
}

/** 把任意异常/响应体归一成 UfmError。 */
export function toUfmError(input: unknown): UfmError {
  if (input instanceof UfmError) return input

  // 已经是 { error: {...} } 结构
  const maybe = input as { error?: ApiErrorPayload } | undefined
  if (maybe?.error && typeof maybe.error === 'object') {
    const e = maybe.error
    return new UfmError({
      code: e.code || ErrorCode.UNKNOWN_ERROR,
      message: e.message || '请求失败',
      details: e.details ?? null,
      requestId: e.requestId ?? null,
    })
  }

  if (input instanceof Error) {
    return new UfmError({
      code: ErrorCode.UNKNOWN_ERROR,
      message: input.message,
    })
  }

  return new UfmError({
    code: ErrorCode.UNKNOWN_ERROR,
    message: '未知错误',
  })
}
