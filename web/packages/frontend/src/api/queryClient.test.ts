import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'
import { createQueryClient } from './queryClient'
import { ProjectsSchema } from '../contracts'
import { readPersisted, removePersistedByPrefix } from '../lib/persisted'

const snapshotKey = 'hermes-boot:queries'
let qc: QueryClient

/** Snapshot serializations; TanStack's query hashing also calls `JSON.stringify`. */
function snapshotStringifies(): number {
  return vi.mocked(JSON.stringify).mock.calls.filter(([value]) => typeof value === 'object' && value !== null && 'queries' in value).length
}

beforeEach(() => {
  vi.useFakeTimers()
  qc = createQueryClient()
})

afterEach(() => {
  qc.clear()
  removePersistedByPrefix('hermes-boot')
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
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
    qc.setQueryData(['projects'], ProjectsSchema.parse({ projects: [{ project_id: 'p', name: 'Kept' }], active_profile: 'default', all_profiles: false, other_profile_count: 0 }))
    vi.advanceTimersByTime(1_000)
    expect(snapshotStringifies()).toBe(1)
    expect(readPersisted(snapshotKey)).toContain('Kept')
  })
})
