import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sessionListResponse, type ListPayload, type Row, type RuntimeOverlay } from './list.js'

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../contracts/fixtures/web-session.json'), 'utf8')) as { session_list: { stored: Row[]; live_stream_ids: string[]; sessions: Row[] } }

function listed(stored: Row[], liveStreamIds: string[]): Row[] {
  const payload = { sessions: stored, sidebar_reference_sessions: [], archived_limit: null } as unknown as ListPayload
  const overlay: RuntimeOverlay = { activeStreamIds: new Set(liveStreamIds), runningCronJobs: new Map(), live: () => undefined, attention: () => null }
  return sessionListResponse(payload, overlay, false, 0, () => null).body.sessions
}

describe('canonical session-list order (TAL-306)', () => {
  it('lists pinned rows first, then active rows, then newest sort_ts, then session id, and ships sort_ts', () => {
    const { stored, live_stream_ids: live, sessions } = fixture.session_list
    const rows = listed(stored, live)
    // Pinned beats a streaming unpinned row; a pending prompt counts as active; a created_at-only row sorts by it.
    expect(rows.map((r) => [r.session_id, r.sort_ts])).toEqual(sessions.map((r) => [r.session_id, r.sort_ts]))
    expect(rows).toEqual(sessions)
  })

  it('does not depend on the order rows arrive in', () => {
    const { stored, live_stream_ids: live, sessions } = fixture.session_list
    expect(listed([...stored].reverse(), live).map((r) => r.session_id)).toEqual(sessions.map((r) => r.session_id))
  })
})
