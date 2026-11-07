import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { dehydrate, type QueryClient } from '@tanstack/react-query'
import { createQueryClient, resetIdentityCache } from './queryClient'
import { ProjectsSchema } from '../contracts'
import { readPersisted, removePersistedByPrefix, writePersisted } from '../lib/persisted'

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, dehydrate: vi.fn(actual.dehydrate) }
})

const snapshotKey = 'hermes-boot:queries'
let qc: QueryClient
let setItem: MockInstance<Storage['setItem']>

const projects = (name: string) => ProjectsSchema.parse({ projects: [{ project_id: 'p', name }], active_profile: 'default', all_profiles: false, other_profile_count: 0 })

/** Snapshot serializations; TanStack's query hashing also calls `JSON.stringify`. */
function snapshotStringifies(): number {
  return vi.mocked(JSON.stringify).mock.calls.filter(([value]) => typeof value === 'object' && value !== null && 'queries' in value).length
}

function snapshotWrites(): string[] {
  return setItem.mock.calls.filter(([key]) => key === snapshotKey).map(([, value]) => value)
}

/** Replaces the browser's idle queue; the returned function drains it. */
function stubIdle(): { request: ReturnType<typeof vi.fn>; runIdle: () => void } {
  const queued: IdleRequestCallback[] = []
  const request = vi.fn((callback: IdleRequestCallback) => queued.push(callback))
  vi.stubGlobal('requestIdleCallback', request)
  return { request, runIdle: () => { for (const callback of queued.splice(0)) callback({ didTimeout: false, timeRemaining: () => 50 }) } }
}

beforeEach(() => {
  vi.useFakeTimers()
  setItem = vi.spyOn(Storage.prototype, 'setItem')
  qc = createQueryClient()
})

afterEach(() => {
  // Retires every client, so a later test's `pagehide` reaches only its own.
  resetIdentityCache()
  removePersistedByPrefix('hermes-boot')
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('boot snapshot writer', () => {
  it('ignores successes for queries the snapshot does not keep', () => {
    vi.spyOn(JSON, 'stringify')
    qc.setQueryData(['updates', 'notifications'], { notifications: [] })
    vi.advanceTimersByTime(1_000)
    expect(snapshotStringifies()).toBe(0)
    expect(readPersisted(snapshotKey)).toBeNull()
  })

  it('serializes a snapshot query success once', () => {
    vi.spyOn(JSON, 'stringify')
    qc.setQueryData(['projects'], projects('Kept'))
    vi.advanceTimersByTime(1_000)
    expect(snapshotStringifies()).toBe(1)
    expect(readPersisted(snapshotKey)).toContain('Kept')
  })

  it('waits for an idle period after the debounce, and that one callback writes the latest data', () => {
    const { request, runIdle } = stubIdle()
    qc.setQueryData(['projects'], projects('First'))
    vi.advanceTimersByTime(500)
    expect(snapshotWrites()).toHaveLength(0)
    expect(request).toHaveBeenCalledWith(expect.any(Function), { timeout: 2_000 })

    qc.setQueryData(['projects'], projects('Latest'))
    vi.advanceTimersByTime(500)
    expect(request).toHaveBeenCalledTimes(1)
    expect(snapshotWrites()).toHaveLength(0)

    runIdle()
    expect(snapshotWrites()).toHaveLength(1)
    expect(snapshotWrites()[0]).toContain('Latest')
  })

  it('skips an unchanged snapshot even though its timestamps moved, and writes a changed one', () => {
    qc.setQueryData(['projects'], projects('Same'))
    vi.advanceTimersByTime(1_000)
    expect(snapshotWrites()).toHaveLength(1)

    qc.setQueryData(['projects'], projects('Same'))
    vi.advanceTimersByTime(1_000)
    expect(snapshotWrites()).toHaveLength(1)

    qc.setQueryData(['projects'], projects('Changed'))
    vi.advanceTimersByTime(1_000)
    expect(snapshotWrites()).toHaveLength(2)
    expect(snapshotWrites()[1]).toContain('Changed')
  })

  it('writes the same snapshot again after storage refused it', () => {
    setItem.mockImplementationOnce(() => { throw new DOMException('full', 'QuotaExceededError') })
    qc.setQueryData(['projects'], projects('Same'))
    vi.advanceTimersByTime(1_000)
    qc.setQueryData(['projects'], projects('Same'))
    vi.advanceTimersByTime(1_000)
    expect(snapshotWrites()).toHaveLength(2)
  })

  it('writes on pagehide without waiting for idle, and skips an identical write there', () => {
    const { runIdle } = stubIdle()
    qc.setQueryData(['projects'], projects('Leaving'))
    window.dispatchEvent(new Event('pagehide'))
    expect(snapshotWrites()).toHaveLength(1)
    expect(snapshotWrites()[0]).toContain('Leaving')

    window.dispatchEvent(new Event('pagehide'))
    vi.advanceTimersByTime(1_000)
    runIdle()
    expect(snapshotWrites()).toHaveLength(1)
  })

  it('drops the detail over budget, keeps the generation, and dehydrates once', () => {
    writePersisted('hermes-boot-generation', 'current')
    writePersisted('hermes-webui-session', 'open')
    const client = createQueryClient()
    client.setQueryData(['projects'], projects('Shell'))
    client.setQueryData(['sessions', 'detail', 'open'], { session: { messages: 'x'.repeat(2_000_001) } })
    vi.mocked(dehydrate).mockClear()
    vi.advanceTimersByTime(1_000)

    expect(dehydrate).toHaveBeenCalledTimes(1)
    expect(JSON.parse(readPersisted(snapshotKey) ?? '{}')).toMatchObject({ generation: 'current', mutations: [], queries: [{ queryKey: ['projects'] }] })
  })
})
