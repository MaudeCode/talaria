import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SIDECAR_SERVER_METHODS } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { Session } from '../sessions/session.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { toolOutcome } from '../sessions/merge.js'
import { TerminalRegistry, type PtyProcessLike } from './terminal.js'

type Json = Record<string, unknown>
interface Recorded { params: Json; result: Json }
const fixtures = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../contracts/fixtures/sidecar/terminal.json'), 'utf8')) as Record<'server.terminal_open' | 'server.terminal_read', Recorded[]>
const CALLER = '20261109_090000_caller'
const OTHER = '20261109_090000_other'

/** A shell that prints its prompt as it starts, records what was typed and when, and prints only what the test sends. */
class Pty implements PtyProcessLike {
  pid = 4242
  written: string[] = []
  /** How many chunks the shell had printed when each write arrived. */
  printedBeforeWrite: number[] = []
  private printed = 0
  private data: (text: string) => void = () => undefined
  private exited: (e: { exitCode: number }) => void = () => undefined
  write(text: string): void { this.written.push(text); this.printedBeforeWrite.push(this.printed) }
  resize(): void { /* no screen */ }
  kill(): void { /* exits only when told */ }
  onData(cb: (text: string) => void): void { this.data = (text) => { this.printed += 1; cb(text) }; queueMicrotask(() => { this.emit('$ ') }) }
  onExit(cb: (e: { exitCode: number }) => void): void { this.exited = cb }
  emit(text: string): void { this.data(text) }
  exit(exitCode: number): void { this.exited({ exitCode }) }
}

