import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import type { QueryClient } from '@tanstack/react-query'
import { createQueryClient } from '../../api/queryClient'
import { configureClient, get, resetClientForTests } from '../../api/client'
import { createMemoryAdapter, DEFAULT_BOOTSTRAP, makeSession } from '../../contracts/adapters/memory'
import { ProjectsSchema } from '../../contracts'
import { BootstrapContext, setBootstrapForTests } from '../../app/bootstrap'
import { readPersisted, removePersistedByPrefix, writePersisted } from '../../lib/persisted'
import { z } from 'zod'
import { useLogout } from './useLogout'
import { LoginPage } from './LoginPage'

const snapshotKey = 'hermes-boot:queries'
const projectKey = ['projects']
const projects = (name: string) => ProjectsSchema.parse({ projects: [{ project_id: name, name }], active_profile: 'default', all_profiles: false, other_profile_count: 0 })
const clients: QueryClient[] = []
let listeners: [string, EventListenerOrEventListenerObject][]
let assign: ReturnType<typeof vi.fn>

function client(factory = createQueryClient) {
  const qc = factory()
  clients.push(qc)
  return qc
}

function seed(qc: QueryClient, name = 'Previous identity') {
  writePersisted('hermes-webui-session', 'previous-session')
  qc.setQueryData(projectKey, projects(name))
  qc.setQueryData(['sessions', 'detail', 'previous-session'], { session: makeSession({ session_id: 'previous-session' }) })
  window.dispatchEvent(new Event('pagehide'))
  expect(readPersisted(snapshotKey)).toContain(name)
}

async function logout() {
  const hook = renderHook(useLogout)
  await act(() => hook.result.current())
  hook.unmount()
}

beforeEach(() => {
  vi.useFakeTimers()
  listeners = []
  const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === 'pagehide' || type === 'storage') listeners.push([type, listener])
    add(type, listener, options)
  })
  assign = vi.fn()
  vi.stubGlobal('location', { href: window.location.href, origin: window.location.origin, pathname: '/', search: '', assign })
  resetClientForTests()
  configureClient({ transport: createMemoryAdapter({ routes: { 'POST /api/auth/logout': () => [200, { ok: true }], 'POST /api/auth/login': () => [200, { ok: true }] } }) })
})

