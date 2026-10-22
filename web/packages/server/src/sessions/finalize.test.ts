import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer } from '../test/harness.js'
import { sanitizeMessagesForApi } from './merge.js'

const task = 'chat.finalize_session' as const

describe('session finalize (TAL-937)', () => {
  async function setup() {
    const sidecar = new FakeSidecar()
    const server = await bootTestServer({ sidecar })
    onTestFinished(() => server.close())
    const session = await server.deps.sessionStore.newSession({ workspace: join(server.state, 'workspace') })
    session.messages = [{ role: 'user', content: 'old conversation' }, { role: 'assistant', content: 'old answer' }]
    await server.deps.sessionStore.save(session)
    return { sidecar, server, session }
  }

  it('finalizes once before clear and persists closing notices outside model history', async () => {
    const { sidecar, server, session } = await setup()
    sidecar.respond(task, async (params) => {
      expect(params).toEqual({ session_id: session.session_id, profile_home: server.state, reason: 'clear' })
      expect((await server.deps.sessionStore.get(session.session_id)).messages[0]?.content).toBe('old conversation')
      return { messages: ['bye', 'summary exported'] }
    })
    await server.deps.sessions.clear(session.session_id)
    const detail = await (await server.get(`/api/session?session_id=${session.session_id}`)).json() as { session: { messages: Record<string, unknown>[] } }
    const rows = detail.session.messages
    expect(sidecar.calls.filter((c) => c.method === task)).toHaveLength(1)
    expect(rows.every((m) => m.role === 'local_notice')).toBe(true)
    expect(rows.map((m) => [m.content, m._notice_kind])).toEqual([['bye', 'session_finalize'], ['summary exported', 'session_finalize']])
    expect(sanitizeMessagesForApi((await server.deps.sessions.readModelContext(session)))).toEqual([])
    server.deps.sessionStore.sessions.delete(session.session_id)
    const reloaded = await server.deps.sessionStore.get(session.session_id)
    expect(reloaded.messages.map((m) => m.content)).toEqual(['bye', 'summary exported'])
    expect(sanitizeMessagesForApi((await server.deps.sessions.readModelContext(reloaded)))).toEqual([])
    let history: unknown = null
    sidecar.respond('chat.start', (params) => {
      history = params.conversation_history
      throw new Error('synthetic stop after capturing model history')
    })
    const started = await (await server.get('/api/chat/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: session.session_id, message: 'new conversation' }),
    })).json() as { stream_id: string }
    await server.sse(`/api/chat/stream?stream_id=${started.stream_id}`, (frame) => frame.event === 'stream_end')
    expect(history).toEqual([])
  })

  it('finalizes deletion with its reason and discards closing messages', async () => {
    const { sidecar, server, session } = await setup()
    sidecar.respond(task, () => ({ messages: ['bye'] }))
    await server.deps.sessions.delete(session.session_id)
    expect(sidecar.calls.filter((c) => c.method === task).map((c) => c.params)).toEqual([
      { session_id: session.session_id, profile_home: server.state, reason: 'delete' },
    ])
    expect(await server.deps.sessionStore.load(session.session_id)).toBeNull()
    await server.deps.sessions.delete(session.session_id)
    expect(sidecar.calls.filter((c) => c.method === task)).toHaveLength(1)
  })

  it.each(['share', 'relay', 'store'] as const)('finalizes only after local deletion commits when %s cleanup fails', async (phase) => {
    const { sidecar, server, session } = await setup()
    let finalizedAfterCommit = false
    sidecar.respond(task, async () => {
      finalizedAfterCommit = await server.deps.sessionStore.wasDeleted(session.session_id)
        && await server.deps.sessionStore.load(session.session_id) === null
      return { messages: [] }
    })
    const failure = new Error('synthetic cleanup failure')
    const cleanup = phase === 'share'
      ? vi.spyOn(server.deps.sessions.deps.shares, 'revoke').mockRejectedValueOnce(failure)
      : phase === 'relay'
        ? vi.spyOn(server.deps.sessions.deps, 'clearRelayCompletions').mockRejectedValueOnce(failure)
        : vi.spyOn(server.deps.sessionStore, 'delete').mockResolvedValueOnce(false)
    onTestFinished(() => { cleanup.mockRestore() })
    await expect(server.deps.sessions.delete(session.session_id)).rejects.toThrow()
    expect(await server.deps.sessionStore.load(session.session_id)).not.toBeNull()
    expect(sidecar.calls.filter((c) => c.method === task)).toHaveLength(0)
    cleanup.mockRestore()
    await server.deps.sessions.delete(session.session_id)
    expect(finalizedAfterCommit).toBe(true)
    expect(sidecar.calls.filter((c) => c.method === task)).toHaveLength(1)
  })

  it('does not close a conversation whose deletion the Agent refuses', async () => {
    const { sidecar, server, session } = await setup()
    sidecar.respond('state_db.delete_cli_session', () => ({ ok: false, refused: 'active_turn' }))
    await expect(server.deps.sessions.delete(session.session_id)).rejects.toThrow('In use by another Agent process')
    expect(sidecar.calls.filter((c) => c.method === task)).toEqual([])
  })

  it.each(['clear', 'delete'] as const)('skips finalize for a subagent on %s', async (reason) => {
    const { sidecar, server, session } = await setup()
    session.source_tag = 'subagent'
    await server.deps.sessionStore.save(session)
    await expect(server.deps.sessions[reason](session.session_id)).rejects.toThrow(/Subagent|subagent/)
    expect(sidecar.calls.filter((c) => c.method === task)).toEqual([])
  })

  it.each(['clear', 'delete'] as const)('a sidecar failure does not block %s', async (reason) => {
    const { sidecar, server, session } = await setup()
    sidecar.respond(task, () => { throw new Error('synthetic finalize failure') })
    expect(await server.deps.sessions[reason](session.session_id)).toMatchObject({ ok: true })
    expect(sidecar.calls.filter((c) => c.method === task)).toHaveLength(1)
  })

  it('notifies once after the archive commit across concurrent requests, and preserves transcript and runtime state', async () => {
    const { sidecar, server, session } = await setup()
    session.pinned = true
    session.state_db_lineage = [session.session_id, 'continued']
    session.pending_user_message = 'kept pending'
    await server.deps.sessionStore.save(session)
    sidecar.respond(task, async (params) => {
      expect(params).toEqual({ session_id: session.session_id, profile_home: server.state, reason: 'archive', lineage: [session.session_id, 'continued'] })
      expect((await server.deps.sessionStore.load(session.session_id))).toMatchObject({ archived: true, pinned: false, pending_user_message: 'kept pending' })
      return { messages: ['discard archive messages'] }
    })
    await Promise.all([server.deps.sessions.archive(session.session_id, true), server.deps.sessions.archive(session.session_id, true)])
    await server.deps.sessions.archive(session.session_id, false)
    expect(sidecar.calls.filter((c) => c.method === task)).toHaveLength(1)
    expect(session.messages.map((m) => m.content)).toEqual(['old conversation', 'old answer'])
    expect(session.pending_user_message).toBe('kept pending')
    expect(sidecar.calls.filter((c) => c.method === 'chat.evict_agent')).toEqual([])
  })

  it('a failed archive save emits nothing and a successful retry still notifies', async () => {
    const { sidecar, server, session } = await setup()
    session.pinned = true
    await server.deps.sessionStore.save(session)
    const save = vi.spyOn(server.deps.sessionStore, 'save').mockRejectedValueOnce(new Error('synthetic store failure'))
    onTestFinished(() => { save.mockRestore() })
    await expect(server.deps.sessions.archive(session.session_id, true)).rejects.toThrow('synthetic store failure')
    expect(session).toMatchObject({ archived: false, pinned: true })
    expect((await server.deps.sessionStore.load(session.session_id))).toMatchObject({ archived: false, pinned: true })
    expect(sidecar.calls.filter((c) => c.method === task)).toEqual([])
    await server.deps.sessions.archive(session.session_id, true)
    expect(sidecar.calls.filter((c) => c.method === task)).toHaveLength(1)
  })

  it('a callback failure retains the committed archive and logs no callback payload', async () => {
    const { sidecar, server, session } = await setup()
    sidecar.respond(task, () => { throw new Error('private-synthetic-credential'.repeat(1000)) })
    expect(await server.deps.sessions.archive(session.session_id, true)).toMatchObject({ ok: true })
    expect((await server.deps.sessionStore.load(session.session_id))?.archived).toBe(true)
    await server.deps.sessions.archive(session.session_id, true)
    expect(sidecar.calls.filter((c) => c.method === task)).toHaveLength(1)
    expect(server.logs.filter((line) => line.includes('session lifecycle'))).toEqual(['[webui] session lifecycle (archive) failed'])
    expect(server.logs.join('')).not.toContain('private-synthetic-credential')
  })

  it('wrong-profile archive and automatic cleanup never notify', async () => {
    const { sidecar, server, session } = await setup()
    session.profile = 'foreign'
    await server.deps.sessionStore.save(session)
    const response = await server.get('/api/session/archive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: session.session_id, archived: true }) })
    expect(response.status).toBe(404)
    expect(session.archived).toBe(false)
    const empty = await server.deps.sessionStore.newSession({ workspace: join(server.state, 'workspace') })
    await server.deps.sessionStore.save(empty)
    expect(await server.deps.sessions.cleanup(true)).toMatchObject({ ok: true, cleaned: 1 })
    expect(sidecar.calls.filter((c) => c.method === task)).toEqual([])
  })

  it('a refused archive overwrite emits nothing and a complete retry still notifies', async () => {
    const { sidecar, server, session } = await setup()
    const messages = session.messages
    session.messages = []
    session.pending_user_message = 'pending turn'
    let failure: unknown
    try { await server.deps.sessions.archive(session.session_id, true) } catch (error) { failure = error }
    expect(sidecar.calls.filter((c) => c.method === task)).toEqual([])
    expect(failure).toMatchObject({ status: 409 })
    expect(session.archived).toBe(false)
    expect((await server.deps.sessionStore.load(session.session_id))?.archived).toBe(false)
    session.messages = messages
    await server.deps.sessions.archive(session.session_id, true)
    expect((await server.deps.sessionStore.load(session.session_id))?.archived).toBe(true)
    expect(sidecar.calls.filter((c) => c.method === task)).toHaveLength(1)
  })

  it('uses the persisted archive transition when cached metadata disagrees', async () => {
    const { sidecar, server, session } = await setup()
    await server.deps.sessions.archive(session.session_id, true)
    session.archived = false
    await server.deps.sessions.archive(session.session_id, true)
    expect(sidecar.calls.filter((c) => c.method === task)).toHaveLength(1)
  })

})