describe('terminal_open and terminal_read (TAL-1974)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let workspace: string
  let spawned: { proc: Pty; cwd: string }[]
  const call = async (method: 'server.terminal_open' | 'server.terminal_read', params: Json, caller = CALLER) => {
    const reply = await sidecar.serverRequest(method, { caller_session_id: caller, ...params })
    return 'error' in reply ? { condition: (reply.error as { data?: { condition?: string } }).data?.condition, message: reply.error.message } : { result: SIDECAR_SERVER_METHODS[method].result.parse(reply.result) as Json }
  }
  const session = (sid: string, profile = 'default') => s.deps.sessionStore.save(new Session({ session_id: sid, title: sid, profile, workspace, updated_at: 1, messages: [] }, { workspace, model: null }))

  beforeEach(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    workspace = join(s.state, 'workspace')
    mkdirSync(workspace, { recursive: true })
    spawned = []
    ;(s.deps as { terminals: TerminalRegistry }).terminals = new TerminalRegistry({ env: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh' }, now: () => Date.now(), log: () => undefined, pty: { spawn: (_file, _args, opts) => { const proc = new Pty(); spawned.push({ proc, cwd: opts.cwd }); return proc } } })
    await session(CALLER)
    await session(OTHER)
  })
  afterEach(async () => { s.deps.terminals.closeAll(); await s.close() })

  it('records the fixtures from the real handlers: one PTY in the workspace, the command typed once, the backlog read with cursor and cap', async () => {
    const [opened] = fixtures['server.terminal_open']
    const { caller_session_id: _caller, ...openParams } = opened!.params
    const open = await call('server.terminal_open', openParams)
    const id = String(open.result?.terminal_id)
    expect(open).toEqual({ result: { ...opened!.result, terminal_id: id } })
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.cwd).toBe(realpathSync(workspace))
    const { proc } = spawned[0]!
    expect(proc.written).toEqual(['npm test\r'])
    expect(proc.printedBeforeWrite, 'The command is typed after the prompt, so the shell echoes it once').toEqual([1])
    // The persisted result links the card live and after reload; a refusal links nothing.
    expect(toolOutcome(JSON.stringify(open.result), 'terminal_open').result_view.terminal).toEqual({ terminal_id: id, title: 'Unit tests', command: 'npm test' })
    expect(toolOutcome(JSON.stringify({ error: 'busy', condition: 'limit_reached' }), 'terminal_open').result_view.terminal).toBeUndefined()
    expect(toolOutcome(JSON.stringify({ ...open.result, title: 'npm test' }), 'terminal_open').result_view.terminal, 'A command that is the title shows once').toMatchObject({ command: null })

    proc.emit('\x1b[1mnpm test\x1b[0m\r\n> vitest run\r\n')
    proc.emit(' \x1b[32m✓\x1b[39m src/sum.test.ts (3 tests)\r\n')
    const [fromStart, capped] = fixtures['server.terminal_read']
    for (const recorded of [fromStart!, capped!]) {
      if (recorded === capped) { proc.emit(' Test Files  1 passed (1)\r\n      Tests  3 passed (3)\r\n   Duration  1.2s\r\n'); proc.exit(0) }
      const { caller_session_id: _c, ...params } = recorded.params
      expect(await call('server.terminal_read', { ...params, terminal_id: id })).toEqual({ result: { ...recorded.result, terminal_id: id } })
    }
    // The rest of a cut event is gone; the cursor after it reads the exit and nothing else.
    expect(await call('server.terminal_read', { terminal_id: id, after_event_id: 4 })).toEqual({ result: { terminal_id: id, output: '', lines: 0, next_event_id: 5, truncated: false, running: false, exit_code: 0 } })
    expect(proc.written, 'The agent types nothing after the command').toEqual(['npm test\r'])
  })

  it('keeps a line a carriage return has not yet written over, and writes later text over it from the start', async () => {
    const id = String((await call('server.terminal_open', {})).result?.terminal_id)
    const { proc } = spawned[0]!
    proc.emit(' Tests: 3 passed\r')
    expect((await call('server.terminal_read', { terminal_id: id, after_event_id: 1 })).result).toMatchObject({ output: ' Tests: 3 passed', lines: 1, next_event_id: 2 })
    // The newline that ends that line arrives in the next event, as an empty line.
    proc.emit('\n')
    expect((await call('server.terminal_read', { terminal_id: id, after_event_id: 2 })).result).toMatchObject({ output: '', lines: 1, next_event_id: 3 })
    proc.emit(' 40%\r 80%\r100% done\r\n')
    expect((await call('server.terminal_read', { terminal_id: id, after_event_id: 3 })).result).toMatchObject({ output: '100% done', lines: 1 })
    proc.emit('abcdef\rXY\n')
    expect((await call('server.terminal_read', { terminal_id: id, after_event_id: 4 })).result).toMatchObject({ output: 'XYcdef' })
  })

  it('reads at most 400 lines, whole events first, and says when the backlog dropped unread output', async () => {
    const id = String((await call('server.terminal_open', {})).result?.terminal_id)
    const { proc } = spawned[0]!
    expect(proc.written, 'No command types nothing').toEqual([])
    for (let i = 0; i < 5; i += 1) proc.emit(Array.from({ length: 100 }, (_, n) => `line ${String(i * 100 + n)}\n`).join(''))
    // The prompt (event 1) and four events of 100 lines fill the cap; the fifth waits for the next read.
    const first = (await call('server.terminal_read', { terminal_id: id, max_lines: 1000 })).result!
    expect(first).toMatchObject({ lines: 400, next_event_id: 5, truncated: true, running: true, exit_code: null })
    expect(String(first.output).split('\n')[0]).toBe('$ line 0')
    expect(String(first.output).split('\n').at(-1)).toBe('line 399')
    expect((await call('server.terminal_read', { terminal_id: id, after_event_id: 5 })).result).toMatchObject({ output: Array.from({ length: 100 }, (_, n) => `line ${String(400 + n)}`).join('\n'), lines: 100, next_event_id: 6, truncated: false })
    // 2000 newer events push event 6 out of the backlog: a cursor before it reads what is left, marked truncated.
    for (let i = 0; i < 2000; i += 1) proc.emit('.')
    expect((await call('server.terminal_read', { terminal_id: id, after_event_id: 5 })).result).toEqual({ terminal_id: id, output: '.'.repeat(2000), lines: 1, next_event_id: 2006, truncated: true, running: true, exit_code: null })
    expect((await call('server.terminal_read', { terminal_id: id, after_event_id: 2005 })).result).toMatchObject({ output: '.', truncated: false })
  })

  it('refuses a second live terminal, another session\'s terminal and any command beyond one line', async () => {
    // Two opens at once (a parallel tool batch) start one terminal; the other is refused.
    const both = await Promise.all([call('server.terminal_open', { command: 'npm run build' }), call('server.terminal_open', { command: 'npm test' })])
    expect(both.map((reply) => reply.condition ?? 'opened').sort()).toEqual(['limit_reached', 'opened'])
    const id = String(both.find((reply) => reply.result)?.result?.terminal_id)
    expect(await call('server.terminal_open', { command: 'npm test' })).toMatchObject({ condition: 'limit_reached' })
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.proc.written).toHaveLength(1)
    expect(await call('server.terminal_read', { terminal_id: id }, OTHER)).toMatchObject({ condition: 'terminal_not_found' })
    expect(await call('server.terminal_read', { terminal_id: 'term_0000000000000000' })).toMatchObject({ condition: 'terminal_not_found' })
    expect(await call('server.terminal_open', { command: 'echo a\nrm -rf ~' }, OTHER)).toMatchObject({ condition: 'invalid_command' })
    expect(await call('server.terminal_open', { command: 'echo ok\tmore' }, OTHER), 'A tab would complete, not separate').toMatchObject({ condition: 'invalid_command' })
    expect(await call('server.terminal_open', { command: 'x'.repeat(8193) }, OTHER)).toMatchObject({ condition: 'command_too_long' })
    expect(spawned).toHaveLength(1)
    // Once the shell exits the session may open another, with a new id; the old one is gone.
    spawned[0]!.proc.exit(0)
    const next = String((await call('server.terminal_open', {})).result?.terminal_id)
    expect(next).not.toBe(id)
    expect(await call('server.terminal_read', { terminal_id: id })).toMatchObject({ condition: 'terminal_not_found' })
  })

  it('a card reattaches the pane to its own terminal, keeping a closed one\'s output, and never starts another', async () => {
    const start = async (body: Json) => { const res = await s.get('/api/terminal/start', { method: 'POST', body: JSON.stringify({ session_id: CALLER, ...body }), headers: { 'content-type': 'application/json' } }); return { status: res.status, body: await res.json() as Json } }
    const id = String((await call('server.terminal_open', { command: 'npm test; exit' })).result?.terminal_id)
    spawned[0]!.proc.emit('PASS\r\n')
    spawned[0]!.proc.exit(0)
    // The shell exited before the user opened the card: the pane attaches to it as it stands, closed with its output.
    expect(await start({ terminal_id: id, rows: 30, cols: 100 })).toEqual({ status: 200, body: { ok: true, mode: 'web_pty', session_id: CALLER, workspace: realpathSync(workspace), running: false, terminal_id: id } })
    expect(spawned).toHaveLength(1)
    expect((await call('server.terminal_read', { terminal_id: id })).result).toMatchObject({ output: '$ PASS', running: false, exit_code: 0 })
    // The terminal pane's own start replaces the closed shell; the old card's terminal is gone and says so.
    const fresh = await start({})
    expect(fresh.body.terminal_id).not.toBe(id)
    expect(spawned).toHaveLength(2)
    expect(await start({ terminal_id: id })).toEqual({ status: 404, body: { error: 'This terminal is no longer available.' } })
    // Another session cannot attach to it.
    const other = await s.get('/api/terminal/start', { method: 'POST', body: JSON.stringify({ session_id: OTHER, terminal_id: fresh.body.terminal_id }), headers: { 'content-type': 'application/json' } })
    expect(other.status).toBe(404)
    expect(spawned).toHaveLength(2)
  })
})
