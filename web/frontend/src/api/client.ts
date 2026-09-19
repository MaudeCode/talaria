/**
 * The single typed same-origin HTTP client (HWEB-100).
 *
 * Every request in the application goes through `request()`. It owns:
 * - URL resolution against the frozen app root (subpath mounts);
 * - the CSRF header on same-origin unsafe methods, except login and CSP report;
 * - coalescing of identical in-flight idempotent requests (legacy HWEB-43);
 * - the legacy retry policy (network errors, optional statuses);
 * - one-shot redirect to `/login?next=` on 401 when auth is enabled;
 * - schema validation of every JSON body (typed values out, never raw JSON).
 *
 * Tests and the in-memory contract adapters inject a `Transport`; production
 * uses `fetch`. ESLint forbids `fetch` anywhere else.
 */
import type { ZodType } from 'zod'
import { ApiError, ErrorBodySchema, parseOrThrow } from '../contracts/common'
import { appRoot, appUrl } from '../lib/appRoot'

export interface TransportRequest {
  url: URL
  method: string
  headers: Headers
  body?: BodyInit | null
  signal?: AbortSignal
  credentials: RequestCredentials
  keepalive?: boolean
}
export type Transport = (req: TransportRequest) => Promise<Response>

export interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  schema: ZodType<T>
  json?: unknown
  body?: BodyInit
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  retries?: number
  retryStatuses?: number[]
  retryDelayMs?: number
  redirect401?: boolean
  dedupe?: boolean
  keepalive?: boolean
}

interface ClientState {
  transport: Transport
  csrfToken: string
  authEnabled: boolean
  mutationSeq: number
  inflight: Map<string, Promise<unknown>>
  onUnauthorized: (next: string) => void
}

const CSRF_EXEMPT = /\/api\/(auth\/login|csp-report)$/
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const state: ClientState = {
  transport: (req) => {
    const init: RequestInit = { method: req.method, headers: req.headers, body: req.body ?? null, credentials: req.credentials, keepalive: req.keepalive ?? false }
    if (req.signal) init.signal = req.signal
    return fetch(req.url, init)
  },
  csrfToken: '',
  authEnabled: false,
  mutationSeq: 0,
  inflight: new Map(),
  onUnauthorized: (next) => {
    window.location.assign(appUrl(`login?next=${encodeURIComponent(next)}`).href)
  },
}

export function configureClient(opts: Partial<Pick<ClientState, 'transport' | 'csrfToken' | 'authEnabled' | 'onUnauthorized'>>): void {
  Object.assign(state, opts)
}

export function resetClientForTests(): void {
  state.transport = () => Promise.reject(new Error('no transport configured'))
  state.csrfToken = ''
  state.authEnabled = false
  state.mutationSeq = 0
  state.inflight.clear()
  state.onUnauthorized = () => undefined
}

export function csrfToken(): string {
  return state.csrfToken
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('aborted', 'AbortError'))
    }, { once: true })
  })
}

/** Path within the app: `api/sessions` or `/api/sessions` (leading slash is app-relative, not host-absolute). */
export function resolveApiUrl(path: string): URL {
  return appUrl(path)
}

function currentAppPath(): string {
  const root = appRoot().pathname.replace(/\/$/, '')
  const p = window.location.pathname + window.location.search
  return p.startsWith(root) ? p.slice(root.length) || '/' : p
}

