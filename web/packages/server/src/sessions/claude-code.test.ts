import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { lstat, open, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { ClaudeCodeSessionSource } from './claude-code.js'

type Json = Record<string, unknown>
const json = async (res: Response): Promise<Json> => (await res.json()) as Json
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const line = (v: unknown): string => JSON.stringify(v)
const turn = (content: string): string => line({ type: 'user', message: { role: 'user', content } }) + '\n'

vi.mock('node:fs', { spy: true })
vi.mock('node:fs/promises', { spy: true })

/** Every path under `root` that the sync or async fs calls touched, relative to it (the root itself is `''`). */
function fsCalls(root: string): { dirReads: string[]; stats: string[]; reads: string[] } {
  const under = (...fns: unknown[]): string[] => fns.flatMap((fn) => (fn as Mock).mock.calls.map(([path]) => String(path)))
    .filter((path) => path.startsWith(root)).map((path) => relative(root, path)).sort()
  return { dirReads: under(readdir, readdirSync), stats: under(lstat, lstatSync), reads: under(open, openSync, readFile, readFileSync) }
}

describe('Claude Code sessions (TAL-551)', () => {
  let s: TestServer
  const listed = async (query = ''): Promise<Json[]> => ((await json(await s.get(`/api/sessions${query}`))).sessions as Json[]).filter((r) => r.source_tag === 'claude_code')

  beforeAll(async () => {
    s = await bootTestServer()
    const project = join(s.state, 'claude-projects', '-Users-me-repo')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'one.jsonl'), [
      line({ type: 'summary', summary: 'Fix   the login bug' }),
      line({ type: 'user', timestamp: '2026-10-01T10:00:00Z', message: { role: 'user', content: 'Why does login fail?' } }),
      'not json',
      line({ type: 'assistant', timestamp: '2026-10-01T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'The token expired.' }] } }),
    ].join('\n'))
    writeFileSync(join(project, 'two.jsonl'), line({ type: 'user', timestamp: '2026-10-02T09:00:00Z', message: { role: 'user', content: 'Second   transcript question' } }) + '\n')
    writeFileSync(join(project, 'empty.jsonl'), line({ type: 'progress' }) + '\n')
    writeFileSync(join(project, 'notes.txt'), line({ type: 'user', message: { role: 'user', content: 'ignored' } }))
    symlinkSync(join(project, 'two.jsonl'), join(project, 'link.jsonl'))
  })
  afterAll(async () => { await s.close() })

  it('lists the projects dir as read-only imported sessions only while the toggle is on', async () => {
    await s.deps.settings.save({ show_cli_sessions: true, show_claude_code_sessions: true })
    const rows = await listed()
    expect(rows.map((r) => r.title)).toEqual(['Second transcript question', 'Fix the login bug'])
    expect(rows[1]).toMatchObject({
      session_id: expect.stringMatching(/^claude_code_[0-9a-f]{24}$/) as unknown, source_kind: 'claude_code', source_label: 'Claude Code', model: 'claude-code',
      message_count: 2, created_at: Date.parse('2026-10-01T10:00:00Z') / 1000, last_message_at: Date.parse('2026-10-01T10:01:00Z') / 1000,
      is_cli_session: true, read_only: true, can_delete: false, can_pin: false, can_archive: false,
    })
    await s.deps.settings.save({ show_claude_code_sessions: false })
    expect(await listed()).toEqual([])
    expect(await listed('?show_claude_code_sessions=1')).toHaveLength(2)
    // The Claude Code toggle sits under the CLI one.
    await s.deps.settings.save({ show_cli_sessions: false, show_claude_code_sessions: true })
    expect(await listed()).toEqual([])
  })

  it('opens a listed transcript read-only and refuses changes', async () => {
    await s.deps.settings.save({ show_cli_sessions: true, show_claude_code_sessions: true })
    const row = (await listed()).find((r) => r.title === 'Fix the login bug')
    const sid = String(row?.session_id)
    const res = await s.get(`/api/session?session_id=${sid}`)
    expect(res.status).toBe(200)
    const session = (await json(res)).session as Json
    expect(session).toMatchObject({ session_id: sid, read_only: true, source_kind: 'claude_code', can_share: false })
    expect(row?.can_share).toBe(false)
    expect((session.messages as Json[]).map((m) => [m.role, m.content])).toEqual([['user', 'Why does login fail?'], ['assistant', 'The token expired.']])
    expect((await post(s, '/api/session/rename', { session_id: sid, title: 'x' })).status).toBe(403)
    // Web never stores a copy: it would stop following the transcript and fall out of other profiles.
    expect((await post(s, '/api/session/pin', { session_id: sid, pinned: true })).status).toBe(400)
    expect((await post(s, '/api/session/archive', { session_id: sid, archived: true })).status).toBe(400)
    expect((await post(s, '/api/share/create', { session_id: sid })).status).toBe(400)
    await expect(async () => (await s.deps.sessionStore.get(sid))).rejects.toThrow()
  })

  it('opens one transcript without listing the projects dir', async () => {
    await s.deps.settings.save({ show_cli_sessions: true, show_claude_code_sessions: true })
    const sid = String((await listed()).find((r) => r.title === 'Fix the login bug')?.session_id)
    vi.clearAllMocks()
    expect((await s.get(`/api/session?session_id=${sid}`)).status).toBe(200)
    const projects = join(s.state, 'claude-projects')
    expect(fsCalls(realpathSync(projects)).dirReads).toEqual([])
    expect(fsCalls(projects).stats).not.toContain('')
  })

  it('keeps the newest transcripts when more than 200 exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-projects-'))
    try {
      mkdirSync(join(dir, 'p'))
      for (let i = 0; i < 201; i++) {
        const path = join(dir, 'p', `${String(i).padStart(3, '0')}.jsonl`)
        writeFileSync(path, line({ type: 'user', message: { role: 'user', content: `t${String(i)}` } }))
        // The lexically first file is the newest.
        const at = i === 0 ? 2_000_000_000 : 1_000_000_000 + i
        utimesSync(path, at, at)
      }
      const titles = (await new ClaudeCodeSessionSource(() => dir).rows('/ws')).map((r) => r.title)
      expect(titles).toHaveLength(200)
      expect(titles[0]).toBe('t0')
      expect(titles).not.toContain('t1')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('Claude Code scan cost (TAL-1735)', () => {
  let root: string
  let source: ClaudeCodeSessionSource
  const counts = (rows: Json[]): Record<string, unknown> => Object.fromEntries(rows.map((r) => [String(r.title), r.message_count]))
  const sidOf = async (title: string): Promise<string> => String((await source.rows('/ws')).find((r) => r.title === title)?.session_id)

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-projects-')))
    mkdirSync(join(root, 'p'))
    writeFileSync(join(root, 'p', 'a.jsonl'), turn('a'))
    writeFileSync(join(root, 'p', 'b.jsonl'), turn('b'))
    source = new ClaudeCodeSessionSource(() => root)
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(root, { recursive: true, force: true })
  })

  it('walks once for concurrent lists, then touches no transcript until a directory changes', async () => {
    const [first] = await Promise.all([source.rows('/ws'), source.rows('/ws')])
    expect(fsCalls(root)).toMatchObject({ dirReads: ['', 'p'], reads: ['p/a.jsonl', 'p/b.jsonl'] })

    vi.clearAllMocks()
    expect(await source.rows('/ws')).toEqual(first)
    const repeat = fsCalls(root)
    expect(repeat).toMatchObject({ dirReads: [], reads: [] })
    expect(repeat.stats.filter((path) => path.endsWith('.jsonl'))).toEqual([])

    writeFileSync(join(root, 'p', 'c.jsonl'), turn('c'))
    vi.clearAllMocks()
    expect(counts(await source.rows('/ws'))).toEqual({ a: 1, b: 1, c: 1 })
    expect(fsCalls(root)).toMatchObject({ dirReads: ['', 'p'], reads: ['p/c.jsonl'] })
  })

  it('re-parses only an appended transcript, once, after the listing expires', async () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    await source.rows('/ws')
    appendFileSync(join(root, 'p', 'a.jsonl'), turn('a again'))

    vi.advanceTimersByTime(5001)
    vi.clearAllMocks()
    expect(counts(await source.rows('/ws'))).toEqual({ a: 2, b: 1 })
    expect(fsCalls(root).reads).toEqual(['p/a.jsonl'])

    vi.advanceTimersByTime(5001)
    vi.clearAllMocks()
    expect(counts(await source.rows('/ws'))).toEqual({ a: 2, b: 1 })
    expect(fsCalls(root)).toMatchObject({ dirReads: ['', 'p'], reads: [] })
  })

  it('reads a known id from its one file without a walk, and the next list reuses that parse', async () => {
    const sid = await sidOf('a')
    appendFileSync(join(root, 'p', 'a.jsonl'), turn('a again'))
    vi.clearAllMocks()
    expect((await source.messages(sid)).map((m) => m.content)).toEqual(['a', 'a again'])
    const known = fsCalls(root)
    expect(known).toMatchObject({ dirReads: [], reads: ['p/a.jsonl'] })
    expect(known.stats).not.toContain('')

    vi.clearAllMocks()
    expect(counts(await source.rows('/ws'))).toEqual({ a: 2, b: 1 })
    expect(await source.messages(sid)).toHaveLength(2)
    expect(fsCalls(root).reads).toEqual([])
  })

  it('finds an id after a restart by walking, and answers an unknown one from the cached listing', async () => {
    const sid = await sidOf('a')
    const restarted = new ClaudeCodeSessionSource(() => root)
    vi.clearAllMocks()
    expect(await restarted.messages(sid)).toHaveLength(1)
    expect(fsCalls(root)).toMatchObject({ dirReads: ['', 'p'], reads: ['p/a.jsonl'] })

    vi.clearAllMocks()
    expect(await restarted.messages('claude_code_unknown')).toEqual([])
    expect(fsCalls(root)).toMatchObject({ dirReads: [], reads: [] })
  })

  it.each([
    ['deleted', (): void => { rmSync(join(root, 'p', 'a.jsonl')) }],
    ['swapped for a symlink', (): void => { rmSync(join(root, 'p', 'a.jsonl')); symlinkSync(join(root, 'p', 'b.jsonl'), join(root, 'p', 'a.jsonl')) }],
    ['oversized', (): void => { writeFileSync(join(root, 'p', 'a.jsonl'), Buffer.alloc(10 * 1024 * 1024 + 1)) }],
    ['behind a project dir swapped for a symlink', (): void => { renameSync(join(root, 'p'), join(root, 'moved')); symlinkSync(join(root, 'moved'), join(root, 'p')) }],
  ])('refuses a known id whose file is %s', async (_name, change) => {
    const sid = await sidOf('a')
    change()
    expect(await source.messages(sid)).toEqual([])
  })
})
