import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { bootTestServer } from '../test/harness.js'
import { Session } from './session.js'

it('derives only the requested turns on first open and older pages of 5,000 rows', async () => {
  const server = await bootTestServer()
  const db = new DatabaseSync(join(server.state, 'state.db'))
  try {
    const sid = 'range-large'
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL);
      CREATE INDEX idx_messages_session ON messages(session_id)`)
    db.prepare('INSERT INTO sessions VALUES (?, ?)').run(sid, 'webui')
    const insert = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)')
    const messages = Array.from({ length: 5000 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `row ${i}`, timestamp: i + 1 }))
    db.exec('BEGIN')
    for (const [i, row] of messages.entries()) insert.run(i + 1, sid, row.role, row.content, row.timestamp)
    db.exec('COMMIT')
    const session = new Session({ session_id: sid, messages }, { workspace: server.state, model: null })
    server.deps.sessions.markStateDbSeen(session)
    await server.deps.sessionStore.save(session, { touchUpdatedAt: false })
    const derive = vi.spyOn(server.deps.sessions, 'backgroundLinked')
    const merge = vi.spyOn(server.deps.sessions, 'mergedTranscript')
    const context = vi.spyOn(server.deps.sessions, 'modelContext')
    const sql = vi.spyOn(DatabaseSync.prototype, 'prepare')
    const prefixes = new Set<SessionPrefixIndex>()
    for (const [i, query] of [{ msg_limit: '50' }, { msg_limit: '50' }, { msg_limit: '50', msg_before: '2500' }].entries()) {
      sql.mockClear()
      const page = (await server.deps.sessions.detail(sid, query))
      expect(page.message_count).toBe(5000)
      expect(page.messages).toHaveLength(50)
      prefixes.add((await server.deps.sessionStore.get(sid)).prefixIndex!)
      if (i > 0) expect(sql).not.toHaveBeenCalled()
      else expect(sql.mock.calls.some(([query]) => query.includes('AND id > ?'))).toBe(true)
    }
    expect(prefixes.size).toBe(1)
    expect(Math.max(...derive.mock.calls.map((call) => call[1].length))).toBeLessThanOrEqual(52)
    expect(merge.mock.calls.some((call) => (call[1] ?? session.messages).length === 5000)).toBe(false)
    expect(context).not.toHaveBeenCalled()
  } finally { db.close(); await server.close(); vi.restoreAllMocks() }
})

import { messageWindowForDisplay, messagesForLimitedPayload, toolCallsForMessageWindow } from './window.js'
import { anchorMessageKey } from './compress.js'
import { SessionPrefixIndex } from './prefix-index.js'
import * as stateDb from './state-db.js'
import type { Message } from './session.js'

const fixtures: Message[][] = [
  [
    { role: 'user', content: 'first', _turn_id: 'one' },
    { role: 'assistant', content: '', _turn_id: 'one', tool_calls: [{ id: 'late', function: { name: 'terminal', arguments: '{}' } }] },
    { role: 'user', content: 'second', _turn_id: 'two' },
    { role: 'tool', tool_call_id: 'late', content: 'cross-turn result', _turn_id: 'two' },
    { role: 'assistant', content: 'done', _turn_id: 'two' },
  ],
  [
    { role: 'user', content: 'before', timestamp: 10 },
    { role: 'assistant', content: 'answer', timestamp: 11 },
    { role: 'assistant', content: '[context compaction] reference', _context_compression_marker: true, timestamp: 12 },
    { role: 'user', content: 'after', timestamp: 13 },
    { role: 'assistant', content: 'next', timestamp: 14 },
  ],
  Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `legacy ${i}`, timestamp: i + 1 })),
  [
    { role: 'user', content: 'tools', _turn_id: 'first', timestamp: 1, attachments: ['image.png'] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'one', function: { name: 'terminal', arguments: '{}' } }], _turn_id: 'first', timestamp: 2 },
    { role: 'tool', tool_call_id: 'one', content: 'result', timestamp: 3, _turn_id: 'first' },
    { role: 'tool', content: '{"todos":[{"id":"one","content":"check","status":"pending"}]}', _turn_id: 'first' },
    { role: 'assistant', content: 'complete', timestamp: 4, _turn_id: 'first' },
    { role: 'user', content: 'next', timestamp: 5, _turn_id: 'second' },
    { role: 'assistant', content: 'answer', timestamp: 6, _turn_id: 'second' },
  ],
  [
    { role: 'user', content: 'start', timestamp: 1 },
    { role: 'assistant', content: 'before', timestamp: 2 },
    { role: 'user', content: '[OUT-OF-BAND USER MESSAGE]\nsteer\n[/OUT-OF-BAND USER MESSAGE]', timestamp: 3 },
    { role: 'user', content: 'server steer', _steer: { steer_id: 'server' }, timestamp: 4 },
    { role: 'assistant', content: 'after', timestamp: 5 },
    { role: 'user', content: 'finished process', _source: 'process_wakeup', _turn_id: 'wake', timestamp: 6 },
    { role: 'assistant', content: '[SILENT]', _turn_id: 'wake', timestamp: 7 },
  ],
  [
    { role: 'user', content: 'start', timestamp: 1 },
    { role: 'assistant', content: 'answer', timestamp: 2 },
    { role: 'user', content: 'hidden', display_kind: 'hidden', timestamp: 3 },
    { role: 'user', content: 'next', timestamp: 4 },
    { role: 'assistant', content: 'answer', timestamp: 5 },
    { role: 'tool', content: '{"todos":[]}', timestamp: 6 },
  ],
  [{ role: 'user', content: 'a', _turn_id: 'repeat' }, { role: 'assistant', content: 'b', _turn_id: 'other' }, { role: 'assistant', content: 'c', _turn_id: 'repeat' }, { role: 'user', content: 'd' }],
]

async function assertWindows(server: Awaited<ReturnType<typeof bootTestServer>>, session: Session) {
  const service = server.deps.sessions, full = (await service.detail(session.session_id, {})), rows = full.messages as Message[]
  for (const limit of [1, 2, 3, 50]) for (const before of [null, ...Array.from({ length: rows.length + 1 }, (_, i) => i)]) {
    const actual = (await service.detail(session.session_id, { msg_limit: String(limit), ...(before === null ? {} : { msg_before: String(before) }) }))
    const [messages, offset] = messageWindowForDisplay(rows, limit, before)
    const expected = { ...full, messages: messagesForLimitedPayload(messages), _messages_offset: offset, _messages_truncated: offset > 0,
      tool_calls: before !== null || messages.length < rows.length ? toolCallsForMessageWindow(full.tool_calls, offset, messages.length) : full.tool_calls }
    Reflect.deleteProperty(actual, '_load_revision'); Reflect.deleteProperty(expected, '_load_revision')
    expect(actual, `limit=${limit}, before=${before}`).toEqual(expected)
  }
}

it.each(fixtures.map((rows, i) => [i, rows] as const))('keeps every window and summary equal to the full build, fixture %s', async (_, rows) => {
  const server = await bootTestServer()
  try {
    const session = new Session({ session_id: 'range-equal', messages: rows, compression_anchor_summary: 'reference', compression_anchor_visible_idx: 1,
      tool_calls: [{ assistant_msg_idx: 1, tid: 'recorded', name: 'terminal', args: { command: 'pwd' }, snippet: 'recorded result' }] }, { workspace: server.state, model: null })
    await server.deps.sessionStore.save(session)
    await assertWindows(server, session)
    session.compression_anchor_message_key = anchorMessageKey(rows[1])
    await server.deps.sessionStore.save(session)
    await assertWindows(server, session)
  } finally { await server.close() }
})

it.each([0, 3, 4])('counts sanitized model messages exactly at the compression boundary, %s rows', async (count) => {
  const server = await bootTestServer()
  try {
    const session = new Session({ session_id: 'range-small', messages: fixtures[2]!.slice(0, count) }, { workspace: server.state, model: null })
    await server.deps.sessionStore.save(session)
    await assertWindows(server, session)
  } finally { await server.close() }
})

it('extends only appended rows and rebuilds the index after a revision replacement', () => {
  const rows = [...fixtures[2]!], index = new SessionPrefixIndex(rows, 'first', null), original = index.summary()
  rows.push({ role: 'user', content: 'new', timestamp: 100 }); index.extend()
  expect(index.length).toBe(9)
  expect(index.summary(8)).toBe(original)
  expect(index.turnStart(8)).toBe(8)
  expect(index.summary().maxTimestamp).toBe(100)
  const changed = new SessionPrefixIndex([{ role: 'assistant', content: 'replacement' }], 'second', null)
  expect(changed.turnId(0)).toBe('legacy:start')
  expect(changed.summary().userCount).toBe(0)
})

it.each([false, true])('uses a keyset tail and falls back for an unidentified duplicate=%s', async (duplicate) => {
  const server = await bootTestServer(), path = join(server.state, 'state.db'), db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL); CREATE INDEX idx_messages_session ON messages(session_id)')
    const sid = 'range-db'
    db.prepare('INSERT INTO messages VALUES (1, ?, ?, ?, ?)').run(sid, 'user', 'same', 1)
    const read = stateDb.stateDbSessionRead(path, sid)
    const session = new Session({ session_id: sid, messages: duplicate ? [{ role: 'user', content: 'same', timestamp: 1 }] : read.rows }, { workspace: server.state, model: null })
    server.deps.sessions.markStateDbSeen(session, read)
    await server.deps.sessionStore.save(session, { touchUpdatedAt: false })
    db.prepare('INSERT INTO messages VALUES (2, ?, ?, ?, ?)').run(sid, 'user', 'same', 1)
    db.prepare('INSERT INTO messages VALUES (3, ?, ?, ?, ?)').run(sid, 'assistant', 'CLI reply', 2)
    const fullRead = vi.spyOn(server.deps.sessions, 'stateDbRows')
    await server.deps.sessions.detail(sid, { msg_limit: '50' })
    expect(fullRead).toHaveBeenCalledTimes(duplicate ? 1 : 0)
    fullRead.mockClear()
    await server.deps.sessions.detail(sid, { msg_limit: '1', msg_before: '1' })
    expect(fullRead).not.toHaveBeenCalled()
    await assertWindows(server, session)
  } finally { db.close(); await server.close(); vi.restoreAllMocks() }
})

it('reuses a verified saved append and invalidates an edit with unchanged length', async () => {
  const server = await bootTestServer()
  try {
    let session = new Session({ session_id: 'range-save', messages: [...fixtures[2]!] }, { workspace: server.state, model: null })
    const store = server.deps.sessionStore, detail = async () => (await server.deps.sessions.detail(session.session_id, { msg_limit: '1' }))
    await store.save(session); session = await store.get(session.session_id); await detail()
    const first = session.prefixIndex!
    session.messages.push({ role: 'user', content: 'appended', timestamp: 500 })
    await store.save(session)
    expect(session.prefixIndex).toBe(first)
    expect((await detail()).message_count).toBe(9)
    expect(first.length).toBe(9)
    session.messages[0]!.content = 'edited'
    await store.save(session)
    expect(session.prefixIndex).toBeUndefined()
    await detail()
    expect(session.prefixIndex).not.toBe(first)
    await assertWindows(server, session)
  } finally { await server.close() }
})

it('does not inspect an older prefix to attach a trailing result outside the requested page', () => {
  const rows: Message[] = [
    { role: 'assistant', tool_calls: [{ id: 'old' }] },
    { role: 'user', content: 'latest' },
    { role: 'tool', tool_call_id: 'old', content: 'old result' },
  ]
  Object.defineProperty(rows, '0', { get: () => { throw new Error('visited older prefix') } })
  expect(messageWindowForDisplay(rows, 1, null)).toEqual([[rows[1]], 1])
})

import { buildActiveTurnToken } from '../redact.js'

it.each([false, true])('keeps the full-build pending turn boundary with a journal=%s', async (journaled) => {
  const server = await bootTestServer()
  try {
    const turn = 'range-live', sid = 'range-pending', started = server.deps.sessions.deps.now(), token = buildActiveTurnToken(turn, started)!
    const rows: Message[] = [...fixtures[2]!, ...(journaled ? [
      { role: 'user', content: 'pending', _turn_id: turn, _active_turn_token: token, timestamp: started },
      { role: 'assistant', content: 'persisted output', _turn_id: turn, timestamp: started + 1 },
    ] : [])]
    const session = new Session({ session_id: sid, messages: rows, active_stream_id: turn, pending_user_message: 'pending', pending_started_at: started }, { workspace: server.state, model: null })
    server.deps.sessions.deps.runtime.activeStreamIds.add(turn)
    await server.deps.sessionStore.save(session)
    if (journaled) { const writer = (await server.deps.journal.writer(sid, turn)); (await writer.appendSseEvent('token', { text: 'persisted output' })); (await writer.close()) }
    await assertWindows(server, session)
    const page = (await server.deps.sessions.detail(sid, { msg_limit: '1' }))
    expect((page.messages as Message[]).some((m) => m.content === 'pending')).toBe(true)
    expect(page.transcript_seq).toEqual(journaled ? { stream_id: turn, seq: 0 } : null)
  } finally { await server.close() }
})

it('widens sparse visible pages without repeatedly deriving the same prefix', async () => {
  const server = await bootTestServer()
  try {
    const rows = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' },
      ...Array.from({ length: 400 }, (_, i) => ({ role: 'user', content: 'scaffold', display_kind: 'hidden', _turn_id: `hidden-${i}` })),
      { role: 'user', content: 'latest' }, { role: 'assistant', content: 'reply' }]
    const session = new Session({ session_id: 'range-sparse', messages: rows }, { workspace: server.state, model: null })
    await server.deps.sessionStore.save(session)
    const derive = vi.spyOn(server.deps.sessions, 'backgroundLinked')
    const page = (await server.deps.sessions.detail(session.session_id, { msg_limit: '4' }))
    expect((page.messages as Message[]).filter((m) => m.display_kind !== 'hidden')).toHaveLength(4)
    expect(derive.mock.calls.reduce((total, call) => total + call[1].length, 0)).toBeLessThan(rows.length * 3)
  } finally { vi.restoreAllMocks(); await server.close() }
})

it('keeps a running turn record-only tool row in the compression anchor coordinates', async () => {
  const server = await bootTestServer()
  try {
    const turn = 'range-record-live', started = server.deps.sessions.deps.now()
    const session = new Session({
      session_id: 'range-record-anchor',
      messages: [
        { role: 'user', content: 'earlier', timestamp: 1 },
        { role: 'assistant', content: 'settled reply', timestamp: 2 },
        { role: 'user', content: 'pending', _turn_id: turn, _active_turn_token: buildActiveTurnToken(turn, started), timestamp: started },
        { role: 'assistant', content: '', _turn_id: turn, timestamp: started + 1 },
      ],
      tool_calls: [{ assistant_msg_idx: 3, tid: 'record-only', name: 'terminal', args: { command: 'pwd' } }],
      active_stream_id: turn, pending_user_message: 'pending', pending_started_at: started,
      compression_anchor_summary: 'reference', compression_anchor_visible_idx: 99,
    }, { workspace: server.state, model: null })
    server.deps.sessions.deps.runtime.activeStreamIds.add(turn)
    await server.deps.sessionStore.save(session)
    const full = (await server.deps.sessions.detail(session.session_id, {}))
    expect(full.compression_reference).toEqual({ text: 'reference', after_message_index: 3 })
    for (const query of [{ msg_limit: '50' }, { msg_limit: '1', msg_before: '2' }]) {
      expect((await server.deps.sessions.detail(session.session_id, query)).compression_reference).toEqual(full.compression_reference)
    }
  } finally { await server.close() }
})

import compactionFixture from '../test/fixtures/compaction-replay.json' with { type: 'json' }

it.each(['compacted', 'twiceCompacted', 'editedThenCompacted', 'editedTwiceCompacted', 'reverted'] as const)('keeps the full-build archive and UID identities through a %s tail read', async (stage) => {
  const server = await bootTestServer(), path = join(server.state, 'state.db'), db = new DatabaseSync(path)
  try {
    const sid = compactionFixture.sessionId
    const load = (snapshot: keyof typeof compactionFixture.snapshots) => {
      db.exec('PRAGMA foreign_keys = OFF; DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS system_prompts')
      db.exec([...compactionFixture.schema, ...compactionFixture.snapshots[snapshot]].join('\n'))
    }
    load('initial')
    const initial = stateDb.stateDbSessionRead(path, sid)
    const session = new Session({ session_id: sid, messages: initial.rows, context_messages: initial.rows }, { workspace: server.state, model: null })
    server.deps.sessions.markStateDbSeen(session, initial)
    await server.deps.sessionStore.save(session, { touchUpdatedAt: false })
    load(stage)
    const tail = stateDb.stateDbSessionTailRead(path, sid, session.state_db_seen_id!)
    expect(tail.ok).toBe(true)
    expect(tail.rows).toEqual(stateDb.stateDbSessionRead(path, sid).rows)
    const fullRead = vi.spyOn(server.deps.sessions, 'stateDbRows')
    await server.deps.sessions.detail(sid, { msg_limit: '50' })
    expect(fullRead).not.toHaveBeenCalled()
    await assertWindows(server, session)
  } finally { vi.restoreAllMocks(); db.close(); await server.close() }
})

it('invalidates cached tail summaries on a WAL append without rebuilding the sidecar index', async () => {
  const server = await bootTestServer(), path = join(server.state, 'state.db'), db = new DatabaseSync(path)
  try {
    const sid = 'range-wal'
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL); CREATE INDEX idx_messages_session ON messages(session_id)')
    db.prepare('INSERT INTO sessions VALUES (?, ?)').run(sid, 'webui')
    const insert = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)')
    insert.run(1, sid, 'user', 'first', 1)
    const read = stateDb.stateDbSessionRead(path, sid)
    const session = new Session({ session_id: sid, messages: read.rows }, { workspace: server.state, model: null })
    server.deps.sessions.markStateDbSeen(session, read)
    await server.deps.sessionStore.save(session, { touchUpdatedAt: false })
    expect((await server.deps.sessions.detail(sid, { msg_limit: '1' }))).toMatchObject({ message_count: 1, can_compress: false })
    const prefix = (await server.deps.sessionStore.get(sid)).prefixIndex
    for (let i = 2; i <= 4; i += 1) insert.run(i, sid, i % 2 ? 'user' : 'assistant', `new ${i}`, i)
    const fullRead = vi.spyOn(server.deps.sessions, 'stateDbRows')
    const older = (await server.deps.sessions.detail(sid, { msg_limit: '1', msg_before: '1' }))
    expect(older).toMatchObject({ message_count: 4, can_compress: true })
    expect((older.messages as Message[]).map((m) => m.content)).toEqual(['first'])
    expect((await server.deps.sessionStore.get(sid)).prefixIndex).toBe(prefix)
    expect(fullRead).not.toHaveBeenCalled()
    await assertWindows(server, session)
    insert.run(5, sid, 'tool', '{"todos":[{"id":"tail","content":"tail task","status":"pending"}]}', null)
    insert.run(6, sid, 'assistant', 'tail settled', 6)
    const withTodo = (await server.deps.sessions.detail(sid, { msg_limit: '1', msg_before: '1' }))
    expect(withTodo.todo_state).toMatchObject({ todos: [{ id: 'tail', content: 'tail task', status: 'pending' }], ts: 4 })
    await assertWindows(server, session)
  } finally { vi.restoreAllMocks(); db.close(); await server.close() }
})

import { storeAnchorScene } from './anchor.js'
import { UNSETTLED_TODO_KEY } from './todo.js'

it('preserves stored scenes with duplicate content refs and unsettled todo precedence in every window', async () => {
  const server = await bootTestServer()
  try {
    const rows: Message[] = [
      { role: 'user', content: 'first', timestamp: 1 },
      { role: 'assistant', content: 'same reply', timestamp: 9 },
      { role: 'user', content: 'second', timestamp: 2 },
      { role: 'assistant', content: 'same reply', timestamp: 9 },
      { role: 'tool', content: '{"todos":[{"id":"old","content":"old task","status":"pending"}]}', timestamp: 10 },
    ]
    const session = new Session({ session_id: 'range-stored-scene', messages: rows,
      [UNSETTLED_TODO_KEY]: { todos: [{ id: 'new', content: 'unsettled task', status: 'pending' }], ts: 20 },
    }, { workspace: server.state, model: null })
    expect(storeAnchorScene(session, { message_index: 3, scene: { version: 'activity_scene_v1', final_answer: 'same reply', terminal_state: 'completed', activity_rows: [{ row_id: 'stored', role: 'prose', order_index: 0, text: 'stored detail' }] } }, 100)).not.toBeNull()
    await server.deps.sessionStore.save(session)
    const full = (await server.deps.sessions.detail(session.session_id, {}))
    expect(full.todo_state).toMatchObject({ todos: [{ id: 'new', content: 'unsettled task', status: 'pending' }], ts: 20 })
    const scenes = (full.messages as Message[]).map((m) => m._anchor_activity_scene as Message | undefined)
    expect(scenes[1]?.activity_rows).not.toEqual(scenes[3]?.activity_rows)
    await assertWindows(server, session)
  } finally { await server.close() }
})

it.each([false, true])('keeps the legacy timestamp merge with a row-id column=%s', async (rowIds) => {
  const server = await bootTestServer(), path = join(server.state, 'state.db'), db = new DatabaseSync(path)
  try {
    const sid = 'range-legacy'
    db.exec(`CREATE TABLE messages (${rowIds ? 'id INTEGER PRIMARY KEY,' : ''} session_id TEXT, role TEXT, content TEXT, timestamp REAL); CREATE INDEX idx_messages_session ON messages(session_id)`)
    const rows = Array.from({ length: 4 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `row ${i}`, timestamp: i + 1 }))
    const insert = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
    for (const row of rows) insert.run(sid, row.role, row.content, row.timestamp)
    const session = new Session({ session_id: sid, messages: rows.slice(0, 2) }, { workspace: server.state, model: null })
    await server.deps.sessionStore.save(session)
    const fullRead = vi.spyOn(server.deps.sessions, 'stateDbRows')
    expect((await server.deps.sessions.detail(sid, { msg_limit: '1' })).message_count).toBe(4)
    expect(fullRead).toHaveBeenCalledTimes(1)
    await assertWindows(server, session)
    session.truncation_watermark = 2
    await server.deps.sessionStore.save(session)
    expect((await server.deps.sessions.detail(sid, { msg_limit: '1' })).message_count).toBe(2)
    await assertWindows(server, session)
  } finally { vi.restoreAllMocks(); db.close(); await server.close() }
})


it.each([3, 4])('counts the separate compressed model context instead of the display transcript, %s rows', async (count) => {
  const server = await bootTestServer()
  try {
    const context = [
      { role: 'assistant', content: '[context compaction] earlier summary', _context_compression_marker: true },
      ...fixtures[2]!.slice(0, count - 1),
    ]
    const session = new Session({ session_id: 'range-model-context', messages: fixtures[2]!, context_messages: context }, { workspace: server.state, model: null })
    await server.deps.sessionStore.save(session)
    expect((await server.deps.sessions.detail(session.session_id, { msg_limit: '1' })).can_compress).toBe(count === 4)
    await assertWindows(server, session)
  } finally { await server.close() }
})

import { batchUpdate, recordBackgroundUpdate } from './background-updates.js'

it('keeps parent review proof outside a page without enumerating the cached prefix (TAL-1022)', async () => {
  const server = await bootTestServer()
  try {
    const turn = 'review-parent', delegation = 'review-child'
    const messages: Message[] = [
      { role: 'user', content: 'Background result', _source: 'process_wakeup', _turn_id: turn, _background_review_terminal: 'completed', timestamp: 1 },
      { role: 'assistant', content: '[SILENT]', _turn_id: turn, timestamp: 2 },
      ...Array.from({ length: 2000 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `unrelated ${i}`, _turn_id: `unrelated-${Math.floor(i / 2)}`, timestamp: i + 3 })),
      { role: 'user', content: 'Agent notification', _turn_id: 'notification', display_kind: 'async_delegation_complete', display_metadata: { delegation_id: delegation }, timestamp: 2003 },
    ]
    const session = new Session({ session_id: 'range-background-review', messages }, { workspace: server.state, model: null })
    const update = batchUpdate([{ event: { type: 'async_delegation', goal: 'Review the result', results: [{ status: 'completed' }] }, prompt: 'Background result' }])
    recordBackgroundUpdate(session, turn, update)
    recordBackgroundUpdate(session, `delegation:${delegation}`, update)
    session.extra.completion_acceptances = { [JSON.stringify([server.state, delegation])]: turn }
    await server.deps.sessionStore.save(session, { touchUpdatedAt: false })
    const service = server.deps.sessions
    const full = (await service.detail(session.session_id, {})).messages as Message[]
    expect(full.at(-1)?._background_update).toMatchObject({ review_state: 'reviewed' })
    await service.detail(session.session_id, { msg_limit: '1' })
    const resident = (await server.deps.sessionStore.get(session.session_id))
    const iterate = resident.messages[Symbol.iterator].bind(resident.messages)
    let prefixEnumerations = 0
    Object.defineProperty(resident.messages, Symbol.iterator, { configurable: true, value: () => { prefixEnumerations += 1; return iterate() } })
    const latest = (await service.detail(session.session_id, { msg_limit: '1' })).messages as Message[]
    const older = (await service.detail(session.session_id, { msg_limit: '1', msg_before: '2' })).messages as Message[]
    expect(latest.at(-1)?._background_update).toMatchObject({ review_state: 'reviewed', lines: [{ review_state: 'reviewed' }] })
    expect(older[0]?._background_update).toMatchObject({ review_state: 'reviewed' })
    expect(prefixEnumerations, 'cached pages must not scan the complete session for review proof').toBe(0)
  } finally { await server.close() }
})

it('keeps one global newest answer across indexed pages, appended state.db tails and saved prefix extension (TAL-1114)', async () => {
  const server = await bootTestServer(), db = new DatabaseSync(join(server.state, 'state.db'))
  try {
    const sid = 'range-newest-reply'
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL); CREATE INDEX idx_messages_session ON messages(session_id)')
    db.prepare('INSERT INTO sessions VALUES (?, ?)').run(sid, 'webui')
    const rows = [
      { role: 'user', content: 'first', timestamp: 1 }, { role: 'assistant', content: 'a'.repeat(6000), timestamp: 2 },
      { role: 'user', content: 'second', timestamp: 3 }, { role: 'assistant', content: 'b'.repeat(7000), timestamp: 4 },
      { role: 'user', content: 'trailing prompt', timestamp: 5 },
    ]
    const insert = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)')
    rows.forEach((row, i) => insert.run(i + 1, sid, row.role, row.content, row.timestamp))
    const session = new Session({ session_id: sid, messages: rows }, { workspace: server.state, model: null })
    server.deps.sessions.markStateDbSeen(session)
    await server.deps.sessionStore.save(session)
    const check = async (latest: string) => {
      for (const query of [{}, { msg_limit: '1' }, { msg_limit: '2' }, { msg_limit: '2', msg_before: '2' }, { msg_limit: '2', msg_before: '4' }]) {
        const detail = await server.deps.sessions.detail(sid, query)
        for (const row of detail.messages as Record<string, unknown>[]) {
          if (row.role !== 'assistant') continue
          expect(row._display_truncated).toBe(row.content === latest ? undefined : true)
          expect((row._anchor_activity_scene as Record<string, unknown>).final_answer_excerpt).toBe(row.content === latest ? undefined : String(row.content).slice(0, 3000))
        }
      }
    }
    await check(rows[3]!.content)
    const prefix = session.prefixIndex
    insert.run(6, sid, 'assistant', 'c'.repeat(8000), 6)
    await check('c'.repeat(8000))
    expect(session.prefixIndex).toBe(prefix)
    session.messages.push({ role: 'assistant', content: 'c'.repeat(8000), timestamp: 6 })
    server.deps.sessions.markStateDbSeen(session)
    session.messages.push({ role: 'user', content: 'third', timestamp: 7 }, { role: 'assistant', content: 'd'.repeat(9000), timestamp: 8 })
    await server.deps.sessionStore.save(session)
    await check('d'.repeat(9000))
    expect(session.prefixIndex).toBe(prefix)
  } finally { db.close(); await server.close() }
})

it('does not publish an unfinished newest-reply cache entry to concurrent page reads (TAL-1114)', async () => {
  const server = await bootTestServer()
  let release: () => void = () => undefined
  try {
    const session = new Session({ session_id: 'range-concurrent-reply', messages: [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'a'.repeat(6000) }] }, { workspace: server.state, model: null })
    await server.deps.sessionStore.save(session)
    const original = server.deps.sessions.backgroundLinked.bind(server.deps.sessions)
    let entered: () => void = () => undefined
    const ready = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(server.deps.sessions, 'backgroundLinked').mockImplementationOnce(async (...args) => { entered(); await held; return original(...args) })
    const first = server.deps.sessions.detail(session.session_id, { msg_limit: '2' })
    await ready
    try {
      const second = await server.deps.sessions.detail(session.session_id, { msg_limit: '2' })
      expect((second.messages as Record<string, unknown>[]).at(-1)).not.toHaveProperty('_display_excerpt')
    } finally { release(); await first }
  } finally { release(); vi.restoreAllMocks(); await server.close() }
})