export async function request<T>(path: string, opts: RequestOptions<T>): Promise<T> {
  const method = (opts.method ?? 'GET').toUpperCase()
  const url = resolveApiUrl(path)
  const idempotent = method === 'GET' || method === 'HEAD'
  const dedupeKey = idempotent && opts.dedupe !== false && !opts.signal ? `${method} ${url.href} @${state.mutationSeq} ${JSON.stringify({ t: opts.timeoutMs, r: opts.retries, s: opts.retryStatuses })}` : null
  if (dedupeKey) {
    const existing = state.inflight.get(dedupeKey) as Promise<T> | undefined
    if (existing) return existing
    const started = request(path, { ...opts, dedupe: false })
    state.inflight.set(dedupeKey, started)
    const clear = () => {
      if (state.inflight.get(dedupeKey) === started) state.inflight.delete(dedupeKey)
    }
    started.then(clear, clear)
    return started
  }
  if (!idempotent) state.mutationSeq += 1

  const timeoutMs = opts.timeoutMs ?? 30_000
  const maxAttempts = (opts.retries ?? 2) + 1
  const retryStatuses = new Set(opts.retryStatuses ?? [])
  const retryDelayMs = opts.retryDelayMs ?? 350

  let lastError: ApiError | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    const onOuterAbort = () => controller.abort()
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true })
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs) : null
    try {
      const headers = new Headers(opts.headers)
      let body: BodyInit | null = null
      if (opts.json !== undefined) {
        headers.set('Content-Type', 'application/json')
        body = JSON.stringify(opts.json)
      } else if (opts.body !== undefined) {
        body = opts.body
      }
      if (UNSAFE.has(method) && url.origin === window.location.origin && !CSRF_EXEMPT.test(url.pathname) && state.csrfToken && !headers.has('X-Hermes-CSRF-Token')) {
        headers.set('X-Hermes-CSRF-Token', state.csrfToken)
      }
      const response = await state.transport({ url, method, headers, body, signal: controller.signal, credentials: 'include', keepalive: opts.keepalive ?? false })
      if (response.status === 401 && state.authEnabled && opts.redirect401 !== false) {
        state.onUnauthorized(currentAppPath())
        throw new ApiError({ kind: 'unauthorized', status: 401, path, message: 'Authentication required', retryable: false })
      }
      const text = await response.text()
      let parsed: unknown = null
      if (text !== '') {
        try {
          parsed = JSON.parse(text)
        } catch {
          if (response.ok) throw new ApiError({ kind: 'invalid_payload', status: response.status, path, message: `Non-JSON response from ${path}`, body: text, retryable: false })
          parsed = { error: text.slice(0, 500) }
        }
      }
      if (!response.ok) {
        const errBody = ErrorBodySchema.safeParse(parsed)
        const err = new ApiError({
          kind: 'http',
          status: response.status,
          code: errBody.success ? errBody.data.code : undefined,
          body: parsed,
          path,
          message: errBody.success ? errBody.data.error : `HTTP ${response.status} from ${path}`,
          retryable: retryStatuses.has(response.status),
        })
        if (err.retryable && attempt < maxAttempts) {
          lastError = err
          await sleep(retryDelayMs, opts.signal)
          continue
        }
        throw err
      }
      return parseOrThrow(opts.schema, parsed, path)
    } catch (error) {
      const apiError = ApiError.from(error, path)
      if (apiError.kind === 'aborted' && opts.signal?.aborted) throw apiError
      if (apiError.kind === 'aborted' && controller.signal.reason instanceof DOMException && controller.signal.reason.name === 'TimeoutError') {
        lastError = new ApiError({ kind: 'timeout', path, message: `Request to ${path} timed out`, retryable: true })
      } else {
        lastError = apiError
      }
      if (!lastError.retryable || attempt >= maxAttempts || !idempotent && lastError.kind === 'timeout') throw lastError
      await sleep(retryDelayMs, opts.signal)
    } finally {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onOuterAbort)
    }
  }
  throw lastError ?? new ApiError({ kind: 'network', path, message: 'Request failed' })
}

export function get<T>(path: string, schema: ZodType<T>, opts: Omit<RequestOptions<T>, 'schema' | 'method' | 'json'> = {}): Promise<T> {
  return request(path, { ...opts, method: 'GET', schema })
}

export function post<T>(path: string, json: unknown, schema: ZodType<T>, opts: Omit<RequestOptions<T>, 'schema' | 'method' | 'json'> = {}): Promise<T> {
  return request(path, { ...opts, method: 'POST', json, schema })
}

/** Upload multipart form data (attachments, workspace uploads). */
export function postForm<T>(path: string, form: FormData, schema: ZodType<T>, opts: Omit<RequestOptions<T>, 'schema' | 'method' | 'json' | 'body'> = {}): Promise<T> {
  return request(path, { ...opts, method: 'POST', body: form, schema, retries: opts.retries ?? 0 })
}

/** Fire-and-forget beacon-style POST used on pagehide (presence, drafts). */
export function beacon(path: string, json: unknown): void {
  void request(path, { method: 'POST', json, schema: { safeParse: () => ({ success: true, data: undefined }) } as unknown as ZodType<undefined>, retries: 0, timeoutMs: 4000, keepalive: true, redirect401: false }).catch(() => undefined)
}
