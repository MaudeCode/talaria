import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { configureClient, get, post, request, resetClientForTests, type TransportRequest } from './client'
import { createMemoryAdapter, makeSession } from '../contracts/adapters/memory'
import { checkUpdatesNow, fetchAnchorScene, fetchToolResult, fetchSessions, searchSessions, fetchSession, fetchUpdatesCheck, renameSession, setReasoningEffort, startChat, newSession, saveSettings, setAuxiliaryModel, switchKanbanBoard } from './endpoints'
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

  it('preserves the absent body on a typed Kanban board switch', async () => {
    const adapter = createMemoryAdapter({ routes: { 'POST /api/kanban/boards/ops/switch': () => [200, { current: 'ops', read_only: false }] } })
    configureClient({ transport: adapter })
    await switchKanbanBoard('ops')
    expect(adapter.calls.at(-1)?.body).toBeNull()
    expect(adapter.calls.at(-1)?.headers.has('content-type')).toBe(false)
  })

  it('keeps the ordinary new-chat deadline and never replays an unknown create outcome', async () => {
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const transport = vi.fn((req: TransportRequest) => new Promise<Response>((_resolve, reject) => {
      expect(req.method).toBe('POST')
      expect(req.url.pathname).toBe('/api/session/new')
      req.signal!.addEventListener('abort', () => { reject(new DOMException('Deadline exceeded', 'TimeoutError')) }, { once: true })
      entered()
    }))
    configureClient({ transport })
    try {
      const result = newSession({}).catch((error: unknown) => error)
      await started
      expect(timeout).toHaveBeenCalledWith(30_000)
      deadline.abort(new DOMException('Deadline exceeded', 'TimeoutError'))
      expect(await result).toMatchObject({ kind: 'network', path: 'api/session/new', cause: { name: 'TimeoutError' } })
      expect(transport).toHaveBeenCalledTimes(1)
    } finally { timeout.mockRestore() }
  })

  it('advertises the secure skill prompt at the shared Web chat-start boundary', async () => {
    const adapter = createMemoryAdapter({ routes: { 'POST /api/chat/start': () => [200, { session_id: 'abc', stream_id: 'stream' }] } })
    configureClient({ transport: adapter })
    await startChat({ session_id: 'abc', message: 'Set up the skill' })
    expect(JSON.parse(adapter.calls.at(-1)!.body as string)).toMatchObject({ session_id: 'abc', skill_secret: true, connect_card: true })
  })

  it('keeps chat reasoning identity for effort and reset while allowing explicit profile edits', async () => {
    const adapter = createMemoryAdapter({ routes: { 'POST /api/reasoning': () => [200, { show_reasoning: false, reasoning_effort: 'low' }] } })
    configureClient({ transport: adapter })
    for (const effort of ['high', '']) {
      await setReasoningEffort(effort, 'model', 'provider', 'current-chat')
      expect(JSON.parse(adapter.calls.at(-1)!.body as string)).toEqual({ effort, model: 'model', provider: 'provider', session_id: 'current-chat' })
    }
    await setReasoningEffort('low')
    expect(JSON.parse(adapter.calls.at(-1)!.body as string)).toEqual({ effort: 'low' })
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

  it('renders the server recovery reason on a refused send while preserving its envelope', async () => {
    const body = { error: 'Agent updated successfully', type: 'agent_runtime_stale', agent_runtime_reason: 'recovery_incomplete', agent_update_state: 'incomplete', retryable: true, restart_scheduled: false }
    configureClient({ transport: createMemoryAdapter({ routes: { 'POST /api/chat/start': () => [409, body] } }) })
    await expect(post('api/chat/start', {}, z.unknown())).rejects.toMatchObject({ message: 'Agent update recovery is incomplete', body })
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

  it('coalesced followers get the same typed outcome as the leader (error envelope and 401 redirect)', async () => {
    configureClient({ transport: createMemoryAdapter() })
    const [leader, follower] = await Promise.allSettled([fetchSession('missing'), fetchSession('missing')])
    expect(leader.status).toBe('rejected')
    expect(follower.status).toBe('rejected')
    for (const outcome of [leader, follower]) expect(isApiError((outcome as PromiseRejectedResult).reason) && (outcome as PromiseRejectedResult).reason.message).toBe('Session not found')
    const onUnauthorized = vi.fn()
    resetClientForTests()
    configureClient({ transport: createMemoryAdapter({ routes: { 'GET /api/session': () => [401, { error: 'Authentication required' }] } }), authEnabled: true, onUnauthorized })
    const results = await Promise.allSettled([fetchSession('sess-1'), fetchSession('sess-1')])
    for (const outcome of results) expect(isApiError((outcome as PromiseRejectedResult).reason) && (outcome as PromiseRejectedResult).reason.kind).toBe('unauthorized')
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('a failed passkey login or logout never bounces to /login', async () => {
    const onUnauthorized = vi.fn()
    configureClient({ transport: createMemoryAdapter({ routes: { 'POST /api/auth/passkey/login': () => [401, { error: 'Invalid passkey assertion' }], 'POST /api/auth/passkey/options': () => [401, { error: 'no passkeys' }], 'POST /api/auth/logout': () => [401, { error: 'Authentication required' }] } }), authEnabled: true, onUnauthorized })
    window.history.replaceState(null, '', '/settings')
    await expect(post('api/auth/passkey/login', { id: 'x' }, z.any(), { retries: 0 })).rejects.toMatchObject({ kind: 'http', status: 401, message: 'Invalid passkey assertion' })
    await expect(post('api/auth/passkey/options', {}, z.any(), { retries: 0 })).rejects.toMatchObject({ kind: 'http', status: 401 })
    await expect(post('api/auth/logout', {}, z.any(), { retries: 0 })).rejects.toMatchObject({ kind: 'http', status: 401 })
    expect(onUnauthorized).not.toHaveBeenCalled()
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


interface HeldRead { signal: AbortSignal | undefined; resolve: (response: Response) => void; reject: (error: Error) => void }
// Every caller-cancellable contract read: session reads plus the tool-result and worklog-page reads behind ToolCard and TurnActivityView.
const signaledReads: Record<string, { read: (signal: AbortSignal) => Promise<unknown>; body: unknown; expected: Record<string, unknown> }> = {
  detail: { read: (signal) => fetchSession('replacement', {}, signal), body: { session: makeSession({ session_id: 'replacement', title: 'Replacement' }) }, expected: { session: { title: 'Replacement' } } },
  list: { read: (signal) => fetchSessions({}, signal), body: { sessions: [] }, expected: { sessions: [] } },
  search: { read: (signal) => searchSessions('query', { project_id: undefined, sidebar_source: undefined, include_archived: false }, 5, signal), body: { sessions: [] }, expected: { sessions: [] } },
  'tool-result': { read: (signal) => fetchToolResult('sess-1', 'call-1', signal), body: { tool_call_id: 'call-1', result: 'full output', result_view: { stdout: 'full output' } }, expected: { result: 'full output' } },
  'worklog page': { read: (signal) => fetchAnchorScene('sess-1', 'msg-ref', 3, 40, signal), body: { scene_ref: 'scene-1', rows: [], start: 0, end: 0, total: 0, complete: true }, expected: { scene_ref: 'scene-1' } },
}

function holdTransport(): HeldRead[] {
  const pending: HeldRead[] = []
  configureClient({ transport: (req) => new Promise((resolve, reject) => { pending.push({ signal: req.signal, resolve, reject }) }) })
  return pending
}

for (const [endpoint, { read, body, expected }] of Object.entries(signaledReads)) {
  it(`forwards cancellation through the ${endpoint} endpoint to the transport`, async () => {
    const pending = holdTransport()
    const controller = new AbortController()
    const call = read(controller.signal).catch((error: unknown) => error)
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    controller.abort()
    expect(pending[0]!.signal!.aborted).toBe(true)
    pending[0]!.reject(new DOMException('aborted', 'AbortError'))
    await expect(call).resolves.toMatchObject({ kind: 'aborted' })
  })

  it(`starts an independent replacement ${endpoint} read before the old abort settles`, async () => {
    const pending = holdTransport()
    const oldController = new AbortController()
    const replacementController = new AbortController()
    const old = read(oldController.signal).catch((error: unknown) => error)
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    oldController.abort()
    const replacement = read(replacementController.signal).catch((error: unknown) => error)
    try {
      await vi.waitFor(() => expect(pending).toHaveLength(2))
      expect(pending[0]!.signal?.aborted).toBe(true)
      expect(pending[1]!.signal?.aborted).toBe(false)
      pending[0]!.reject(new DOMException('old read aborted', 'AbortError'))
      pending[1]!.resolve(Response.json(body))
      await expect(old).resolves.toMatchObject({ kind: 'aborted' })
      await expect(replacement).resolves.toMatchObject(expected)
    } finally {
      for (const request of pending) request.reject(new DOMException('test cleanup', 'AbortError'))
      await Promise.all([old, replacement])
    }
  })

  it(`lets concurrent ${endpoint} readers cancel only themselves`, async () => {
    const pending = holdTransport()
    const leader = new AbortController()
    const follower = new AbortController()
    const first = read(leader.signal).catch((error: unknown) => error)
    const second = read(follower.signal).catch((error: unknown) => error)
    try {
      await vi.waitFor(() => expect(pending).toHaveLength(2))
      // The aborted follower rejects on its own transport while the leader's read is still held.
      follower.abort()
      pending[1]!.reject(new DOMException('follower aborted', 'AbortError'))
      await expect(second).resolves.toMatchObject({ kind: 'aborted' })
      expect(pending[0]!.signal?.aborted).toBe(false)
      pending[0]!.resolve(Response.json(body))
      await expect(first).resolves.toMatchObject(expected)
    } finally {
      for (const request of pending) request.reject(new DOMException('test cleanup', 'AbortError'))
      await Promise.all([first, second])
    }
  })

  it(`rejects an already-aborted ${endpoint} read without a transport call`, async () => {
    const transport = vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError')))
    configureClient({ transport })
    const controller = new AbortController()
    controller.abort()
    await expect(read(controller.signal)).rejects.toMatchObject({ kind: 'aborted' })
    expect(transport).not.toHaveBeenCalled()
  })
}


it('propagates managed config conflicts without retrying or requesting re-login', async () => {
  const message = 'config.yaml is package-managed. Update the declarative configuration instead.'
  const body = { error: message, condition: 'config_write_refused' }
  const adapter = createMemoryAdapter({ routes: {
    'POST /api/settings': () => [409, body],
    'POST /api/model/set': () => [409, body],
  } })
  const onUnauthorized = vi.fn()
  configureClient({ transport: adapter, authEnabled: true, onUnauthorized })
  await expect(saveSettings({ max_tokens: 1234 })).rejects.toMatchObject({ kind: 'http', status: 409, message, body, retryable: false })
  await expect(setAuxiliaryModel('delegation', 'claude-opus-4-7', 'anthropic')).rejects.toMatchObject({ kind: 'http', status: 409, message, body, retryable: false })
  expect(adapter.calls).toHaveLength(2)
  expect(onUnauthorized).not.toHaveBeenCalled()
})
