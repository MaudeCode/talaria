/*
 * Regression ports (TAL-245): behaviour previously guarded by the Python cases in
 *   web/tests/test_issue1013_handoff_dock.py
 *   web/tests/test_issue1217_transcript_compaction.py
 *   web/tests/test_issue1494_state_db_fd_leak.py
 *   web/tests/test_issue1955_worktree_sessions.py
 *   web/tests/test_issue2419_cache_usage_display.py
 *   web/tests/test_issue2592_partial_dedupe.py
 *   web/tests/test_issue2841_show_cron_sessions_toggle.py
 *   web/tests/test_issue2863_session_index_prime.py
 *   web/tests/test_issue2914_truncation_watermark.py
 *   web/tests/test_issue3019_cron_project_sessions.py
 *   web/tests/test_issue3023_safe_session_id_validators.py
 *   web/tests/test_issue3346_legacy_dedup.py
 *   web/tests/test_issue3585_cron_session_overflow.py
 *   web/tests/test_issue3586_cli_session_source_label.py
 *   web/tests/test_issue3831_watermark_clear.py
 *   web/tests/test_issue3875_recovery_anchor_dedup.py
 *   web/tests/test_issue3929_error_preserves_partial.py
 *   web/tests/test_issue3929_partial_work_recovery.py
 *   web/tests/test_issue3987_imported_session_titles.py
 *   web/tests/test_issue4385_cron_archive_reappears.py
 *   web/tests/test_issue4490_presession_toolsets.py
 *   web/tests/test_issue4638_lineage_top_n_cap.py
 *   web/tests/test_issue4685_post_compression_context_metering.py
 *   web/tests/test_issue4714_claude_code_visibility_toggle.py
 *   web/tests/test_issue4718_claude_code_parse_cache.py
 *   web/tests/test_issue4836_manual_compression_recovery.py
 *   web/tests/test_issue4842_cron_projection_perf.py
 *   web/tests/test_issue4985_orphaned_webui_zero_message.py
 *   web/tests/test_issue5121_provider_auth_terminal_error.py
 *   web/tests/test_issue5132_state_db_override_top_n_cap.py
 *   web/tests/test_issue5270_cli_webui_continuity.py
 *   web/tests/test_issue5339_restart_stale_user_dedup.py
 *   web/tests/test_issue5532_clear_truncation_watermark.py
 *   web/tests/test_issue5532_session_clear_state_db_replay.py
 *   web/tests/test_issue5570_clear_backup_recovery.py
 *   web/tests/test_issue5572_messaging_clear_semantics.py
 *   web/tests/test_issue5854_anchor_scene_split.py
 *   web/tests/test_issue6022_worktree_config_default.py
 *   web/tests/test_issue6068_used_model_footer.py
 *   web/tests/test_issue6611_regenerate_turn_identity.py
 *   web/tests/test_issue6611_regeneration_authority.py
 *   web/tests/test_issue6611_regeneration_settlement.py
 *   web/tests/test_issue6672_workspace_switch_system_prompt.py
 *   web/tests/test_issue6722_provider_qualified_model_leak.py
 *   web/tests/test_issue6751_api_content_agent_replay.py
 *   web/tests/test_issue6911_intentional_shrink_backup.py
 *   web/tests/test_issue7168_round6_default_isolated_clamp.py
 *   web/tests/test_issue789.py
 *   web/tests/test_issue_branch_context_at_fork.py
 * (issues #789, #1013, #1217, #1494, #1955, #2419, #2592, #2841, #2863, #2914, #3019, #3023, #3346, #3585, #3586, #3831, #3875, #3929, #3987, #4385, #4490, #4638, #4685, #4714, #4718, #4836, #4842, #4985, #5121, #5132, #5270, #5339, #5532, #5570, #5572, #5854, #6022, #6068, #6611, #6672, #6722, #6751, #6911, #7168) is covered here; see docs/architecture/regression-port-ledger.md.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { readMetadataJsonPrefixWithSignature, statSignature } from './store.js'
import type { Session } from './session.js'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SidecarResult } from '@maudecode/talaria-web-contracts'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { str } from '../util.js'
import { withPendingUserTurn, withoutRunningTurnOutput } from './merge.js'
import { RunJournalWriter } from './journal.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json
const completedTurn = (messages: Json[]): SidecarResult<'chat.start'> => ({
  status: 'completed', messages, final_response: str(messages[messages.length - 1]?.content), error: null, result_status: 'completed', tool_limit_reached: false,
  usage: { prompt_tokens: 10, completion_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: {}, model: 'test-model', provider: 'test', compressed: false,
  agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [],
})

async function newSession(s: TestServer, body: Json = {}): Promise<Json> {
  const res = await post(s, '/api/session/new', body)
  expect(res.status).toBe(200)
  return (await json(res)).session as Json
}

/** New sessions stay in memory until their first message (Python `new_session`), so persist through the store. */
function writeMessages(s: TestServer, sid: string, messages: Json[]): void {
  const session = s.deps.sessionStore.get(sid)
  session.messages = messages
  s.deps.sessionStore.save(session)
}

