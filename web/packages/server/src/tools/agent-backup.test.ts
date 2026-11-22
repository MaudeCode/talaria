/** TAL-2661: the one Agent-home backup job owns a private directory and releases it on every exit. */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { redactString } from '../redact.js'
import { AGENT_BACKUP_RETENTION_S, AgentBackupRunning, AgentBackups } from './agent-backup.js'

const roots: string[] = []
const backups: AgentBackups[] = []
afterEach(() => {
  for (const b of backups.splice(0)) b.close()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function setup(opts: { now?: () => number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'talaria-agent-backup-')))
  roots.push(root)
  const dir = join(root, 'agent-backups')
  const sidecar = new FakeSidecar()
  const b = new AgentBackups({ dir, sidecar: () => sidecar, log: () => undefined, redact: (text) => redactString(text), ...opts })
  backups.push(b)
  return { b, dir, root, sidecar }
}

/** The sidecar answers as the Agent's command does: progress, then an archive at `output`. */
function archives(sidecar: FakeSidecar, bytes = Buffer.from('PK archive')) {
  sidecar.respond('backup.create', (params, emit) => {
    emit({ event: 'progress', data: { phase: 'archiving', completed: 1, total: 2 } })
    writeFileSync(params.output, bytes, { mode: 0o600 })
    return { status: 'completed', size_bytes: bytes.length, returncode: 0 }
  })
}

describe('AgentBackups (TAL-2661)', () => {
  it('stages a ready archive privately and deletes it once retention passes', async () => {
    let now = 1_800_000_000_000
    const { b, dir, root, sidecar } = setup({ now: () => now })
    archives(sidecar)
    const started = b.start(root)
    expect(started).toMatchObject({ state: 'running', phase: 'starting', download_url: null })
    await vi.waitFor(() => { expect(b.current()?.state).toBe('ready') })
    const ready = b.current()!
    expect(ready).toMatchObject({ complete: true, size_bytes: 10, file_name: 'hermes-agent-home-20270115-080000.zip', download_url: `api/agent-backup/download?id=${started.id}`, expires_at: now / 1000 + AGENT_BACKUP_RETENTION_S })
    const { output } = sidecar.calls.find((c) => c.method === 'backup.create')!.params as { output: string }
    expect([statSync(dirname(output)).mode & 0o777, statSync(dir).mode & 0o777]).toEqual([0o700, 0o700])
    expect(b.archive(started.id)).toEqual({ dir: dirname(output), path: output, name: ready.file_name })
    now += AGENT_BACKUP_RETENTION_S * 1000
    expect([b.current(), b.archive(started.id), readdirSync(dir)]).toEqual([null, null, []])
  })

  it('cancels a running backup through the sidecar and removes its files', async () => {
    const { b, dir, root, sidecar } = setup()
    let aborted = false
    sidecar.respond('backup.create', (params, _emit, opts) => new Promise((resolve) => {
      writeFileSync(join(dirname(params.output), '.partial'), 'x')
      opts.signal?.addEventListener('abort', () => { aborted = true; resolve({ status: 'cancelled' }) })
    }))
    const { id } = b.start(root)
    await vi.waitFor(() => { expect(readdirSync(join(dir, id))).toEqual(['.partial']) })
    expect(() => b.start(root)).toThrow(AgentBackupRunning)
    b.discard(id)
    expect([aborted, b.current()?.state, readdirSync(dir)]).toEqual([true, 'cancelled', []])
    archives(sidecar)
    expect(b.start(root).state).toBe('running')
  })

  it('starts the next backup only after a cancelled one has stopped', async () => {
    const { b, root, sidecar } = setup()
    let stopped: () => void = () => undefined
    sidecar.respond('backup.create', (_params, _emit, opts) => new Promise((resolve) => {
      opts.signal?.addEventListener('abort', () => { stopped = () => { resolve({ status: 'cancelled' }) } })
    }))
    const calls = () => sidecar.calls.filter((c) => c.method === 'backup.create').length
    const first = b.start(root)
    await vi.waitFor(() => { expect(calls()).toBe(1) })
    b.discard(first.id)
    archives(sidecar)
    expect(b.start(root).state).toBe('running')
    await new Promise((r) => setImmediate(r))
    expect(calls()).toBe(1)
    stopped()
    await vi.waitFor(() => { expect([calls(), b.current()?.state]).toEqual([2, 'ready']) })
  })

  it('reports a failure without its secret and removes the failed run', async () => {
    const { b, dir, root, sidecar } = setup()
    const secret = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    sidecar.respond('backup.create', (params) => {
      writeFileSync(params.output, 'partial')
      return { status: 'failed', reason: `cannot read .env: ANTHROPIC_API_KEY=${secret}`, returncode: 1 }
    })
    b.start(root)
    await vi.waitFor(() => { expect(b.current()?.state).toBe('failed') })
    expect(b.current()?.error).toContain('cannot read .env')
    expect(JSON.stringify(b.current())).not.toContain(secret)
    expect(readdirSync(dir)).toEqual([])
  })

  it('removes whatever a previous server process left behind', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'talaria-agent-backup-')))
    roots.push(root)
    const dir = join(root, 'agent-backups')
    mkdirSync(join(dir, 'a'.repeat(32)), { recursive: true })
    writeFileSync(join(dir, 'a'.repeat(32), 'hermes-agent-home.zip'), 'old')
    backups.push(new AgentBackups({ dir, sidecar: () => null, log: () => undefined, redact: (t) => t }))
    expect([readdirSync(dir), statSync(dir).mode & 0o777]).toEqual([[], 0o700])
  })
})
