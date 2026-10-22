import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { allSessions, buildSessionListPayload, dedupeCliSidebarSessions, sessionListResponse, type ListParams, type ListPayload, type Row, type RuntimeOverlay } from './list.js'
import * as sessionRows from './storage/row.js'
import { bootTestServer } from '../test/harness.js'
import { sessionDirectory, sessionIndexPath, sessionPath } from '../test/storage.js'
import { Session } from './session.js'

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../contracts/fixtures/web-session.json'), 'utf8')) as { session_list: { stored: Row[]; live_stream_ids: string[]; sessions: Row[] } }

function listed(stored: Row[], liveStreamIds: string[]): Row[] {
  const payload = { sessions: stored, sidebar_reference_sessions: [], archived_limit: null } as unknown as ListPayload
  const overlay: RuntimeOverlay = { activeStreamIds: new Set(liveStreamIds), runningCronJobs: new Map(), live: () => undefined, attention: () => null }
  return sessionListResponse(payload, overlay, false, 0, () => null).body.sessions
}

describe('session-list row validation (TAL-1218)', () => {
  it('sanitizes each row of a 300-row index exactly once per list read', async () => {
    const server = await bootTestServer()
    try {
      const store = server.deps.sessionStore
      const rows = Array.from({ length: 300 }, (_, i) => ({
        session_id: `indexed-${String(i).padStart(3, '0')}`, title: `Chat ${i}`, message_count: 2,
        last_message_at: 100 + i, updated_at: 100 + i, profile: 'default', archived: false,
      }))
      mkdirSync(sessionDirectory(store), { recursive: true })
      for (const row of rows) writeFileSync(sessionPath(store, row.session_id), JSON.stringify({ ...row, messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }] }))
      const index = JSON.stringify(rows)
      writeFileSync(sessionIndexPath(store), index)
      const sanitize = vi.spyOn(sessionRows, 'sanitizeSessionRow')
      for (let read = 0; read < 2; read++) {
        sanitize.mockClear()
        const result = await allSessions(store)
        expect(result).toMatchObject([...rows].reverse())
        const callsPerRow = rows.map((row) => sanitize.mock.calls.filter(([value]) => (value as Row).session_id === row.session_id).length)
        expect(callsPerRow).toEqual(rows.map(() => 1))
      }
      expect(readFileSync(sessionIndexPath(store), 'utf8')).toBe(index)
    } finally { vi.restoreAllMocks(); await server.close() }
  })

  it('still sanitizes a resident replacement for an already validated index identity', async () => {
    const server = await bootTestServer()
    try {
      const store = server.deps.sessionStore
      const session = await store.newSession()
      session.title = 'Resident chat'
      vi.spyOn(store, 'readIndexEntries').mockResolvedValue([session.compact()])
      const replacement = { ...session.compact(), title: {}, message_count: '2', read_only: 'unknown' }
      vi.spyOn(session, 'compact').mockReturnValue(replacement)
      const sanitize = vi.spyOn(sessionRows, 'sanitizeSessionRow')
      expect(await allSessions(store)).toMatchObject([{ session_id: session.session_id, title: '', message_count: 2, read_only: true }])
      expect(sanitize.mock.calls.filter(([value]) => value === replacement)).toHaveLength(1)
      expect(replacement).toMatchObject({ title: {}, message_count: '2', read_only: 'unknown' })
    } finally { vi.restoreAllMocks(); await server.close() }
  })
})

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

describe('Web-created diagnostic chats (TAL-1040)', () => {
  const opts = { showCli: false, showCron: false, showWebhook: false, showKanban: false, sourceFilter: null, requestVisibilityOverrides: true }
  it('keeps a compressed chat whose receipt names its lineage root while external sessions are hidden', () => {
    const tip = { session_id: 'tip', _lineage_root_id: 'root', _lineage_tip_id: 'tip', source: 'cli', source_tag: 'cli', message_count: 4, actual_message_count: 4 }
    const other = { session_id: 'other', _lineage_root_id: 'other-root', _lineage_tip_id: 'other', source: 'cli', source_tag: 'cli', message_count: 4, actual_message_count: 4 }
    expect(dedupeCliSidebarSessions([tip, other], new Set(), { ...opts, webCreated: new Set(['root']) }).map((r) => r.session_id)).toEqual(['tip'])
  })
})

describe('parent snapshot lookup (TAL-1219)', () => {
  it.each([
    { indexed: true, snapshot: true },
    { indexed: true, snapshot: false },
    { indexed: true, snapshot: undefined },
    { indexed: false, snapshot: true },
    { indexed: false, snapshot: false },
    { indexed: false, snapshot: undefined },
  ].flatMap((test) => (test.indexed ? [false, true] : [false]).map((legacy) => ({ ...test, legacy }))))('lists 50 forks with indexed=$indexed, snapshot=$snapshot, legacy=$legacy without redundant parent loads', async ({ indexed, snapshot, legacy }) => {
    const server = await bootTestServer()
    const store = server.deps.sessionStore
    try {
      const rows = Array.from({ length: 50 }, (_, i) => ({
        session_id: `fork_${i}`, parent_session_id: indexed ? legacy ? 'legacy_parent' : `parent_${i}` : 'missing_parent',
        source_tag: 'telegram', chat_id: 'shared_chat', message_count: 2, updated_at: i + 1,
      }))
      if (indexed) {
        for (const sid of new Set(rows.map((row) => row.parent_session_id))) {
          const parent = new Session({ session_id: sid, pre_compression_snapshot: snapshot, archived: true }, { workspace: '/synthetic', model: 'synthetic' })
          await store.save(parent)
        }
        const index = await store.readIndexEntries()
        if (legacy) await store.deps.storage.sessions.writeIndex(index.map((row) => {
          const old = { ...row }
          Reflect.deleteProperty(old, 'pre_compression_snapshot')
          return old
        }))
        store.sessions.clear()
      }
      const load = vi.spyOn(store, 'loadMetadataOnly')
      if (!indexed && snapshot !== undefined) load.mockResolvedValue(new Session({ session_id: 'missing_parent', pre_compression_snapshot: snapshot }, { workspace: '/synthetic', model: 'synthetic' }))
      const params: ListParams = {
        webuiRows: rows, activeProfile: 'default', allProfiles: false, includeArchived: false,
        excludeHidden: false, visibleOnly: false, showCliSessions: false, showClaudeCodeSessions: false,
        showPreviousMessagingSessions: false, showCronSessions: false, showWebhookSessions: false,
        showKanbanSessions: false, requestVisibilityOverrides: true, sidebarSource: null,
        archivedLimit: null, archivedOffset: 0, isolatedProfileMode: false, profilesMatch: () => true,
      }
      const expected = (snapshot ? [...rows].reverse() : [rows[49]!]).map((row) => ({ ...row, is_cli_session: false }))
      expect((await buildSessionListPayload(store, params)).sessions).toEqual(expected)
      expect(load).toHaveBeenCalledTimes(indexed && !legacy ? 0 : 1)
      if (!indexed || legacy) expect(load).toHaveBeenCalledWith(legacy ? 'legacy_parent' : 'missing_parent')
      expect((await buildSessionListPayload(store, params)).sessions).toEqual(expected)
      expect(load).toHaveBeenCalledTimes(indexed && !legacy ? 0 : 2)
    } finally { vi.restoreAllMocks(); await server.close() }
  })
})
