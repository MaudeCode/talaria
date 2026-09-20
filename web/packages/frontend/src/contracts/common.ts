import { z } from 'zod'

/** Unix seconds as the Python server emits them (float). */
export const UnixSeconds = z.number()
export const NullableString = z.string().nullable()
export const NullableNumber = z.number().nullable()
export const OptionalBool = z.boolean().optional()

/** Server error body: `{ error, code?, ... }`. Kept loose so route-specific fields survive. */
export const ErrorBodySchema = z.looseObject({
  error: z.string(),
  code: z.string().optional(),
})
export type ErrorBody = z.infer<typeof ErrorBodySchema>

/** `{ ok: true }`-style acknowledgements. */
export const OkSchema = z.looseObject({ ok: z.boolean().optional() })

/** Every normalized failure the typed client can produce. */
export type ApiErrorKind = 'http' | 'network' | 'timeout' | 'aborted' | 'invalid_payload' | 'unauthorized'

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status: number
  readonly code: string | undefined
  readonly body: unknown
  readonly path: string
  readonly retryable: boolean

  constructor(init: { kind: ApiErrorKind; status?: number | undefined; code?: string | undefined; body?: unknown; path: string; message: string; retryable?: boolean | undefined; cause?: unknown }) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined)
    this.name = 'ApiError'
    this.kind = init.kind
    this.status = init.status ?? 0
    this.code = init.code
    this.body = init.body
    this.path = init.path
    this.retryable = init.retryable ?? (init.kind === 'network' || init.kind === 'timeout')
  }

  static from(error: unknown, path = ''): ApiError {
    if (error instanceof ApiError) return error
    if (error instanceof DOMException && error.name === 'AbortError') return new ApiError({ kind: 'aborted', path, message: 'Request aborted', retryable: false })
    return new ApiError({ kind: 'network', path, message: error instanceof Error ? error.message : 'Network error', cause: error })
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError
}

/** Parse a server body with a schema; wrap failure as a typed `invalid_payload` error (never a blank UI). */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  throw new ApiError({ kind: 'invalid_payload', path, message: `Malformed payload from ${path}: ${z.prettifyError(result.error)}`, body: value, retryable: false })
}