describe('session lifecycle over HTTP', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())

  it('creates a session with the default workspace and lists it with the ETag contract', async () => {
    const session = await newSession(s)
    expect(String(session.session_id)).toMatch(/^[0-9a-f]{12}$/)
    expect(session.workspace).toBe(realpathSync(join(s.state, 'workspace')))
    // Python keeps a brand-new session in memory until its first message.
    expect(existsSync(join(s.state, 'sessions', `${String(session.session_id)}.json`))).toBe(false)
    writeMessages(s, String(session.session_id), [{ role: 'user', content: 'hi' }])

    const res = await s.get('/api/sessions')
    expect(res.status).toBe(200)
    const etag = res.headers.get('etag')
    expect(etag).toBeTruthy()
    const body = await json(res)
    expect((body.sessions as Json[]).map((r) => r.session_id)).toContain(session.session_id)
    expect(body.active_profile).toBe('default')
    expect(typeof body.server_time).toBe('number')

    const notModified = await s.get('/api/sessions', { headers: { 'if-none-match': etag ?? '' } })
    expect(notModified.status).toBe(304)
    expect(readFileSync(join(s.state, 'sessions', '_index.json'), 'utf8')).toContain(String(session.session_id))
  })

  it('validates session ids and reports unknown sessions as 404', async () => {
    expect((await s.get('/api/session?session_id=../etc')).status).toBe(404)
    expect((await s.get('/api/session?session_id=deadbeef0000')).status).toBe(404)
    const res = await post(s, '/api/session/rename', { session_id: 'deadbeef0000', title: 'x' })
    expect(res.status).toBe(404)
    expect(await json(res)).toEqual({ error: 'Session not found' })
  })

  it('renames, archives, pins with the configured cap, and moves between projects [py:test_issue2508_session_pin_cap.py::test_session_pin_endpoint_caps_pinned_sessions_at_three]', async () => {
    const a = await newSession(s)
    const sid = String(a.session_id)
    writeMessages(s, sid, [{ role: 'user', content: 'hi' }])
    let res = await post(s, '/api/session/rename', { session_id: sid, title: '  New title  ' })
    expect(res.status).toBe(200)
    expect(((await json(res)).session as Json).title).toBe('New title')

    res = await post(s, '/api/session/archive', { session_id: sid, archived: true })
    expect(res.status).toBe(200)
    let list = await json(await s.get('/api/sessions'))
    expect((list.sessions as Json[]).some((r) => r.session_id === sid)).toBe(false)
    expect(list.archived_count).toBeGreaterThanOrEqual(1)
    list = await json(await s.get('/api/sessions?include_archived=1'))
    expect((list.sessions as Json[]).some((r) => r.session_id === sid && r.archived === true)).toBe(true)
    await post(s, '/api/session/archive', { session_id: sid, archived: false })

    s.deps.settings.save({ pinned_sessions_limit: 1 })
    expect((await post(s, '/api/session/pin', { session_id: sid, pinned: true })).status).toBe(200)
    const b = await newSession(s)
    res = await post(s, '/api/session/pin', { session_id: b.session_id, pinned: true })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Up to 1 sessions can be pinned. Unpin one before pinning another.')
    expect((await post(s, '/api/session/pin', { session_id: sid, pinned: false })).status).toBe(200)
    // Two concurrent pins racing for the last slot: the quota check and save run as one serialized transaction, so
    // exactly one wins even when the first is parked on its session lock past the other's check.
    let releaseA: () => void = () => undefined
    const holdA = s.deps.sessionStore.withLock(sid, () => new Promise<void>((resolve) => { releaseA = resolve }))
    await new Promise((r) => setTimeout(r, 20))
    const pinA = post(s, '/api/session/pin', { session_id: sid, pinned: true })
    await new Promise((r) => setTimeout(r, 50))
    const pinB = post(s, '/api/session/pin', { session_id: b.session_id, pinned: true })
    await new Promise((r) => setTimeout(r, 50))
    releaseA()
    await holdA
    const [resA, resB] = await Promise.all([pinA, pinB])
    expect([resA.status, resB.status].sort()).toEqual([200, 400])
    const pinnedNow = ((await json(await s.get('/api/sessions'))).sessions as Json[]).filter((r) => r.pinned === true)
    expect(pinnedNow).toHaveLength(1)
    await post(s, '/api/session/pin', { session_id: sid, pinned: false })
    await post(s, '/api/session/pin', { session_id: b.session_id, pinned: false })

    res = await post(s, '/api/projects/create', { name: 'Proj', color: '#abc' })
    expect(res.status).toBe(200)
    const project = (await json(res)).project as Json
    res = await post(s, '/api/session/move', { session_id: sid, project_id: project.project_id })
    expect(res.status).toBe(200)
    expect(((await json(res)).session as Json).project_id).toBe(project.project_id)
    res = await post(s, '/api/session/move', { session_id: sid, project_id: 'missing' })
    expect(res.status).toBe(404)
    expect((await post(s, '/api/projects/delete', { project_id: project.project_id })).status).toBe(200)
    const detail = await json(await s.get(`/api/session?session_id=${sid}`))
    expect((detail.session as Json).project_id).toBeNull()
  })

  it('returns a bounded message window with the truncation markers', async () => {
    const a = await newSession(s)
    const sid = String(a.session_id)
    const messages: Json[] = []
    for (let i = 0; i < 12; i += 1) messages.push({ role: i % 2 ? 'assistant' : 'user', content: `m${i}`, timestamp: 1000 + i })
    writeMessages(s, sid, messages)
    const res = await s.get(`/api/session?session_id=${sid}&msg_limit=4`)
    expect(res.status).toBe(200)
    const session = (await json(res)).session as Json
    const got = session.messages as Json[]
    expect(got.map((m) => m.content)).toEqual(['m8', 'm9', 'm10', 'm11'])
    expect(session._messages_truncated).toBe(true)
    expect(session._messages_offset).toBe(8)
    expect(session._msg_limit_max).toBe(500)
    const before = (await json(await s.get(`/api/session?session_id=${sid}&msg_limit=4&msg_before=8`))).session as Json
    expect((before.messages as Json[]).map((m) => m.content)).toEqual(['m4', 'm5', 'm6', 'm7'])
  })

  it('truncates, undoes, retries, clears, and keeps a .bak when the file shrinks', async () => {
    const a = await newSession(s)
    const sid = String(a.session_id)
    writeMessages(s, sid, [
      { role: 'user', content: 'first' }, { role: 'assistant', content: 'one' },
      { role: 'user', content: 'second' }, { role: 'assistant', content: 'two' },
    ])
    let res = await post(s, '/api/session/undo', { session_id: sid })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ ok: true, removed_count: 2, removed_preview: 'second' })
    expect(existsSync(join(s.state, 'sessions', `${sid}.json.bak`))).toBe(true)

    res = await post(s, '/api/session/retry', { session_id: sid })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ ok: true, last_user_text: 'first', removed_count: 2 })
    expect(((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages).toEqual([])

    writeMessages(s, sid, [
      { role: 'user', content: 'a' }, { role: 'assistant', content: '', reasoning: 'think', tool_calls: [{ id: 't', name: 'read_file' }] },
      { role: 'tool', tool_call_id: 't', content: 'x' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' },
    ])
    res = await post(s, '/api/session/truncate', { session_id: sid, keep_count: 4 })
    expect(res.status).toBe(200)
    // The kept turns come back with the server's scenes, like the detail, so a client replacing its transcript keeps them.
    const kept = ((await json(res)).session as Json).messages as Json[]
    expect((kept.at(-1)?._anchor_activity_scene as Json | undefined)?.final_answer).toBe('b')
    res = await post(s, '/api/session/truncate', { session_id: sid, keep_count: 1 })
    expect(res.status).toBe(200)
    expect(((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages).toHaveLength(1)
    res = await post(s, '/api/session/truncate', { session_id: sid, keep_count: -1 })
    expect(res.status).toBe(400)
    res = await post(s, '/api/session/clear', { session_id: sid })
    expect(res.status).toBe(200)
    expect(((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages).toEqual([])
  })

  it('duplicates and branches sessions with parent lineage', async () => {
    const a = await newSession(s)
    const sid = String(a.session_id)
    writeMessages(s, sid, [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }, { role: 'user', content: 'z' }])
    let res = await post(s, '/api/session/duplicate', { session_id: sid })
    expect(res.status).toBe(200)
    const dup = (await json(res)).session as Json
    expect(dup.session_id).not.toBe(sid)
    expect(((await json(await s.get(`/api/session?session_id=${String(dup.session_id)}`))).session as Json).messages).toHaveLength(3)

    res = await post(s, '/api/session/branch', { session_id: sid, keep_count: 2, title: 'Branch' })
    expect(res.status).toBe(200)
    const branch = await json(res)
    expect(branch.parent_session_id).toBe(sid)
    expect(branch.title).toBe('Branch')
    const child = (await json(await s.get(`/api/session?session_id=${String(branch.session_id)}`))).session as Json
    expect(child.messages).toHaveLength(2)
    expect(child.parent_session_id).toBe(sid)
  })

  it('deletes a session, tombstones it, and prunes it from the index', async () => {
    const a = await newSession(s)
    const sid = String(a.session_id)
    writeMessages(s, sid, [{ role: 'user', content: 'bye' }])
    const res = await post(s, '/api/session/delete', { session_id: sid })
    expect(res.status).toBe(200)
    // No sidecar in this harness: the state.db cleanup cannot run, and the response says so (Python reported the
    // same when the store was unreachable) instead of claiming a cleanup that never happened.
    expect(await json(res)).toEqual({ ok: true, state_db_cleanup_failed: true })
    expect(existsSync(join(s.state, 'sessions', `${sid}.json`))).toBe(false)
    expect((await s.get(`/api/session?session_id=${sid}`)).status).toBe(404)
    expect(readFileSync(join(s.state, 'sessions', '_index.json'), 'utf8')).not.toContain(sid)
    const tomb = JSON.parse(readFileSync(join(s.state, 'sessions', '_deleted_webui_sessions.json'), 'utf8')) as Json
    expect(tomb.version).toBe(1)
    expect(tomb.ids).toContain(sid)
    // Python answers a repeat delete idempotently.
    expect((await post(s, '/api/session/delete', { session_id: sid })).status).toBe(200)
  })

  it('imports, searches, and reports status and usage', async () => {
    let res = await post(s, '/api/session/import', { title: 'Imported', messages: [{ role: 'user', content: 'needle in the hay' }, { role: 'assistant', content: 'found' }] })
    expect(res.status).toBe(200)
    const imported = (await json(res)).session as Json
    expect(imported.title).toBe('Imported')
    res = await s.get('/api/sessions/search?q=needle')
    expect(res.status).toBe(200)
    const found = await json(res)
    expect((found.sessions as Json[]).map((r) => r.session_id)).toContain(imported.session_id)
    res = await s.get(`/api/session/status?session_id=${String(imported.session_id)}`)
    expect(res.status).toBe(200)
    expect((await json(res)).session_id).toBe(imported.session_id)
    res = await s.get(`/api/session/usage?session_id=${String(imported.session_id)}`)
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })
    expect((await s.get('/api/session/status')).status).toBe(400)
  })

  it('reports streaming only for a live runtime stream on detail, list, search, status and mutation replies (TAL-312)', async () => {
    const sid = String((await newSession(s)).session_id)
    writeMessages(s, sid, [{ role: 'user', content: 'streamprobe question' }, { role: 'assistant', content: 'ok' }])
    // A dead run: the persisted id is not a live stream, and a fresh pending prompt keeps the stale sweep from clearing it.
    const stored = s.deps.sessionStore.get(sid)
    stored.title = 'Streamprobe'
    stored.active_stream_id = 'streamprobe1'
    stored.pending_user_message = 'still pending'
    stored.pending_started_at = Date.now() / 1000
    s.deps.sessionStore.save(stored)
    const payloads = async (): Promise<Json[]> => {
      const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
      const row = ((await json(await s.get('/api/sessions'))).sessions as Json[]).find((r) => r.session_id === sid)!
      const hit = ((await json(await s.get('/api/sessions/search?q=streamprobe'))).sessions as Json[]).find((r) => r.session_id === sid)!
      const status = await json(await s.get(`/api/session/status?session_id=${sid}`))
      const pinned = (await json(await post(s, '/api/session/pin', { session_id: sid, pinned: false }))).session as Json
      return [detail, row, hit, status, pinned]
    }
    for (const payload of await payloads()) expect(payload).toMatchObject({ is_streaming: false, active_stream_id: null, read_only: false })
    expect((await payloads())[3]?.agent_running).toBe(false)
    s.deps.registry.liveIds.add('streamprobe1')
    try {
      for (const payload of await payloads()) expect(payload).toMatchObject({ is_streaming: true, active_stream_id: 'streamprobe1' })
      expect((await payloads())[3]?.agent_running).toBe(true)
    } finally {
      s.deps.registry.liveIds.delete('streamprobe1')
    }
  })

  it('marks persisted read-only and subagent sessions read_only on every payload (TAL-312)', async () => {
    const readOnly = String((await newSession(s)).session_id)
    const subagent = String((await newSession(s)).session_id)
    for (const [sid, apply] of [[readOnly, (x: Session) => { x.read_only = true }], [subagent, (x: Session) => { x.source_tag = 'subagent' }]] as const) {
      const stored = s.deps.sessionStore.get(sid)
      apply(stored)
      stored.title = 'Roprobe'
      stored.messages = [{ role: 'user', content: 'roprobe' }, { role: 'assistant', content: 'ok' }]
      s.deps.sessionStore.save(stored)
      const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
      const hit = ((await json(await s.get('/api/sessions/search?q=roprobe'))).sessions as Json[]).find((r) => r.session_id === sid)!
      const status = await json(await s.get(`/api/session/status?session_id=${sid}`))
      for (const payload of [detail, hit, status]) expect(payload, sid).toMatchObject({ read_only: true, is_streaming: false })
      expect(detail).not.toHaveProperty('is_read_only')
      // The server refuses to branch either, and says so up front.
      for (const payload of [detail, hit]) expect(payload.can_branch, sid).toBe(false)
      expect((await post(s, '/api/session/branch', { session_id: sid })).status, sid).toBeGreaterThanOrEqual(400)
      // Pin, archive and duplicate refuse only the subagent child; each flag matches its endpoint's outcome.
      const allowed = sid === readOnly
      for (const payload of [detail, hit]) expect(payload, sid).toMatchObject({ can_pin: allowed, can_archive: allowed, can_duplicate: allowed })
      for (const [path, body] of [['/api/session/pin', { session_id: sid, pinned: false }], ['/api/session/archive', { session_id: sid, archived: false }], ['/api/session/duplicate', { session_id: sid }]] as const) {
        expect((await post(s, path, body)).status === 200, `${sid} ${path}`).toBe(allowed)
      }
    }
  })

  it('offers branching exactly where the branch gate allows it, including a read-only cron run (TAL-312)', async () => {
    const writable = String((await newSession(s)).session_id)
    const cron = String((await newSession(s)).session_id)
    const stored = s.deps.sessionStore.get(cron)
    stored.read_only = true
    stored.source_tag = 'cron'
    s.deps.sessionStore.save(stored)
    for (const sid of [writable, cron]) {
      writeMessages(s, sid, [{ role: 'user', content: 'branchprobe' }, { role: 'assistant', content: 'ok' }])
      const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
      expect(detail.can_branch, sid).toBe(true)
      expect((await post(s, '/api/session/branch', { session_id: sid })).status, sid).toBe(200)
    }
  })

  it('stores composer drafts with monotonic versions and 409 on stale writes', async () => {
    const a = await newSession(s)
    const sid = String(a.session_id)
    let res = await post(s, '/api/session/draft', { session_id: sid, text: 'hello', draft_version: '10' })
    expect(res.status).toBe(200)
    let body = await json(res)
    expect(body.draft).toEqual({ text: 'hello', files: [] })
    expect(body.draft_version).toBe('10')
    expect(existsSync(join(s.state, 'sessions', '_drafts', `${sid}.json`))).toBe(true)

    res = await post(s, '/api/session/draft', { session_id: sid, text: 'older', draft_version: '5' })
    expect(res.status).toBe(409)
    body = await json(res)
    expect(body.error).toBe('Composer draft changed in another request')
    expect(body.draft_version).toBe('10')

    res = await post(s, '/api/session/draft', { session_id: sid, text: 'hello', draft_version: '10' })
    expect(res.status).toBe(200)
    expect((await json(res)).unchanged).toBe(true)

    res = await s.get(`/api/session/draft?session_id=${sid}`)
    expect(res.status).toBe(200)
    expect((await json(res)).draft).toEqual({ text: 'hello', files: [] })
    expect((await post(s, '/api/session/draft', { session_id: sid, draft_version: true })).status).toBe(400)
    expect((await post(s, '/api/session/draft', { session_id: 'deadbeef0000', text: 'x' })).status).toBe(404)
  })

  it('creates, reads, and revokes shares with the noindex header', async () => {
    const a = await newSession(s)
    const sid = String(a.session_id)
    writeMessages(s, sid, [{ role: 'user', content: 'share me' }, { role: 'assistant', content: 'ok' }])
    let res = await post(s, '/api/share/create', { session_id: sid })
    expect(res.status).toBe(200)
    const share = (await json(res)).share as Json
    expect(String(share.token)).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(share.message_count).toBe(2)
    res = await s.get(`/api/share/${String(share.token)}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    const read = (await json(res)).share as Json
    expect((read.messages as Json[]).map((m) => m.content)).toEqual(['share me', 'ok'])
    res = await post(s, '/api/share/revoke', { session_id: sid })
    expect(res.status).toBe(200)
    expect((await s.get(`/api/share/${String(share.token)}`)).status).toBe(404)
    expect((await s.get('/api/share/../etc')).status).toBe(404)
  })

  it('cleans up zero-message sessions and toggles yolo', async () => {
    const a = await newSession(s)
    writeMessages(s, String(a.session_id), [])
    const res = await post(s, '/api/sessions/cleanup_zero_message', {})
    expect(res.status).toBe(200)
    expect(((await json(res)).cleaned as number)).toBeGreaterThanOrEqual(1)
    expect((await s.get(`/api/session?session_id=${String(a.session_id)}`)).status).toBe(404)
    const b = await newSession(s)
    expect(await json(await s.get(`/api/session/yolo?session_id=${String(b.session_id)}`))).toEqual({ yolo_enabled: false })
    expect((await post(s, '/api/session/yolo', { session_id: b.session_id, enabled: true })).status).toBe(200)
    expect(await json(await s.get(`/api/session/yolo?session_id=${String(b.session_id)}`))).toEqual({ yolo_enabled: true })
  })
})

describe('session store disk freshness', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())

  it('a cached session whose file was deleted underneath it is evicted and never recreated by a later mutation', async () => {
    const sid = String((await newSession(s)).session_id)
    const cached = s.deps.sessionStore.get(sid)
    cached.title = 'persisted'
    s.deps.sessionStore.save(cached)
    rmSync(cached.path ?? '')
    expect(() => s.deps.sessionStore.get(sid)).toThrow()
    expect(() => s.deps.sessionStore.get(sid, { metadataOnly: true })).toThrow()
    expect((await post(s, '/api/session/rename', { session_id: sid, title: 'ghost' })).status).toBe(404)
    expect(existsSync(cached.path ?? '')).toBe(false)
  })

  it('a metadata-only read is signed by the inode it read, so a file replaced meanwhile is reloaded', async () => {
    const sid = String((await newSession(s)).session_id)
    const full = s.deps.sessionStore.get(sid)
    full.title = 'old owner'
    s.deps.sessionStore.save(full)
    const path = full.path ?? ''
    const before = readMetadataJsonPrefixWithSignature(path)
    // Atomic replacement after the descriptor was opened: the signature must describe the old inode, not the new file.
    const replacement = { ...(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>), title: 'new owner' }
    writeFileSync(`${path}.tmp`, JSON.stringify(replacement))
    renameSync(`${path}.tmp`, path)
    expect(before.prefix).toContain('old owner')
    expect(before.signature).not.toBe(statSignature(path))
    s.deps.sessionStore.sessions.delete(sid)
    const stub = s.deps.sessionStore.loadMetadataOnly(sid)
    expect(stub?.title).toBe('new owner')
    expect(stub?.sidecarLoadedSignature).toBe(statSignature(path))
  })

  it('reloads a cached session whose read identity is unknown instead of trusting the stale snapshot', async () => {
    const sid = String((await newSession(s)).session_id)
    const cached = s.deps.sessionStore.get(sid)
    cached.title = 'cached title'
    s.deps.sessionStore.save(cached)
    // Another process replaces the transcript; the cached read happened while the file was changing.
    const doc = JSON.parse(readFileSync(cached.path ?? '', 'utf8')) as Record<string, unknown>
    doc.title = 'written by the Agent'
    writeFileSync(cached.path ?? '', JSON.stringify(doc))
    cached.sidecarLoadedSignature = null
    expect(s.deps.sessionStore.get(sid).title).toBe('written by the Agent')
    expect(s.deps.sessionStore.get(sid).sidecarLoadedSignature).not.toBeNull()
  })
})

describe('projects, workspaces, and files over HTTP', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())

  it('projects require a name, validate colours, and list per profile [py:test_issue1614_project_profile_filtering.py::test_profile_field_on_project_dict_default_create]', async () => {
    expect((await post(s, '/api/projects/create', { name: '   ' })).status).toBe(400)
    let res = await post(s, '/api/projects/create', { name: 'Alpha', color: 'red' })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Invalid color format')
    res = await post(s, '/api/projects/create', { name: 'Alpha', color: '#ff0000' })
    expect(res.status).toBe(200)
    const project = (await json(res)).project as Json
    expect(project.profile).toBe('default')
    res = await post(s, '/api/projects/rename', { project_id: project.project_id, name: 'Beta', color: null })
    expect(res.status).toBe(200)
    expect(((await json(res)).project as Json).color).toBeNull()
    const list = await json(await s.get('/api/projects'))
    expect((list.projects as Json[]).map((p) => p.name)).toEqual(['Beta'])
    expect((await post(s, '/api/projects/rename', { project_id: 'nope', name: 'x' })).status).toBe(404)
    const raw = JSON.parse(readFileSync(join(s.state, 'projects.json'), 'utf8')) as Json[]
    expect(raw[0]?.name).toBe('Beta')
  })

  it('workspaces strip pasted quotes, reject duplicates and system paths, reorder, and rename', async () => {
    const dir = join(realpathSync(s.state), 'proj')
    mkdirSync(dir)
    let res = await post(s, '/api/workspaces/add', { path: `"${dir}"` })
    expect(res.status).toBe(200)
    let list = (await json(res)).workspaces as Json[]
    expect(list.map((w) => w.path)).toContain(dir)
    expect(list.find((w) => w.path === dir)?.name).toBe('proj')
    res = await post(s, '/api/workspaces/add', { path: dir })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Workspace already in list')
    res = await post(s, '/api/workspaces/add', { path: '/etc' })
    expect(res.status).toBe(400)
    res = await post(s, '/api/workspaces/add', { path: join(s.state, 'missing') })
    expect(res.status).toBe(400)
    res = await post(s, '/api/workspaces/add', { path: join(realpathSync(s.state), 'made'), create: true })
    expect(res.status).toBe(200)
    expect(existsSync(join(realpathSync(s.state), 'made'))).toBe(true)

    res = await post(s, '/api/workspaces/reorder', { paths: [join(realpathSync(s.state), 'made'), dir] })
    expect(res.status).toBe(200)
    list = (await json(res)).workspaces as Json[]
    expect(list.slice(0, 2).map((w) => w.path)).toEqual([join(realpathSync(s.state), 'made'), dir])
    res = await post(s, '/api/workspaces/rename', { path: dir, name: 'Renamed' })
    expect(res.status).toBe(200)
    res = await s.get('/api/workspaces')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect((body.workspaces as Json[]).find((w) => w.path === dir)?.name).toBe('Renamed')
    expect(body.terminal_remote_backend).toBe(false)
    res = await post(s, '/api/workspaces/remove', { path: dir })
    expect(((await json(res)).workspaces as Json[]).some((w) => w.path === dir)).toBe(false)
    const suggest = await json(await s.get(`/api/workspaces/suggest?prefix=${encodeURIComponent(join(realpathSync(s.state), 'ma'))}`))
    expect(suggest.suggestions).toContain(join(realpathSync(s.state), 'made'))
  })

  it('file operations stay inside the workspace and reject symlink escapes', async () => {
    const ws = realpathSync(join(s.state, 'workspace'))
    const session = await newSession(s, { workspace: ws })
    const sid = String(session.session_id)
    let res = await post(s, '/api/file/create', { session_id: sid, path: 'notes/a.txt', content: 'hello' })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true, path: 'notes/a.txt' })
    expect((await post(s, '/api/file/create', { session_id: sid, path: 'notes/a.txt', content: '' })).status).toBe(400)
    res = await s.get(`/api/list?session_id=${sid}&path=notes`)
    expect(res.status).toBe(200)
    const listing = await json(res)
    expect((listing.entries as Json[]).map((e) => e.name)).toEqual(['a.txt'])
    expect(listing.workspace).toBe(ws)
    res = await s.get(`/api/file?session_id=${sid}&path=notes/a.txt`)
    expect(res.status).toBe(200)
    expect((await json(res)).content).toBe('hello')
    res = await post(s, '/api/file/save', { session_id: sid, path: 'notes/a.txt', content: 'changed' })
    expect(res.status).toBe(200)
    expect(readFileSync(join(ws, 'notes', 'a.txt'), 'utf8')).toBe('changed')
    expect((await post(s, '/api/file/create-dir', { session_id: sid, path: 'sub' })).status).toBe(200)
    res = await post(s, '/api/file/rename', { session_id: sid, path: 'notes/a.txt', new_name: 'b.txt' })
    expect(res.status).toBe(200)
    expect((await json(res)).new_path).toBe('notes/b.txt')
    res = await post(s, '/api/file/move', { session_id: sid, path: 'notes/b.txt', destination: 'sub' })
    expect(res.status).toBe(200)
    expect((await json(res)).new_path).toBe('sub/b.txt')
    expect((await post(s, '/api/file/move', { session_id: sid, path: 'sub', dest_dir: 'sub' })).status).toBe(400)

    expect((await s.get(`/api/file?session_id=${sid}&path=../../etc/passwd`)).status).toBe(404)
    expect((await post(s, '/api/file/save', { session_id: sid, path: '../outside.txt', content: 'x' })).status).toBe(400)
    expect(existsSync(join(s.state, 'outside.txt'))).toBe(false)
    symlinkSync(s.state, join(ws, 'escape'))
    expect((await post(s, '/api/file/delete', { session_id: sid, path: 'escape' })).status).toBe(400)
    expect((await s.get(`/api/file?session_id=${sid}&path=escape/settings.json`)).status).toBe(404)
    expect((await s.get(`/api/list?session_id=${sid}&path=escape`)).status).toBe(404)

    res = await post(s, '/api/file/delete', { session_id: sid, path: 'sub' })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Set recursive=true to delete directories')
    expect((await post(s, '/api/file/delete', { session_id: sid, path: 'sub', recursive: true })).status).toBe(200)
    expect(readdirSync(ws)).not.toContain('sub')
    expect((await s.get('/api/list?session_id=deadbeef0000')).status).toBe(404)
  })

  it('file operations keep the Python validation contract: require(), Office guard, listing timestamps, launcher errors', async () => {
    const ws = realpathSync(join(s.state, 'workspace'))
    const sid = String((await newSession(s, { workspace: ws })).session_id)
    // `require()` rejects empty strings and names every missing field.
    let res = await post(s, '/api/file/create', { session_id: sid, path: '' })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Missing required field(s): path')
    res = await post(s, '/api/file/rename', { session_id: '', path: 'x', new_name: '' })
    expect((await json(res)).error).toBe('Missing required field(s): session_id, new_name')
    res = await post(s, '/api/file/move', { session_id: sid, path: 'x' })
    expect((await json(res)).error).toBe('Missing required field(s): dest_dir')
    // `recursive` is truthy-checked like `body.get("recursive")`.
    mkdirSync(join(ws, 'rdir'))
    expect((await post(s, '/api/file/delete', { session_id: sid, path: 'rdir', recursive: 1 })).status).toBe(200)
    // Office documents are refused by the text save.
    writeFileSync(join(ws, 'doc.docx'), 'PK\u0003\u0004binary')
    res = await post(s, '/api/file/save', { session_id: sid, path: 'doc.docx', content: 'x' })
    expect(res.status).toBe(400)
    // `/api/file/office-save` was dropped with TAL-245: the refusal must not point clients at a 404.
    expect((await json(res)).error).toBe('Office documents cannot be saved from the Web UI')
    expect(readFileSync(join(ws, 'doc.docx'), 'utf8')).toBe('PK\u0003\u0004binary')
    // Listing timestamps are decimal strings.
    const listing = await json(await s.get(`/api/list?session_id=${sid}`))
    const doc = (listing.entries as Json[]).find((e) => e.name === 'doc.docx')
    expect(typeof doc?.mtime_ns).toBe('string')
    // A NUL byte in a path is invalid input, not a lookup miss.
    expect((await post(s, '/api/file/create', { session_id: sid, path: 'a\u0000b' })).status).toBe(400)
    // A workspace the trust policy rejects makes the listing a 404 with the policy text (Python `_handle_list`).
    const stray = mkdtempSync(join(tmpdir(), 'talaria-stray-'))
    const strayed = s.deps.sessionStore.get(sid)
    strayed.workspace = stray
    s.deps.sessionStore.save(strayed)
    res = await s.get(`/api/list?session_id=${sid}`)
    expect(res.status).toBe(404)
    expect(String((await json(res)).error)).toContain(stray)
    rmSync(stray, { recursive: true, force: true })
    strayed.workspace = ws
    s.deps.sessionStore.save(strayed)
  })
})

describe('session detail transcript cursor (TAL-316)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
  })
  afterAll(() => s.close())

  const detail = async (sid: string, query = ''): Promise<Json> => (await json(await s.get(`/api/session?session_id=${sid}&messages=1${query}`))).session as Json
  const contents = (session: Json): unknown[] => (session.messages as Json[]).map((m) => m.content)

  /** A session with one settled turn whose next run is held mid-turn (prose, tool, prose) with its rows partly in state.db. */
  async function runningTurn(): Promise<{ sid: string; streamId: string; release: () => void }> {
    const sid = String((await newSession(s)).session_id)
    writeMessages(s, sid, [{ role: 'user', content: 'earlier', timestamp: 1000 }, { role: 'assistant', content: 'earlier reply', timestamp: 1001 }])
    let release: () => void = () => undefined
    sidecar.respond('chat.start', (params, emit) => new Promise((resolve) => {
      emit({ event: 'token', data: { text: 'Reading.' } })
      emit({ event: 'tool', data: { event_type: 'tool.started', name: 'read_file', args: {}, tid: 't1' } })
      emit({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'read_file', tid: 't1', preview: 'A' } })
      emit({ event: 'token', data: { text: 'Done' } })
      release = () => { resolve(completedTurn([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 't1', content: 'A' }, { role: 'assistant', content: 'Done' }])) }
    }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'read it' }))
    const streamId = String(start.stream_id)
    const startedAt = Number(start.pending_started_at)
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'token' && (f.data as Json).text === 'Done')
    // The Agent has already written the prompt, the first prose segment and the tool round to state.db.
    const db = new DatabaseSync(join(s.state, 'state.db'))
    db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL, tool_calls TEXT, tool_call_id TEXT, tool_name TEXT)')
    db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)').run(sid, 'webui', 1000)
    const rows: [string, string, number][] = [['user', 'earlier', 1000], ['assistant', 'earlier reply', 1001], ['user', 'read it', startedAt + 0.5], ['assistant', 'Reading.', startedAt + 1], ['tool', 'A', startedAt + 2]]
    for (const [role, content, ts] of rows) db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(sid, role, content, ts)
    db.close()
    return { sid, streamId, release }
  }

  it('omits a journaled running turn\'s output, keeps its prompt, and resuming from the cursor renders each segment once', async () => {
    const { sid, streamId, release } = await runningTurn()
    const session = await detail(sid)
    expect(contents(session)).toEqual(['earlier', 'earlier reply', 'read it'])
    expect(session.transcript_seq).toEqual({ stream_id: streamId, seq: 0 })
    expect(session.message_count).toBe(3)
    // Every window agrees: the omission applies before windowing.
    const window = await detail(sid, '&msg_limit=2')
    expect(window.transcript_seq).toEqual({ stream_id: streamId, seq: 0 })
    expect(contents(window)).toEqual(['earlier reply', 'read it'])
    expect(window.message_count).toBe(3)
    const older = await detail(sid, '&msg_limit=2&msg_before=1')
    expect(contents(older)).toEqual(['earlier'])
    // Resuming from the stated cursor delivers the running turn once, in order.
    const seq = (session.transcript_seq as { seq: number }).seq
    const frames = await s.sse(`/api/chat/stream?stream_id=${streamId}&after_seq=${String(seq)}`, (f) => f.event === 'token' && (f.data as Json).text === 'Done')
    expect(frames.filter((f) => ['token', 'tool', 'tool_complete'].includes(f.event)).map((f) => `${f.event}:${String((f.data as Json).text ?? (f.data as Json).name)}`))
      .toEqual(['token:Reading.', 'tool:read_file', 'tool_complete:read_file', 'token:Done'])
    const ids = frames.map((f) => f.id).filter(Boolean)
    expect(new Set(ids).size).toBe(ids.length)
    release()
    await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'stream_end')
    // A settled session states no cursor and returns its whole transcript.
    const settled = await detail(sid)
    expect(settled.transcript_seq).toBeNull()
    expect(contents(settled)).toContain('Done')
  })

  it('returns the persisted transcript unchanged and no cursor when the running turn has no journal', async () => {
    const { sid, release } = await runningTurn()
    const findRunSummary = vi.spyOn(s.deps.journal, 'findRunSummary').mockReturnValue(null)
    try {
      const session = await detail(sid)
      expect(session.transcript_seq).toBeNull()
      expect(contents(session)).toEqual(['earlier', 'earlier reply', 'read it', 'Reading.', 'A'])
    } finally {
      findRunSummary.mockRestore()
      release()
    }
  })

  it('states no cursor and keeps the persisted turn when its journal missed a frame', async () => {
    const append = Object.getOwnPropertyDescriptor(RunJournalWriter.prototype, 'appendSseEvent')?.value as (this: RunJournalWriter, event: string, data: unknown) => ReturnType<RunJournalWriter['appendSseEvent']>
    const failing = vi.spyOn(RunJournalWriter.prototype, 'appendSseEvent').mockImplementation(function (this: RunJournalWriter, event: string, data: unknown) {
      if (event === 'tool') throw new Error('disk full')
      return append.call(this, event, data)
    })
    let turn: Awaited<ReturnType<typeof runningTurn>> | null = null
    try {
      turn = await runningTurn()
    } finally {
      failing.mockRestore()
    }
    try {
      const session = await detail(turn.sid)
      expect(session.transcript_seq).toBeNull()
      expect(contents(session)).toEqual(['earlier', 'earlier reply', 'read it', 'Reading.', 'A'])
    } finally {
      turn.release()
    }
  })

  it('an idle session states no cursor', async () => {
    const sid = String((await newSession(s)).session_id)
    writeMessages(s, sid, [{ role: 'user', content: 'hi', timestamp: 10 }, { role: 'assistant', content: 'hello', timestamp: 11 }])
    const session = await detail(sid)
    expect(session.transcript_seq).toBeNull()
    expect(contents(session)).toEqual(['hi', 'hello'])
  })

  it('keeps a checkpointed prompt and the server\'s steer rows, and drops the rest of the turn', () => {
    const turn = { localCount: 4, turnId: 'run1', startedAt: 100, activeTurnToken: 'run1:100' }
    const rows = [
      { role: 'user', content: 'earlier', timestamp: 1 }, { role: 'assistant', content: 'earlier reply', timestamp: 2 },
      { role: 'user', content: 'prompt', timestamp: 100, _turn_id: 'run1', _active_turn_token: 'run1:100' },
      { role: 'user', content: 'steer', timestamp: 103, _turn_id: 'run1', _steer: { steer_id: 's1' } },
      { role: 'user', content: 'prompt', timestamp: 101 }, { role: 'assistant', content: 'partial', timestamp: 102 },
    ]
    expect(withoutRunningTurnOutput(rows, turn).map((m) => m.content)).toEqual(['earlier', 'earlier reply', 'prompt', 'steer'])
    // Deferred save: no checkpointed prompt, so the turn starts at its first state.db row past the sidecar.
    const deferred = [rows[0]!, rows[1]!, rows[4]!, rows[5]!]
    expect(withoutRunningTurnOutput(deferred, { ...turn, localCount: 2 }).map((m) => m.content)).toEqual(['earlier', 'earlier reply', 'prompt'])
    // Nothing of the turn persisted yet: the transcript is unchanged.
    expect(withoutRunningTurnOutput([rows[0]!, rows[1]!], { ...turn, localCount: 2 })).toHaveLength(2)
  })
})

describe('session detail keeps the running turn\'s prompt (TAL-368)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
  })
  afterAll(() => s.close())

  const detail = async (sid: string, query = ''): Promise<Json> => (await json(await s.get(`/api/session?session_id=${sid}&messages=1${query}`))).session as Json
  const users = (session: Json): Json[] => (session.messages as Json[]).filter((m) => m.role === 'user')

  /** A deferred-save turn held after its first token; the Agent has written nothing to state.db. */
  async function heldTurn(message: string, history: Json[], attachments?: Json[]): Promise<{ sid: string; streamId: string; startedAt: number; release: () => void }> {
    const sid = String((await newSession(s)).session_id)
    writeMessages(s, sid, history)
    let release: () => void = () => undefined
    sidecar.respond('chat.interrupt', () => ({ ok: true }))
    sidecar.respond('chat.start', (params, emit, opts) => new Promise((resolve) => {
      emit({ event: 'token', data: { text: 'Agent is still working.' } })
      const turn = [{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'Agent is still working.' }]
      release = () => { resolve(completedTurn(turn)) }
      opts.signal?.addEventListener('abort', () => { resolve({ ...completedTurn(turn.slice(0, 1)), status: 'cancelled' }) })
    }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message, ...(attachments ? { attachments } : {}) }))
    const streamId = String(start.stream_id)
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'token')
    return { sid, streamId, startedAt: Number(start.pending_started_at), release }
  }

  const history = [{ role: 'user', content: 'continue', timestamp: 1000 }, { role: 'assistant', content: 'earlier reply', timestamp: 1001 }]

  it('shows the pending prompt exactly once, last, in full and windowed reads, and settles to one canonical row', async () => {
    const { sid, streamId, release } = await heldTurn('Unique pending follow-up', history, [{ name: 'notes.txt', path: '/tmp/notes.txt', mime: 'text/plain' }])
    expect(s.deps.sessionStore.get(sid).messages).toHaveLength(2)
    for (const session of [await detail(sid), await detail(sid, '&msg_limit=1')]) {
      const last = (session.messages as Json[]).at(-1)
      expect(last).toMatchObject({ role: 'user', content: 'Unique pending follow-up', _turn_id: streamId, _active_turn_user: true })
      expect(JSON.stringify(last?.attachments)).toContain('notes.txt')
      expect(users(session).filter((m) => m.content === 'Unique pending follow-up')).toHaveLength(1)
      expect(session.message_count).toBe(3)
      expect(session.transcript_seq).toEqual({ stream_id: streamId, seq: 0 })
    }
    // The projection is a read: deferred save still holds the prompt back from the sidecar.
    expect(s.deps.sessionStore.get(sid).messages).toHaveLength(2)
    release()
    await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'stream_end')
    const res = await s.get(`/api/session?session_id=${sid}&messages=1`)
    expect(res.status, await res.clone().text()).toBe(200)
    const settled = users((await json(res)).session as Json)
    expect(settled.map((m) => m.content)).toEqual(['continue', 'Unique pending follow-up'])
    expect(settled[1]?.attachments).toEqual([{ name: 'notes.txt', path: '/tmp/notes.txt', mime: 'text/plain' }])
    expect(settled.some((m) => m._active_turn_user)).toBe(false)
  })

  it('keeps a repeated prompt distinct from identical older text', async () => {
    const { sid, release } = await heldTurn('continue', history)
    try {
      const session = await detail(sid)
      expect(users(session).map((m) => m.content)).toEqual(['continue', 'continue'])
      expect(users(session)[1]?._active_turn_user).toBe(true)
    } finally {
      release()
    }
  })

  it('keeps the Agent\'s state.db prompt once, stamped as the running turn with its attachments', async () => {
    const { sid, streamId, startedAt, release } = await heldTurn('from state db', history, [{ name: 'plan.md', path: '/tmp/plan.md', mime: 'text/markdown' }])
    const db = new DatabaseSync(join(s.state, 'state.db'))
    db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL, tool_calls TEXT, tool_call_id TEXT, tool_name TEXT)')
    db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)').run(sid, 'webui', 1000)
    for (const [role, content, ts] of [['user', 'continue', 1000], ['assistant', 'earlier reply', 1001], ['user', '[Workspace::v1: /tmp/ws]\nfrom state db', startedAt + 0.5]] as const) db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(sid, role, content, ts)
    db.close()
    try {
      const prompts = users(await detail(sid))
      expect(prompts.map((m) => m.content)).toEqual(['continue', 'from state db'])
      expect(prompts[1]).toMatchObject({ _turn_id: streamId, _active_turn_user: true, attachments: [{ name: 'plan.md', path: '/tmp/plan.md', mime: 'text/markdown' }] })
      // Without a journal the persisted rows stand as they are, still with one prompt.
      const findRunSummary = vi.spyOn(s.deps.journal, 'findRunSummary').mockReturnValue(null)
      try {
        expect(users(await detail(sid)).map((m) => m.content)).toEqual(['continue', 'from state db'])
      } finally {
        findRunSummary.mockRestore()
      }
    } finally {
      release()
    }
  })

  it('keeps the prompt in a limited window of a long running turn without a journal', async () => {
    const { sid, streamId, startedAt, release } = await heldTurn('long degraded run', history)
    const db = new DatabaseSync(join(s.state, 'state.db'))
    db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL, tool_calls TEXT, tool_call_id TEXT, tool_name TEXT)')
    db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)').run(sid, 'webui', 1000)
    for (const [role, content, ts] of [['user', 'continue', 1000], ['assistant', 'earlier reply', 1001], ['user', 'long degraded run', startedAt + 0.1], ['assistant', 'step one', startedAt + 1], ['assistant', 'step two', startedAt + 2], ['assistant', 'step three', startedAt + 3]] as const) db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(sid, role, content, ts)
    db.close()
    const findRunSummary = vi.spyOn(s.deps.journal, 'findRunSummary').mockReturnValue(null)
    try {
      const window = await detail(sid, '&msg_limit=1')
      expect((window.messages as Json[]).map((m) => m.content)).toEqual(['long degraded run', 'step one', 'step two', 'step three'])
      expect((window.messages as Json[])[0]).toMatchObject({ _turn_id: streamId, _active_turn_user: true })
      expect(window._messages_offset).toBe(2)
      // The older page ends before the prompt, so the prompt is never delivered twice.
      expect((await detail(sid, '&msg_limit=10&msg_before=2')).messages as Json[]).toHaveLength(2)
    } finally {
      findRunSummary.mockRestore()
      release()
    }
  })

  it('projects the prompt without a journal, and a cancelled turn settles to one row with its attachments', async () => {
    const { sid, streamId } = await heldTurn('cancel me', history, [{ name: 'cat.png', path: '/tmp/cat.png', mime: 'image/png' }])
    const findRunSummary = vi.spyOn(s.deps.journal, 'findRunSummary').mockReturnValue(null)
    try {
      const session = await detail(sid)
      expect(session.transcript_seq).toBeNull()
      expect(users(session).map((m) => m.content)).toEqual(['continue', 'cancel me'])
    } finally {
      findRunSummary.mockRestore()
    }
    expect((await json(await s.get(`/api/chat/cancel?stream_id=${streamId}`))).cancelled).toBe(true)
    await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'cancel')
    const settled = users(await detail(sid))
    expect(settled.map((m) => m.content)).toEqual(['continue', 'cancel me'])
    expect(JSON.stringify(settled[1]?.attachments)).toContain('cat.png')
    expect(settled[1]?._active_turn_user).toBeUndefined()
  })

  it('projects an attachment-only prompt ahead of the turn\'s first Agent row', () => {
    const turn = { localCount: 2, turnId: 'run1', startedAt: 100, activeTurnToken: 'run1:100', prompt: { role: 'user', content: '', attachments: [{ name: 'a.png' }] } }
    const rows = [{ role: 'user', content: 'earlier', timestamp: 1 }, { role: 'assistant', content: 'reply', timestamp: 2 }]
    expect(withPendingUserTurn(rows, turn).at(-1)).toMatchObject({ role: 'user', content: '', attachments: [{ name: 'a.png' }] })
    // An Agent row of the turn already past the sidecar: the prompt opens the turn ahead of it.
    const withOutput = [...rows, { role: 'assistant', content: 'partial', timestamp: 101 }]
    expect(withPendingUserTurn(withOutput, turn).map((m) => m.content)).toEqual(['earlier', 'reply', '', 'partial'])
  })
})