afterEach(() => {
  for (const qc of clients.splice(0)) qc.clear()
  for (const [type, listener] of listeners) window.removeEventListener(type, listener)
  removePersistedByPrefix('hermes-boot')
  removePersistedByPrefix('hermes-webui-session')
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('identity-owned boot snapshots', () => {
  it('does not restore previous project or session data after logout and pagehide', async () => {
    const qc = client()
    seed(qc)
    await logout()
    expect(assign).toHaveBeenCalledTimes(1)
    expect(readPersisted(snapshotKey)).toBeNull()
    window.dispatchEvent(new Event('pagehide'))
    expect(readPersisted(snapshotKey)).toBeNull()
    expect(qc.getQueryCache().getAll()).toHaveLength(0)
    const next = client()
    expect(next.getQueryData(projectKey)).toBeUndefined()
    expect(next.getQueryData(['sessions', 'detail', 'previous-session'])).toBeUndefined()
  })

  it('cancels pending persistence and fences late old-query successes', async () => {
    const qc = client()
    qc.setQueryData(projectKey, projects('Queued previous identity'))
    let resolve!: (value: ReturnType<typeof projects>) => void
    const pending = qc.query({ queryKey: ['projects', 'late'], queryFn: () => new Promise<ReturnType<typeof projects>>((done) => { resolve = done }) }).catch(() => undefined)
    await logout()
    resolve(projects('Late previous identity'))
    await pending
    // A stale stream callback can still reach the retired client.
    qc.setQueryData(projectKey, projects('Late cache write'))
    await vi.advanceTimersByTimeAsync(500)
    expect(readPersisted(snapshotKey)).toBeNull()
  })

  it('prevents a separate old client from overwriting the next identity without a storage event', async () => {
    vi.resetModules()
    const oldModule = await import('../../api/queryClient')
    const old = client(oldModule.createQueryClient)
    seed(old)
    const oldPagehide = listeners.filter(([type]) => type === 'pagehide').at(-1)![1]
    await logout()
    const next = client()
    next.setQueryData(projectKey, projects('New identity'))
    await vi.advanceTimersByTimeAsync(500)
    const saved = readPersisted(snapshotKey)
    expect(saved).toContain('New identity')
    if (typeof oldPagehide === 'function') oldPagehide(new Event('pagehide'))
    else oldPagehide.handleEvent(new Event('pagehide'))
    expect(readPersisted(snapshotKey)).toBe(saved)
    expect(old.getQueryCache().getAll()).toHaveLength(0)
  })

  it('refuses a stale generation even if its snapshot reappears after reset', async () => {
    seed(client())
    const stale = readPersisted(snapshotKey)!
    await logout()
    writePersisted(snapshotKey, stale)
    expect(client().getQueryData(projectKey)).toBeUndefined()
  })

  it('retains validated same-identity offline hydration', () => {
    seed(client())
    expect(client().getQueryData(projectKey)).toEqual(projects('Previous identity'))
    expect(client().getQueryData(['sessions', 'detail', 'previous-session'])).toMatchObject({ session: { session_id: 'previous-session' } })
  })

  it('retires old caches on a cross-tab storage event', () => {
    const qc = client()
    seed(qc)
    writePersisted('hermes-boot-generation', 'another-tab-generation')
    window.dispatchEvent(new StorageEvent('storage', { key: 'hermes-boot-generation' }))
    expect(qc.getQueryCache().getAll()).toHaveLength(0)
    const saved = readPersisted(snapshotKey)
    qc.setQueryData(projectKey, projects('Retired tab'))
    window.dispatchEvent(new Event('pagehide'))
    expect(readPersisted(snapshotKey)).toBe(saved)
  })

  it('preserves legacy offline hydration before a reset and rejects it after one', async () => {
    seed(client())
    const legacy = JSON.parse(readPersisted(snapshotKey)!)
    delete legacy.generation
    writePersisted(snapshotKey, JSON.stringify(legacy))
    expect(client().getQueryData(projectKey)).toEqual(projects('Previous identity'))
    await logout()
    writePersisted(snapshotKey, JSON.stringify(legacy))
    expect(client().getQueryData(projectKey)).toBeUndefined()
  })

  it('retains schema validation of cached project data', () => {
    seed(client())
    const invalid = JSON.parse(readPersisted(snapshotKey)!)
    invalid.queries[0].state.data = { projects: [{ project_id: 42 }] }
    writePersisted(snapshotKey, JSON.stringify(invalid))
    expect(client().getQueryData(projectKey)).toBeUndefined()
  })

  it('persists the reset generation when clearing the snapshot frees storage quota', async () => {
    vi.resetModules()
    const oldModule = await import('../../api/queryClient')
    const old = client(oldModule.createQueryClient)
    seed(old)
    const setItem = Storage.prototype.setItem.bind(window.localStorage)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === 'hermes-boot-generation' && this.getItem(snapshotKey)) throw new DOMException('Full', 'QuotaExceededError')
      setItem(key, value)
    })
    await logout()
    expect(window.localStorage.getItem('hermes-boot-generation')).not.toBeNull()
    old.setQueryData(projectKey, projects('Previous identity'))
    window.dispatchEvent(new Event('pagehide'))
    expect(readPersisted(snapshotKey)).toBeNull()
  })

  it('resets the same boundary on successful password login', async () => {
    const qc = client()
    seed(qc)
    render(<BootstrapContext.Provider value={DEFAULT_BOOTSTRAP}><LoginPage next={undefined} /></BootstrapContext.Provider>)
    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /sign in/i }).closest('form')!)
      await Promise.resolve()
    })
    expect(assign).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('pagehide'))
    expect(readPersisted(snapshotKey)).toBeNull()
    expect(qc.getQueryCache().getAll()).toHaveLength(0)
  })

  it('resets the same boundary on an expired-auth redirect', async () => {
    const qc = client()
    seed(qc)
    setBootstrapForTests(DEFAULT_BOOTSTRAP)
    configureClient({ transport: createMemoryAdapter({ routes: { 'GET /api/settings': () => [401, { error: 'Authentication required' }] } }) })
    await expect(get('api/settings', z.unknown())).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(assign).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('pagehide'))
    expect(readPersisted(snapshotKey)).toBeNull()
    expect(qc.getQueryCache().getAll()).toHaveLength(0)
  })

  it('resets the same boundary on successful passkey login', async () => {
    const qc = client()
    seed(qc)
    const buffer = new Uint8Array([1, 2, 3]).buffer
    vi.stubGlobal('PublicKeyCredential', vi.fn())
    vi.stubGlobal('navigator', { credentials: { get: vi.fn().mockResolvedValue({ id: 'synthetic', rawId: buffer, type: 'public-key', response: { clientDataJSON: buffer, authenticatorData: buffer, signature: buffer, userHandle: null } }) } })
    configureClient({ transport: createMemoryAdapter({ routes: {
      'POST /api/auth/passkey/options': () => [200, { ok: true, publicKey: { challenge: 'AQID' } }],
      'POST /api/auth/passkey/login': () => [200, { ok: true }],
    } }) })
    const bootstrap = { ...DEFAULT_BOOTSTRAP, auth: { ...DEFAULT_BOOTSTRAP.auth, passkeys_enabled: true } }
    render(<BootstrapContext.Provider value={bootstrap}><LoginPage next={undefined} /></BootstrapContext.Provider>)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in with passkey/i }))
      await Promise.resolve()
    })
    expect(assign).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('pagehide'))
    expect(readPersisted(snapshotKey)).toBeNull()
    expect(qc.getQueryCache().getAll()).toHaveLength(0)
  })
})
