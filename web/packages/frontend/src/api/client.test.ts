import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { configureClient, get, post, request, resetClientForTests } from './client'
import { createMemoryAdapter, makeSession } from '../contracts/adapters/memory'
import { checkUpdatesNow, fetchSession, fetchUpdatesCheck, renameSession } from './endpoints'
import { isApiError } from '../contracts/common'
import { resetAppRootForTests } from '../lib/appRoot'

function setBase(href: string) {
  document.querySelector('base')?.remove()
  const base = document.createElement('base')
  base.setAttribute('href', href)
  document.head.prepend(base)
}

beforeEach(() => {
  resetAppRootForTests()
  window.history.replaceState(null, '', '/')
  setBase('./')
  resetClientForTests()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('typed client against the in-memory adapter', () => {
  it('reads a session through the schema and renames it with the CSRF header', async () => {
    const adapter = createMemoryAdapter({ sessions: [makeSession({ session_id: 'abc', title: 'Old' })] })
    configureClient({ transport: adapter, csrfToken: 'csrf-test-token', authEnabled: true })
    const { session } = await fetchSession('abc')
    expect(session.title).toBe('Old')
    const renamed = await renameSession('abc', 'New')
    expect(renamed.session.title).toBe('New')
    const call = adapter.calls.at(-1)!
    expect(call.method).toBe('POST')
    expect(call.headers.get('X-Hermes-CSRF-Token')).toBe('csrf-test-token')
    expect(call.credentials).toBe('include')
  })

  it('reads update status with a passive GET and runs a manual check only via POST {force:true}', async () => {
    const adapter = createMemoryAdapter({ routes: { 'GET /api/updates/check': () => [200, { cached: true }], 'POST /api/updates/check': (_req, body) => [200, { cached: false, echoed: body }] } })
    configureClient({ transport: adapter, csrfToken: 'csrf-test-token' })
    await expect(fetchUpdatesCheck()).resolves.toMatchObject({ cached: true })
    const read = adapter.calls.at(-1)!
    expect(read.method).toBe('GET')
    expect(read.url.searchParams.has('force')).toBe(false)
    await expect(checkUpdatesNow()).resolves.toMatchObject({ cached: false, echoed: { force: true } })
    const check = adapter.calls.at(-1)!
    expect(check.method).toBe('POST')
    expect(JSON.parse(check.body as string)).toEqual({ force: true })
    await checkUpdatesNow('experimental')
    expect(JSON.parse(adapter.calls.at(-1)!.body as string)).toEqual({ force: true, channel: 'experimental' })
    expect(adapter.calls.filter((c) => c.url.pathname.endsWith('/api/updates/check'))).toHaveLength(3)
  })

  it('maps a 404 to a typed http error with the server message', async () => {
    configureClient({ transport: createMemoryAdapter() })
    await expect(fetchSession('missing')).rejects.toMatchObject({ kind: 'http', status: 404, message: 'Session not found' })
  })

  it('rejects malformed payloads instead of returning unchecked JSON', async () => {
    configureClient({ transport: createMemoryAdapter({ routes: { 'GET /api/settings': () => [200, { bot_name: 42 }] } }) })
    const err = await get('api/settings', z.object({ bot_name: z.string() })).catch((e: unknown) => e)
    expect(isApiError(err) && err.kind).toBe('invalid_payload')
  })

  it('does not add the CSRF header to the login route', async () => {
    const adapter = createMemoryAdapter({ routes: { 'POST /api/auth/login': () => [200, { ok: true }] } })
    configureClient({ transport: adapter, csrfToken: 'csrf-test-token' })
    await post('api/auth/login', { password: 'x' }, z.object({ ok: z.boolean() }), { retries: 0 })
    expect(adapter.calls.at(-1)!.headers.has('X-Hermes-CSRF-Token')).toBe(false)
  })

  it('coalesces identical in-flight GETs and separates them across a mutation', async () => {
    const adapter = createMemoryAdapter()
    configureClient({ transport: adapter, csrfToken: 'csrf-test-token' })
    await Promise.all([fetchSession('sess-1'), fetchSession('sess-1')])
    expect(adapter.calls.filter((c) => c.url.pathname.endsWith('/api/session')).length).toBe(1)
    await renameSession('sess-1', 'Changed')
    await fetchSession('sess-1')
    expect(adapter.calls.filter((c) => c.url.pathname.endsWith('/api/session')).length).toBe(2)
  })

  it('redirects once to login on 401 when auth is enabled', async () => {
    const onUnauthorized = vi.fn()
    configureClient({ transport: createMemoryAdapter({ routes: { 'GET /api/settings': () => [401, { error: 'Authentication required' }] } }), authEnabled: true, onUnauthorized })
    window.history.replaceState(null, '', '/settings?x=1')
    await expect(get('api/settings', z.any())).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(onUnauthorized).toHaveBeenCalledWith('/settings?x=1')
  })

  it('does not redirect on 401 when auth is disabled or opted out', async () => {
    const onUnauthorized = vi.fn()
    configureClient({ transport: createMemoryAdapter({ routes: { 'GET /api/settings': () => [401, { error: 'nope' }] } }), authEnabled: false, onUnauthorized })
    await expect(get('api/settings', z.any())).rejects.toMatchObject({ kind: 'http', status: 401 })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('retries network failures for idempotent requests and gives up after the budget', async () => {
    let attempts = 0
    configureClient({ transport: () => { attempts += 1; return Promise.reject(new TypeError('Failed to fetch')) } })
    await expect(request('api/settings', { schema: z.any(), retries: 2, retryDelayMs: 0 })).rejects.toMatchObject({ kind: 'network' })
    expect(attempts).toBe(3)
  })

  it('retries only the listed statuses', async () => {
    let attempts = 0
    configureClient({ transport: () => { attempts += 1; return Promise.resolve(new Response('{"error":"busy"}', { status: 503 })) } })
    await expect(request('api/settings', { schema: z.any(), retries: 1, retryDelayMs: 0, retryStatuses: [503] })).rejects.toMatchObject({ status: 503 })
    expect(attempts).toBe(2)
  })

  it('resolves paths under a subpath mount', async () => {
    resetAppRootForTests()
    window.history.replaceState(null, '', '/mount/session/x')
    setBase('../')
    const adapter = createMemoryAdapter()
    configureClient({ transport: adapter })
    await fetchSession('sess-1')
    expect(adapter.calls[0]!.url.pathname).toBe('/mount/api/session')
  })

  it('honours an external abort signal', async () => {
    configureClient({ transport: (req) => new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')))) })
    const controller = new AbortController()
    const p = request('api/settings', { schema: z.any(), signal: controller.signal })
    controller.abort()
    await expect(p).rejects.toMatchObject({ kind: 'aborted' })
  })
})
