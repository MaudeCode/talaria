/**
 * Source and published-release self-updates, and the Agent update branches, on synthetic
 * repositories and manifests.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
// These tests own a synthetic host prefix even when CI itself runs in a container.
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, existsSync: (path: import('node:fs').PathLike) => ['/run/.containerenv', '/.dockerenv', '/.within_container'].includes(String(path)) ? false : fs.existsSync(path) }
})
import type { AgentRecoveryState, RuntimeDescribe } from '@maudecode/talaria-web-contracts'
import type { Dict } from '../config/agent-config.js'
import { detectWebuiVersion, developmentInfo } from '../release.js'
import { bootTestServer, WEB_ROOT } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { RESTART_EXIT_CODE, supervise } from '../cli/supervise.js'
import {
  applyAgentUpdate, applyWebUpdate, CACHE_TTL_S, checkAgentUpdate, checkWebUpdate, FETCH_RETRY_MS, forceAgentUpdate, githubJson, inventoryLocks, npmInstallInfo, publishedWebRelease, ReleaseUnavailable,
  REPOSITORY_URL, runGit, sanitizeGitDiagnostic, UpdateService, updatesCheckView, updateTargetView, waitUntilRestartSafe, type BuildRun, type GetJson, type GitOutcome, type GitRun, type PublishedRelease, type ReleaseIdentity, type RestartBlockers, type UpdateServiceDeps,
} from './updates.js'

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Synthetic', GIT_COMMITTER_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' }
const saved: Record<string, string | undefined> = {}
beforeAll(() => { for (const [k, v] of Object.entries(GIT_ENV)) { saved[k] = process.env[k]; process.env[k] = v } })
afterAll(() => { for (const k of Object.keys(GIT_ENV)) process.env[k] = saved[k] })

const dirs: string[] = []
const services: UpdateService[] = []
/** Every service a test builds, so cleanup can wait for the background refresh checks it started (TAL-1632). */
const updateService = (deps: UpdateServiceDeps): UpdateService => { const svc = new UpdateService(deps); services.push(svc); return svc }
/** Removes this test's temp dirs once no refresh check it started still runs git in them. */
const cleanup = async (): Promise<void> => {
  await Promise.all(services.splice(0).map((svc) => svc.settled()))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
}
afterEach(cleanup)
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'talaria-updates-')); dirs.push(d); return d }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const write = (path: string, text: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }
const readStamp = (client: string): Dict | null => (existsSync(join(client, 'web/_release.json')) ? (JSON.parse(readFileSync(join(client, 'web/_release.json'), 'utf8')) as Dict) : null)

const PIN = { 'x-talaria': { version: '0.0.1', sourceRevision: 'd'.repeat(40) }, services: { 'hermes-agent': { image: `docker.io/nousresearch/hermes-agent@sha256:${'e'.repeat(64)}` } } }
const VERSIONS = { appWeb: { fixtureVersion: 1 }, webRelay: { protocolVersion: 2 } }
const DEV = developmentInfo(WEB_ROOT)

interface Install { client: string; upstream: string; old: string; latest: string; release: PublishedRelease; identity: ReleaseIdentity; id: { release: Dict; stamped: Dict; running: string | null }; run: GitRun; commands: string[][]; getJson: GetJson; requests: string[] }

/** Python `source_install`: an upstream with an old and a published commit, and a clean client on the old one whose GitHub origin resolves to the upstream. */
function sourceInstall(): Install {
  const root = tmp()
  const upstream = join(root, 'upstream')
  git(root, 'init', '-b', 'main', upstream)
  write(join(upstream, 'web/package.json'), '{"version":"1.0.0"}\n')
  write(join(upstream, '.gitignore'), 'web/_release.json\nweb/cache.txt\nweb/node_modules/\nweb/packages/*/dist/\n')
  write(join(upstream, 'web/sidecar/agent_dependency.json'), JSON.stringify(PIN))
  write(join(upstream, 'web/contract_versions.json'), JSON.stringify(VERSIONS))
  write(join(upstream, 'contracts/versions.json'), JSON.stringify(VERSIONS))
  git(upstream, 'add', '.')
  git(upstream, 'commit', '-m', 'synthetic old release')
  const old = git(upstream, 'rev-parse', 'HEAD')
  write(join(upstream, 'web/package.json'), '{"version":"2.0.0"}\n')
  write(join(upstream, 'web/cache.txt'), 'incoming tracked file\n')
  git(upstream, 'add', '.')
  git(upstream, 'add', '-f', 'web/cache.txt')
  git(upstream, 'commit', '-m', 'synthetic published release')
  const latest = git(upstream, 'rev-parse', 'HEAD')
  git(upstream, 'tag', '-a', 'web-v2.0.0', '-m', 'synthetic tag')
  const client = join(root, 'client')
  git(root, 'clone', upstream, client)
  git(client, 'reset', '--hard', old)
  git(client, 'tag', '-d', 'web-v2.0.0')
  // The production URL stays configured; only this fixture's transport is redirected to its own repository.
  git(client, 'remote', 'set-url', 'origin', 'https://github.com/MaudeCode/talaria.git')
  const runtime = { tag: 'web-v2.0.0', version: '2.0.0', sourceRevision: latest, releaseSet: latest, contracts: { appWeb: [1], webRelay: [2] }, compatibleAgent: { ...PIN['x-talaria'], image: PIN.services['hermes-agent'].image } }
  const release: PublishedRelease = { tag: 'web-v2.0.0', version: '2.0.0', sourceRevision: latest, releaseSet: latest, image: `ghcr.io/maudecode/talaria-web@sha256:${'f'.repeat(64)}`, npm: null, manifestReleaseSet: latest, runtime, release_url: `${REPOSITORY_URL}/releases/tag/release-set-${latest}`, releasesBehind: 1, notes: [], versions: [] }
  const id = { release: DEV as Dict, stamped: DEV as Dict, running: null as string | null }
  const identity: ReleaseIdentity = { release: () => id.release, stamped: () => id.stamped, runningSourceRevision: () => id.running }
  const commands: string[][] = []
  const run: GitRun = (args, cwd, t) => { commands.push(args); return runGit(args[0] === 'fetch' ? args.map((a) => (a === 'origin' ? upstream : a)) : args, cwd, t) }
  const requests: string[] = []
  const getJson: GetJson = (path, { asset }) => {
    requests.push(path)
    const set = `release-set-${release.sourceRevision}`
    if (asset) return Promise.resolve({ schemaVersion: 1, releaseSet: release.sourceRevision, status: 'complete', contracts: { appWeb: { web: [1] }, webRelay: { web: [2] } }, agent: release.runtime.compatibleAgent, components: { web: { tag: release.tag, version: release.version, sourceRevision: release.sourceRevision, releaseSet: release.sourceRevision, image: release.image, ...(release.npm ? { npm: release.npm } : {}) } } })
    return Promise.resolve([{ tag_name: set, published_at: '2026-09-19T00:00:00Z', assets: [{ name: 'release-set.json', id: 123 }] }])
  }
  return { client, upstream, old, latest, release, identity, id, run, commands, getJson, requests }
}

const noReleases: GetJson = () => { throw new Error('Main must not query releases') }
const web = (client: string): string => join(client, 'web')

describe('Web source updates (test_tal203_source_update.py)', () => {
  function service(s: Install, opts: { channel?: 'stable' | 'experimental'; getJson?: GetJson; agentDir?: string | null; blockers?: () => RestartBlockers; llm?: (system: string, user: string) => Promise<string>; autoApply?: () => boolean; checkEnabled?: () => boolean; npm?: BuildRun; autoNotification?: UpdateServiceDeps['autoNotification'] } = {}): { svc: UpdateService; restarts: number[] } {
    const restarts: number[] = []
    const svc = updateService({
      webRoot: web(s.client), git: s.run, getJson: opts.getJson ?? s.getJson, identity: s.identity, webuiVersion: 'development',
      agentDir: () => opts.agentDir ?? null, channel: () => opts.channel ?? 'stable', includeAgent: () => true,
      ...(opts.autoApply ? { autoApply: opts.autoApply } : {}), ...(opts.npm ? { npm: opts.npm } : {}),
      ...(opts.checkEnabled ? { checkEnabled: opts.checkEnabled } : {}),
      ...(opts.autoNotification ? { autoNotification: opts.autoNotification } : {}),
      blockers: opts.blockers ?? (() => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false })),
      scheduleRestart: () => restarts.push(1), llm: opts.llm ?? null, log: () => undefined,
    })
    return { svc, restarts }
  }

  it('a source checkout reports a contributor manual update on both channels and is never mutated', async () => {
    const s = sourceInstall()
    const { svc, restarts } = service(s)
    for (const channel of ['stable', 'experimental'] as const) {
      const status = await checkWebUpdate(web(s.client), 'development', channel, s.run, s.getJson, s.identity)
      expect(status).toMatchObject({ manual_update: true, no_git: false })
      expect(String(status.message)).toContain('contributor source checkout')
      const applied = await applyWebUpdate(web(s.client), channel, s.run, s.getJson, s.identity)
      expect(applied).toMatchObject({ ok: false, manual_update: true })
      expect(String(applied.message)).toContain('contributor source checkout')
    }
    expect((await svc.apply('webui', 'stable')).ok).toBe(false)
    expect((await svc.force('webui', 'experimental')).ok).toBe(false)
    expect(git(s.client, 'rev-parse', 'HEAD')).toBe(s.old)
    expect(readStamp(s.client)).toBeNull()
    expect(s.commands.filter((args) => ['fetch', 'merge', 'reset', 'checkout'].includes(args[0]!))).toEqual([])
    expect(restarts).toEqual([])
  })

  it('refuses every Agent mutation while a Web restart is pending', async () => {
    const { svc } = npmService({ agentDir: join(tmp(), 'agent') })
    expect(await svc.apply('webui')).toMatchObject({ ok: true, restart_scheduled: true })

    for (const result of [await svc.apply('agent'), await svc.force('agent'), await svc.clearLock('agent')]) {
      expect(result).toMatchObject({ ok: false, status: 'already_in_progress', target: 'agent' })
    }
  })

  it('automatically applies a Stable npm update and retries active-chat blockers', async () => {
    let enabled = false
    let blocked = true
    const notificationEvents: string[] = []
    const { svc, restarts, installs, version } = npmService({
      autoApply: () => enabled,
      blockers: () => ({ active_streams: blocked ? 1 : 0, active_runs: 0, blocking_stream_ids: blocked ? ['s'] : [], blocking_run_ids: [], restart_blocked: blocked }),
      autoNotification: { begin: () => { notificationEvents.push('begin'); return Promise.resolve(`notice-${String(notificationEvents.length)}`) }, transition: (_id, phase) => { notificationEvents.push(phase) } },
    })
    expect(await svc.autoApplyOnce()).toBeNull()
    enabled = true
    expect(await svc.autoApplyOnce()).toMatchObject({ ok: false, restart_blocked: true })
    expect(notificationEvents).toEqual(['begin', 'blocked'])
    expect(installs()).toBe(0)
    expect(restarts).toEqual([])
    blocked = false
    expect(await svc.autoApplyOnce()).toMatchObject({ ok: true, restart_scheduled: true })
    expect(notificationEvents).toEqual(['begin', 'blocked', 'begin', 'restarting'])
    expect(version()).toBe('2.0.0')
    expect(restarts).toEqual([1])
  })

  it('checks without applying until opted in, and stops checking when updates are disabled', async () => {
    let enabled = true
    const { svc, restarts, installs, version } = npmService({ autoApply: () => false, checkEnabled: () => enabled })
    const check = vi.spyOn(svc, 'check')
    expect(await svc.autoApplyOnce()).toMatchObject({ behind: 1 })
    expect(installs()).toBe(0)
    expect(restarts).toEqual([])
    expect(version()).toBe('1.0.0')
    enabled = false
    expect(await svc.autoApplyOnce()).toBeNull()
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('runs the automatic loop immediately and periodically until stopped', async () => {
    vi.useFakeTimers()
    try {
      const s = sourceInstall()
      const { svc } = service(s, { autoApply: () => false })
      const tick = vi.spyOn(svc, 'autoApplyOnce').mockResolvedValue(null)
      svc.startAutoApply(1000)
      await vi.advanceTimersByTimeAsync(0)
      expect(tick).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(tick).toHaveBeenCalledTimes(2)
      svc.stopAutoApply()
      await vi.advanceTimersByTimeAsync(2000)
      expect(tick).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('recovers retained Agent debt without another apply or enabled update checks', async () => {
    vi.useFakeTimers()
    const { svc } = service(sourceInstall(), { checkEnabled: () => false, agentDir: '/synthetic' })
    let attempts = 0
    const recover = vi.fn((probe: boolean) => Promise.resolve(probe ? { ok: false, owed: attempts < 2, fingerprint: attempts < 2 ? 'receipt' : '', detail: '' }
      : ++attempts === 1 ? { ok: false, owed: true, fingerprint: 'receipt', detail: 'identity temporarily unreadable' } : { ok: true, owed: false, fingerprint: '', detail: '' }))
    Object.assign((svc as unknown as { deps: object }).deps, { recoverAgent: recover })
    try {
      svc.startAutoApply(1000)
      await vi.advanceTimersByTimeAsync(0)
      expect(recover.mock.calls.filter(([probe]) => !probe)).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(recover.mock.calls.filter(([probe]) => !probe)).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(60000)
      expect(recover.mock.calls.filter(([probe]) => !probe)).toHaveLength(2)
    } finally { svc.stopAutoApply(); vi.useRealTimers() }
  })

  it('bounds automatic recovery, rearms changed receipts, and cancels stale completions', async () => {
    vi.useFakeTimers()
    const { svc } = service(sourceInstall(), { checkEnabled: () => false, agentDir: '/synthetic' })
    let reconnect: ((runtime: RuntimeDescribe) => void) | undefined
    let fingerprint = 'first'
    let finish: (() => void) | undefined
    let attempts = 0
    let signal: AbortSignal | undefined
    Object.assign((svc as unknown as { deps: object }).deps, {
      onAgentReconnect: (listener: (runtime: RuntimeDescribe) => void) => { reconnect = listener; return () => { reconnect = undefined } },
      recoverAgent: async (probe: boolean, abort: AbortSignal) => {
        if (!probe) {
          attempts += 1
          signal = abort
          if (fingerprint === 'second') await new Promise<void>((resolve) => { finish = resolve })
        }
        return { ok: false, owed: true, fingerprint, detail: 'synthetic supervisor identity is unverified' }
      },
    })
    try {
      svc.startAutoApply(1000)
      await vi.advanceTimersByTimeAsync(300000)
      expect(attempts).toBe(6)
      expect(svc.cachedStatus().agent_recovery).toMatchObject({ phase: 'blocked', detail: 'synthetic supervisor identity is unverified' })
      await vi.advanceTimersByTimeAsync(10000)
      expect(attempts).toBe(6)
      reconnect?.({ ...new FakeSidecar().describe!, compatible: false })
      await vi.advanceTimersByTimeAsync(1)
      expect(attempts).toBe(6)
      reconnect?.(new FakeSidecar().describe!)
      await vi.advanceTimersByTimeAsync(1)
      expect(attempts).toBe(7)
      fingerprint = 'second'
      await vi.advanceTimersByTimeAsync(1000)
      expect(attempts).toBe(8)
      svc.stopAutoApply()
      expect(signal?.aborted).toBe(true)
      finish?.()
      await vi.advanceTimersByTimeAsync(300000)
      expect(attempts).toBe(8)
      expect(svc.cachedStatus().agent_recovery).not.toMatchObject({ phase: 'complete' })
      expect(vi.getTimerCount()).toBe(0)
    } finally { svc.stopAutoApply(); vi.useRealTimers() }
  })

  it('arms retained recovery immediately after a sidecar reconnect and releases its listener', async () => {
    vi.useFakeTimers()
    const { svc } = service(sourceInstall(), { checkEnabled: () => false, agentDir: '/synthetic' })
    let connected: ((runtime: RuntimeDescribe) => void) | undefined
    let owed = false
    let attempts = 0
    const release = vi.fn()
    Object.assign((svc as unknown as { deps: object }).deps, {
      onAgentReconnect: (listener: (runtime: RuntimeDescribe) => void) => { connected = listener; return release },
      recoverAgent: (probe: boolean) => {
        if (!probe) { attempts += 1; owed = false }
        return Promise.resolve({ ok: !owed, owed, fingerprint: owed ? 'retained' : '', detail: '' })
      },
    })
    try {
      svc.startAutoApply(300000)
      await vi.advanceTimersByTimeAsync(1)
      expect(attempts).toBe(0)
      owed = true
      connected?.(new FakeSidecar().describe!)
      await vi.advanceTimersByTimeAsync(1)
      expect(attempts).toBe(1)
      expect(svc.cachedStatus().agent_recovery).toMatchObject({ phase: 'complete' })
      const retired = connected
      svc.stopAutoApply()
      expect(release).toHaveBeenCalledTimes(1)
      svc.startAutoApply(300000)
      await vi.advanceTimersByTimeAsync(1)
      owed = true
      retired?.(new FakeSidecar().describe!)
      await vi.advanceTimersByTimeAsync(1)
      expect(attempts).toBe(1)
      connected?.(new FakeSidecar().describe!)
      await vi.advanceTimersByTimeAsync(1)
      expect(attempts).toBe(2)
    } finally { svc.stopAutoApply(); vi.useRealTimers() }
  })

  it('rearms a new lifecycle after cancelled discovery finishes without overlapping owners', async () => {
    vi.useFakeTimers()
    const { svc } = service(sourceInstall(), { checkEnabled: () => false, agentDir: '/synthetic' })
    let finish: (() => void) | undefined
    let oldSignal: AbortSignal | undefined
    let probes = 0
    let actions = 0
    Object.assign((svc as unknown as { deps: object }).deps, {
      recoverAgent: (probe: boolean, signal: AbortSignal) => {
        if (!probe) { actions += 1; return Promise.resolve({ ok: true, owed: false, fingerprint: '', detail: '' }) }
        probes += 1
        if (probes === 1) {
          oldSignal = signal
          return new Promise((resolve) => { finish = () => { resolve({ ok: true, owed: false, fingerprint: '', detail: '' }) } })
        }
        return Promise.resolve({ ok: false, owed: true, fingerprint: 'retained', detail: '' })
      },
    })
    try {
      svc.startAutoApply(300000)
      await vi.advanceTimersByTimeAsync(1)
      svc.stopAutoApply()
      expect(oldSignal?.aborted).toBe(true)
      svc.startAutoApply(300000)
      await vi.advanceTimersByTimeAsync(1)
      expect(probes).toBe(1)
      expect(actions).toBe(0)
      finish!()
      await vi.advanceTimersByTimeAsync(1)
      expect(actions).toBe(1)
      expect(svc.cachedStatus().agent_recovery).toMatchObject({ phase: 'complete' })
    } finally { finish?.(); svc.stopAutoApply(); vi.useRealTimers() }
  })

  it('uses a positive retry delay while another lifecycle operation owns recovery', async () => {
    vi.useFakeTimers()
    const { svc } = service(sourceInstall(), { checkEnabled: () => false, agentDir: '/synthetic' })
    let busy = true
    const recover = vi.fn((probe: boolean) => Promise.resolve({ ok: !probe, owed: probe, fingerprint: probe ? 'owned' : '', detail: '' }))
    Object.assign((svc as unknown as { deps: object }).deps, { gatewayRestarting: () => busy, recoverAgent: recover })
    const schedule = vi.spyOn(globalThis, 'setTimeout')
    try {
      svc.startAutoApply(300000)
      const initial = schedule.mock.calls.length
      await vi.advanceTimersByTimeAsync(1)
      expect(schedule.mock.calls.slice(initial).map((call) => call[1])).not.toContain(0)
      expect(recover).not.toHaveBeenCalled()
      busy = false
      await vi.advanceTimersByTimeAsync(1000)
      expect(svc.cachedStatus().agent_recovery).toMatchObject({ phase: 'complete' })
    } finally { svc.stopAutoApply(); schedule.mockRestore(); vi.useRealTimers() }
  })

  it('waits for active work without spending the failure retry budget', async () => {
    vi.useFakeTimers()
    const { svc } = service(sourceInstall(), { checkEnabled: () => false, agentDir: '/synthetic' })
    let busy = true
    let prepared = false
    let actions = 0
    Object.assign((svc as unknown as { deps: object }).deps, {
      recoverAgent: (probe: boolean) => {
        if (!probe) { actions += 1; prepared = true }
        const waiting = busy && prepared
        return Promise.resolve({ ok: !probe && !busy, owed: probe || busy, fingerprint: 'owned', waiting_for_idle: waiting, detail: 'Waiting for active Web work to finish.' })
      },
    })
    try {
      svc.startAutoApply(300000)
      await vi.advanceTimersByTimeAsync(300000)
      expect(svc.cachedStatus().agent_recovery).toMatchObject({ phase: 'waiting', attempt: 0 })
      expect(actions).toBe(1)
      busy = false
      await vi.advanceTimersByTimeAsync(1000)
      expect(svc.cachedStatus().agent_recovery).toMatchObject({ phase: 'complete' })
      expect(actions).toBe(2)
    } finally { svc.stopAutoApply(); vi.useRealTimers() }
  })

  it('waits out an acknowledged native drain past every former retry, then recovers its successor without another trigger (TAL-1430)', async () => {
    vi.useFakeTimers()
    const { svc } = service(sourceInstall(), { checkEnabled: () => false, agentDir: '/synthetic' })
    let draining = true
    let actions = 0
    const published: string[] = []
    const detail = 'ai.hermes.gateway gateway drain remains owed while its acknowledged native drain finishes; recovery will retry.'
    Object.assign((svc as unknown as { deps: object }).deps, {
      recoverAgent: (probe: boolean) => {
        if (!probe) actions += 1
        if (probe || draining) return Promise.resolve({ ok: false, owed: true, fingerprint: 'retained', detail, ...(probe ? {} : { draining: true }) })
        return Promise.resolve({ ok: true, owed: false, fingerprint: '', detail: '' })
      },
      recoveryChanged: (state: { phase: string }) => { published.push(state.phase); return Promise.resolve() },
    })
    try {
      // No receipt stamp, sidecar connection, apply or check changes while the drain runs past the former six-attempt budget.
      svc.startAutoApply(24 * 3600_000)
      await vi.advanceTimersByTimeAsync(28 * 60_000)
      expect(actions).toBeGreaterThan(6)
      expect(svc.cachedStatus().agent_recovery).toMatchObject({ phase: 'waiting', attempt: 0, detail })
      expect(published).not.toContain('blocked')
      expect(published.filter((phase) => phase === 'running')).toHaveLength(1)
      draining = false
      await vi.advanceTimersByTimeAsync(60_000)
      expect(svc.cachedStatus().agent_recovery).toMatchObject({ phase: 'complete' })
      const settled = actions
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(actions).toBe(settled)
    } finally { svc.stopAutoApply(); vi.useRealTimers() }
  })

  it('keeps probing an exhausted obligation and reruns it once its attested lifecycle changes (TAL-1430)', async () => {
    vi.useFakeTimers()
    const { svc } = service(sourceInstall(), { checkEnabled: () => false, agentDir: '/synthetic' })
    let fingerprint = 'original-gateway'
    let probes = 0
    let actions = 0
    Object.assign((svc as unknown as { deps: object }).deps, {
      recoverAgent: (probe: boolean) => {
        if (probe) probes += 1
        else actions += 1
        if (probe || fingerprint === 'original-gateway') return Promise.resolve({ ok: false, owed: true, fingerprint, detail: 'synthetic supervisor identity is unverified' })
        return Promise.resolve({ ok: true, owed: false, fingerprint: '', detail: '' })
      },
    })
    try {
      svc.startAutoApply(24 * 3600_000)
      await vi.advanceTimersByTimeAsync(300_000)
      expect(actions).toBe(6)
      expect(svc.cachedStatus().agent_recovery).toMatchObject({ phase: 'blocked', detail: 'synthetic supervisor identity is unverified' })
      const blockedProbes = probes
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(actions).toBe(6)
      expect(probes).toBeGreaterThan(blockedProbes)
      // The old gateway exits and its supervisor starts a successor: only the probed lifecycle stamp changes.
      fingerprint = 'successor-gateway'
      await vi.advanceTimersByTimeAsync(60_000)
      expect(actions).toBe(7)
      expect(svc.cachedStatus().agent_recovery).toMatchObject({ phase: 'complete' })
    } finally { svc.stopAutoApply(); vi.useRealTimers() }
  })

  it('bounds a persisted operation when its Agent cannot be rediscovered after restart', async () => {
    vi.useFakeTimers()
    const { svc } = service(sourceInstall(), { checkEnabled: () => false, agentDir: null })
    const id = '00000000-0000-4000-8000-000000001523'
    Object.assign((svc as unknown as { deps: object }).deps, {
      hasPendingRecovery: () => true,
      pendingRecoveryOperation: () => id,
      recoverAgent: () => Promise.reject(new Error('Synthetic Agent connection is unavailable.')),
    })
    try {
      svc.startAutoApply(24 * 3600_000)
      await vi.advanceTimersByTimeAsync(300_000)
      expect(svc.cachedStatus().agent_recovery).toMatchObject({ phase: 'blocked', attempt: 6, operation_id: id, detail: 'Synthetic Agent connection is unavailable.' })
    } finally { svc.stopAutoApply(); vi.useRealTimers() }
  })

  it('verifies loaded readiness for a persisted recovery notice after its debt disappeared', async () => {
    vi.useFakeTimers()
    const { svc } = service(sourceInstall(), { checkEnabled: () => false, agentDir: '/synthetic' })
    let pending = true
    let verified = 0
    Object.assign((svc as unknown as { deps: object }).deps, {
      hasPendingRecovery: () => pending,
      recoverAgent: (probe: boolean) => {
        if (!probe) verified += 1
        return Promise.resolve({ ok: true, owed: false, fingerprint: '', detail: '' })
      },
      recoveryChanged: (state: { phase: string }) => { if (state.phase === 'complete') pending = false; return Promise.resolve() },
    })
    try {
      svc.startAutoApply(300000)
      await vi.advanceTimersByTimeAsync(1)
      expect(verified).toBe(1)
      expect(pending).toBe(false)
      expect(svc.cachedStatus().agent_recovery).toMatchObject({ phase: 'complete' })
    } finally { svc.stopAutoApply(); vi.useRealTimers() }
  })

  it.each(['disabled', 'channel', 'shutdown'])('cancels an automatic apply after %s changes during its check', async (change) => {
    let enabled = true
    let channel: 'stable' | 'experimental' = 'stable'
    const { svc, restarts, installs, version } = npmService({ autoApply: () => enabled, channel: () => channel })
    let finish!: (result: Dict) => void
    vi.spyOn(svc, 'check').mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const checking = svc.autoApplyOnce()
    expect(await svc.autoApplyOnce()).toBeNull()
    if (change === 'disabled') enabled = false
    else if (change === 'channel') channel = 'experimental'
    else svc.stopAutoApply()
    finish({ webui: { behind: 1 } })
    await checking
    expect(installs()).toBe(0)
    expect(restarts).toEqual([])
    expect(version()).toBe('1.0.0')
  })

  it('does not resurrect a timer when stopped during an in-flight tick', async () => {
    vi.useFakeTimers()
    try {
      const { svc } = service(sourceInstall())
      let finish!: (value: null) => void
      const tick = vi.spyOn(svc, 'autoApplyOnce').mockImplementation(() => new Promise((resolve) => { finish = resolve }))
      svc.startAutoApply(1000)
      await vi.advanceTimersByTimeAsync(0)
      svc.stopAutoApply()
      finish(null)
      await vi.advanceTimersByTimeAsync(5000)
      expect(tick).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it.each(['disabled', 'checks-disabled', 'channel', 'shutdown'])('defers a staged npm update when %s changes during its install, leaving the installed package untouched', async (change) => {
    let enabled = true
    let checks = true
    let channel: 'stable' | 'experimental' = 'stable'
    const service: { svc?: UpdateService } = {}
    const { svc, restarts, version } = npmService({
      autoApply: () => enabled, checkEnabled: () => checks, channel: () => channel,
      npm: (inner) => async (args, cwd, t) => {
        if (args[0] === 'install') {
          expect(service.svc?.blocksNewWork()).toBe(true)
          if (change === 'disabled') enabled = false
          else if (change === 'checks-disabled') checks = false
          else if (change === 'channel') channel = 'experimental'
          else service.svc?.stopAutoApply()
        }
        return inner(args, cwd, t)
      },
    })
    service.svc = svc
    const result = await svc.autoApplyOnce()
    // The replacement is staged beside the installed package and swapped only after this re-check (TAL-379).
    expect(result).toMatchObject({ ok: false })
    expect(version()).toBe('1.0.0')
    expect(restarts).toEqual([])
    expect(svc.blocksNewWork()).toBe(false)
  })

  it('retries failed checks and installs, and stops after scheduling a restart', async () => {
    const { n, svc, restarts, version } = npmService({ autoApply: () => true })
    const check = vi.spyOn(svc, 'check').mockRejectedValueOnce(new Error('synthetic fetch failure'))
    expect(await svc.autoApplyOnce()).toMatchObject({ ok: false })
    n.mode.outcome = 'failure'
    expect(await svc.autoApplyOnce()).toMatchObject({ install_failed: true })
    expect(restarts).toEqual([])
    expect(version()).toBe('1.0.0')
    n.mode.outcome = 'success'
    expect(await svc.autoApplyOnce()).toMatchObject({ restart_scheduled: true })
    const checks = check.mock.calls.length
    expect(await svc.autoApplyOnce()).toBeNull()
    expect(check).toHaveBeenCalledTimes(checks)
    expect(restarts).toEqual([1])
  })

  it('the Experimental setting round-trips and keeps the Agent channel independent', async () => {
    const s = sourceInstall()
    const agentCalls: string[][] = []
    const run: GitRun = (args, cwd, t) => { if (cwd !== s.client && cwd !== web(s.client)) agentCalls.push(args); return s.run(args, cwd, t) }
    const agent = join(tmp(), 'agent')
    git(join(agent, '..'), 'init', '-b', 'master', agent)
    writeFileSync(join(agent, 'VERSION'), '1')
    git(agent, 'add', '.')
    git(agent, 'commit', '-m', 'agent')
    const { svc } = service(s, { channel: 'experimental', getJson: noReleases, agentDir: agent })
    Object.assign((svc as unknown as { git: GitRun }), { git: run })
    expect(svc.cachedStatus().stale_channel).toBe(true)
    const status = await svc.check(true)
    expect(status.channel).toBe('experimental')
    expect((status.webui as Dict).manual_update).toBe(true)
    // The Agent checkout is inspected with its own `v*` tags regardless of the Web channel.
    expect(agentCalls.some((c) => c[0] === 'tag' && c.includes('v*'))).toBe(true)
    expect(svc.cachedStatus(false).agent).toEqual({ name: 'agent', behind: 0, ignored: true })
  })

  it('the Web version ignores App and Relay tags', () => {
    const s = sourceInstall()
    for (const tag of ['web-v1.0.0', 'app-v99.0.0', 'relay-v99.0.0']) git(s.client, 'tag', '-a', tag, '-m', 'synthetic tag')
    expect(detectWebuiVersion(DEV, web(s.client))).toBe('web-v1.0.0')
  })

  it('private remote credentials never enter update status', async () => {
    const s = sourceInstall()
    git(s.client, 'remote', 'set-url', 'origin', 'https://x-access-token:synthetic-secret@github.com/MaudeCode/talaria.git')
    const result = await checkWebUpdate(web(s.client), 'web-v1.0.0', 'stable', s.run, s.getJson, s.identity)
    expect(result.manual_update).toBe(true)
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
    expect(sanitizeGitDiagnostic('fatal: https://x-access-token:ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ@github.com/x?token=abc')).toBe('fatal: https://<redacted>@github.com/x?token=<redacted>')
  })

  it('packaged installs advertise manual updates without rewinds', async () => {
    const s = sourceInstall()
    s.id.release = { sourceRevision: 'c'.repeat(40) }
    const older = await checkWebUpdate(null, 'web-v1.0.0', 'stable', s.run, s.getJson, s.identity)
    expect(older.behind).toBe(1)
    expect(older.manual_update).toBe(true)
    expect(older.no_git).toBe(true)
    expect((await checkWebUpdate(null, 'web-v3.0.0', 'stable', s.run, s.getJson, s.identity)).behind).toBe(0)
  })

  it('packaged and npm installs report every completed Stable release they are behind (TAL-624)', async () => {
    const s = sourceInstall()
    const latest = (await s.getJson('/releases?per_page=100&page=1', { asset: false }) as Dict[])[0]!
    // Newest first: completed sets for 1.2.0, 1.1.0 and the installed 1.0.0; 1.1.5 is a Web tag whose release set never completed.
    const older = [['1.2.0', 'complete'], ['1.1.5', 'candidate'], ['1.1.0', 'complete'], ['1.0.0', 'complete']] as const
    const sets = older.map(([version, status], i) => ({ id: 200 + i, version, status, sha: String(i).repeat(40), published_at: `2026-09-0${String(9 - i)}T00:00:00Z` }))
    const listed: GetJson = async (path, opts) => {
      const set = sets.find((x) => path === `/releases/assets/${String(x.id)}`)
      if (!set) return opts.asset ? s.getJson(path, opts) : [latest, ...sets.flatMap((x) => [{ tag_name: `web-v${x.version}`, published_at: x.published_at, assets: [] }, { tag_name: `release-set-${x.sha}`, published_at: x.published_at, assets: [{ name: 'release-set.json', id: x.id }] }])]
      const manifest = await s.getJson('/releases/assets/123', opts) as Dict
      return { ...manifest, releaseSet: set.sha, status: set.status, components: { web: { ...(manifest.components as Dict).web as Dict, tag: `web-v${set.version}`, version: set.version } } }
    }
    s.id.release = { sourceRevision: 'c'.repeat(40) }
    expect((await checkWebUpdate(null, 'web-v1.0.0', 'stable', s.run, listed, s.identity)).behind).toBe(3)
    expect((await checkWebUpdate(null, 'web-v1.2.0', 'stable', s.run, listed, s.identity)).behind).toBe(1)
    const n = npmPackageInstall(s)
    expect(await checkWebUpdate(n.packageRoot, 'web-v1.0.0', 'stable', s.run, listed, s.identity, n.npm)).toMatchObject({ install_kind: 'npm', behind: 3 })
  })

  /** `runtimeOf` stamps the installed package of each requested version; by default every install is `s.release`. */
  function npmPackageInstall(s: Install, initial: 'success' | 'failure' | 'bad-stamp' | 'empty-dependency' | 'self-check-fails' | 'self-check-hangs' | 'legacy-bin' | 'legacy-bin-broken-pty' = 'success', runtimeOf?: (version: string) => Dict) {
    const mode = { outcome: initial }
    const globalRoot = join(tmp(), 'lib/node_modules')
    const packageRoot = join(globalRoot, '@maudecode/talaria-web')
    write(join(packageRoot, 'package.json'), JSON.stringify({ name: '@maudecode/talaria-web', version: '1.0.0' }))
    write(join(packageRoot, 'sidecar/agent_dependency.json'), JSON.stringify(PIN))
    write(join(packageRoot, 'contract_versions.json'), JSON.stringify(VERSIONS))
    s.release.npm = '@maudecode/talaria-web@2.0.0'
    s.id.release = { ...s.release.runtime, tag: 'web-v1.0.0', version: '1.0.0', sourceRevision: s.old, releaseSet: s.old }
    const calls: string[][] = []
    const npm: BuildRun = (args) => {
      calls.push(args)
      if (args[0] === 'root') return Promise.resolve({ ok: true, out: globalRoot })
      if (args[0] === 'install') {
        if (mode.outcome === 'failure') return Promise.resolve({ ok: false, out: 'synthetic npm failure' })
        const candidate = join(args[args.indexOf('--prefix') + 1]!, 'lib/node_modules/@maudecode/talaria-web')
        const version = runtimeOf ? /@maudecode\/talaria-web@(.+)$/.exec(args.at(-1)!)![1]! : '2.0.0'
        write(join(candidate, 'package.json'), JSON.stringify({ name: '@maudecode/talaria-web', version, bin: { 'talaria-web': 'dist/bin/talaria-web.js', 'talaria-web-mcp': 'dist/bin/talaria-web-mcp.js' }, dependencies: { ws: '8.22.0' } }))
        mkdirSync(join(candidate, 'node_modules/ws'), { recursive: true })
        if (mode.outcome !== 'empty-dependency') write(join(candidate, 'node_modules/ws/package.json'), '{}')
        write(join(candidate, 'sidecar/agent_dependency.json'), JSON.stringify(PIN))
        write(join(candidate, 'contract_versions.json'), JSON.stringify(VERSIONS))
        write(join(candidate, 'dist/bin/talaria-web.js'), {
          'self-check-fails': "console.error('[self-check] ERROR: synthetic native binding mismatch'); process.exit(1)",
          'self-check-hangs': "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)",
          // A bin from before TAL-1012 loads its server code, then rejects the subcommand.
          'legacy-bin': "console.error('[bootstrap] ERROR: unknown argument: self-check'); process.exit(1)",
          'legacy-bin-broken-pty': "console.error('[bootstrap] ERROR: unknown argument: self-check'); process.exit(1)",
        }[mode.outcome as string] ?? "process.exit(process.argv[2] === 'self-check' ? 0 : 2)")
        write(join(candidate, 'node_modules/node-pty/index.js'), mode.outcome === 'legacy-bin-broken-pty' ? "throw new Error('synthetic pty ABI mismatch')" : 'module.exports = {}')
        write(join(candidate, 'dist/bin/talaria-web-mcp.js'), '// fixture')
        if (mode.outcome !== 'bad-stamp') writeFileSync(join(candidate, '_release.json'), JSON.stringify(runtimeOf?.(version) ?? s.release.runtime))
        return Promise.resolve({ ok: true, out: '' })
      }
      return Promise.resolve({ ok: false, out: 'unexpected npm command' })
    }
    return { packageRoot, globalRoot, npm, calls, mode }
  }

  /** An UpdateService over a global npm install one Stable release behind, the only kind that updates itself (TAL-379). */
  function npmService(opts: { stateDir?: string; channel?: () => 'stable' | 'experimental'; agentDir?: string | null; blockers?: () => RestartBlockers; autoApply?: () => boolean; checkEnabled?: () => boolean; autoNotification?: UpdateServiceDeps['autoNotification']; npm?: (inner: BuildRun) => BuildRun } = {}) {
    const s = sourceInstall()
    const n = npmPackageInstall(s)
    const restarts: number[] = []
    const svc = updateService({
      stateDir: opts.stateDir ?? tmp(), webRoot: n.packageRoot, git: s.run, npm: opts.npm ? opts.npm(n.npm) : n.npm, getJson: s.getJson, identity: s.identity, webuiVersion: 'web-v1.0.0',
      agentDir: () => opts.agentDir ?? null, channel: opts.channel ?? (() => 'stable'), includeAgent: () => true,
      ...(opts.autoApply ? { autoApply: opts.autoApply } : {}), ...(opts.checkEnabled ? { checkEnabled: opts.checkEnabled } : {}),
      ...(opts.autoNotification ? { autoNotification: opts.autoNotification } : {}),
      blockers: opts.blockers ?? (() => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false })),
      scheduleRestart: () => restarts.push(1), llm: null, log: () => undefined,
    })
    const installs = (): number => n.calls.filter((call) => call[0] === 'install').length
    const version = (): string => (JSON.parse(readFileSync(join(n.packageRoot, 'package.json'), 'utf8')) as { version: string }).version
    return { s, n, svc, restarts, installs, version }
  }

  it('keeps the previous package and writes rollback intent before restarting (TAL-1014)', async () => {
    const stateDir = tmp()
    const { n, svc } = npmService({ stateDir })
    const previous = join(n.packageRoot, '..', '.talaria-web-previous')
    write(join(previous, 'obsolete'), 'older backup')
    expect(await svc.apply('webui')).toMatchObject({ ok: true, restart_scheduled: true })
    expect(existsSync(join(previous, 'package.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(previous, 'package.json'), 'utf8'))).toMatchObject({ version: '1.0.0' })
    expect(existsSync(join(previous, 'obsolete'))).toBe(false)
    expect(JSON.parse(readFileSync(join(stateDir, 'update-rollback.json'), 'utf8'))).toEqual({ version: '2.0.0', previousVersion: '1.0.0' })
  })

  it('preserves the running package if rollback intent cannot be persisted (TAL-1014)', async () => {
    const stateDir = tmp()
    mkdirSync(join(stateDir, 'update-rollback.json'))
    const { svc, version, restarts } = npmService({ stateDir })
    expect(await svc.apply('webui')).toMatchObject({ ok: false, install_failed: true })
    expect(version()).toBe('1.0.0')
    expect(restarts).toEqual([])
  })

  it('reports a failed update and skips automatic reinstallation but permits manual retry (TAL-1014)', async () => {
    const stateDir = tmp()
    write(join(stateDir, 'update-rollback.json'), JSON.stringify({ version: '2.0.0', previousVersion: '1.0.0', failedVersion: '2.0.0' }))
    const begin = vi.fn(() => Promise.resolve('unexpected-notification'))
    const { svc, installs, restarts } = npmService({ stateDir, autoApply: () => true, autoNotification: { begin, transition: vi.fn() } })
    const failed_update = { version: '2.0.0', restored_version: '1.0.0' }
    expect((await svc.check(true)).webui).toMatchObject({ failed_update })
    expect(svc.cachedStatus().webui).toMatchObject({ failed_update })
    await svc.autoApplyOnce()
    expect(installs()).toBe(0)
    expect(restarts).toEqual([])
    expect(begin).not.toHaveBeenCalled()
    expect(await svc.apply('webui')).toMatchObject({ ok: true, restart_scheduled: true })
    expect(installs()).toBe(1)
    // Keep the failure visible until the retried worker reports ready.
    expect(JSON.parse(readFileSync(join(stateDir, 'update-rollback.json'), 'utf8'))).toMatchObject({ failedVersion: '2.0.0' })
  })

  it('automatically installs the exact completed Stable npm release and schedules restart', async () => {
    const s = sourceInstall()
    const n = npmPackageInstall(s)
    const restarts: number[] = []
    const svc = updateService({
      webRoot: n.packageRoot, git: s.run, npm: n.npm, getJson: s.getJson, identity: s.identity, webuiVersion: 'web-v1.0.0',
      stateDir: tmp(), agentDir: () => null, channel: () => 'stable', includeAgent: () => false, autoApply: () => true,
      blockers: () => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false }),
      scheduleRestart: () => restarts.push(1), log: () => undefined,
    })
    const status = (await svc.check(true, false, 'stable')).webui as Dict
    expect(status).toMatchObject({ behind: 1, install_kind: 'npm', manual_update: false, npm: '@maudecode/talaria-web@2.0.0' })
    expect(await svc.autoApplyOnce()).toMatchObject({ ok: true, restart_scheduled: true, npm: '@maudecode/talaria-web@2.0.0' })
    expect(n.calls.filter((c) => c[0] === 'install')).toEqual([['install', '--global', '--prefix', expect.stringContaining('.talaria-update-'), '--no-audit', '--no-fund', '@maudecode/talaria-web@2.0.0']])
    expect((JSON.parse(readFileSync(join(n.packageRoot, 'package.json'), 'utf8')) as { version?: unknown }).version).toBe('2.0.0')
    expect(restarts).toEqual([1])
  })

  it('reports the installed npm release as soon as the Web update settles, before its restart (TAL-1525)', async () => {
    const s = sourceInstall()
    const n = npmPackageInstall(s)
    let releaseReads = 0
    const getJson: GetJson = (path, opts) => { if (path.startsWith('/releases?')) releaseReads += 1; return s.getJson(path, opts) }
    const svc = updateService({
      webRoot: n.packageRoot, git: s.run, npm: n.npm, getJson, identity: s.identity, webuiVersion: 'web-v1.0.0',
      stateDir: tmp(), agentDir: () => null, channel: () => 'stable', includeAgent: () => false, checkEnabled: () => true,
      blockers: () => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false }),
      scheduleRestart: () => undefined, log: () => undefined,
    })
    const webView = (): Dict => updatesCheckView(svc.cachedStatus(false, 'stable')).webui as Dict
    const offered = (await svc.check(true, false, 'stable')).webui as Dict
    expect(webView()).toMatchObject({ current_version: 'web-v1.0.0', behind: 1, can_apply: true })
    releaseReads = 0
    expect(await svc.apply('webui', 'stable')).toMatchObject({ ok: true, restart_scheduled: true })
    const installed = { current_version: offered.latest_version, current_sha: offered.latest_sha, behind: 0, state: 'up_to_date', can_apply: false }
    expect(webView()).toMatchObject(installed)
    const refresh = (svc as unknown as { checking: Promise<Dict> | null }).checking
    expect(refresh).not.toBeNull()
    await refresh
    expect(releaseReads).toBeGreaterThan(0)
    // The pending restart still runs the old process; the refreshed status keeps the installed package.
    expect(webView()).toMatchObject(installed)
  })

  it.each(['failure', 'bad-stamp', 'empty-dependency'] as const)('fails closed when the npm replacement is %s', async (outcome) => {
    const s = sourceInstall()
    const n = npmPackageInstall(s, outcome)
    const result = await applyWebUpdate(n.packageRoot, 'stable', s.run, s.getJson, s.identity, n.npm, () => true, { stateDir: tmp() })
    expect(result.ok).toBe(false)
    expect(result[outcome === 'failure' ? 'install_failed' : 'verification_failed']).toBe(true)
    expect((JSON.parse(readFileSync(join(n.packageRoot, 'package.json'), 'utf8')) as { version: string }).version).toBe('1.0.0')
  })

  it.each([
    ['self-check-fails', 'synthetic native binding mismatch'],
    ['self-check-hangs', 'timed out after 1s'],
  ] as const)('fails closed when the candidate %s (TAL-1012)', async (outcome, detail) => {
    const s = sourceInstall()
    const n = npmPackageInstall(s, outcome)
    const result = await applyWebUpdate(n.packageRoot, 'stable', s.run, s.getJson, s.identity, n.npm, () => true, { stateDir: tmp(), selfCheckTimeoutMs: 1000 })
    expect(result).toMatchObject({ ok: false, verification_failed: true })
    expect(result.message).toContain(detail)
    expect((JSON.parse(readFileSync(join(n.packageRoot, 'package.json'), 'utf8')) as { version: string }).version).toBe('1.0.0')
  })

  it('accepts a Stable candidate from before self-check once its node-pty binding loads (TAL-1012)', async () => {
    const s = sourceInstall()
    const n = npmPackageInstall(s, 'legacy-bin')
    expect(await applyWebUpdate(n.packageRoot, 'stable', s.run, s.getJson, s.identity, n.npm, () => true, { stateDir: tmp() })).toMatchObject({ ok: true })
    expect((JSON.parse(readFileSync(join(n.packageRoot, 'package.json'), 'utf8')) as { version: string }).version).toBe('2.0.0')
    const t = sourceInstall()
    const broken = npmPackageInstall(t, 'legacy-bin-broken-pty')
    const result = await applyWebUpdate(broken.packageRoot, 'stable', t.run, t.getJson, t.identity, broken.npm, () => true, { stateDir: tmp() })
    expect(result).toMatchObject({ ok: false, verification_failed: true })
    expect(result.message).toContain('synthetic pty ABI mismatch')
  })

  it('refuses Experimental npm updates and mismatched global package roots', async () => {
    const s = sourceInstall()
    const n = npmPackageInstall(s)
    expect(await npmInstallInfo(n.packageRoot, n.npm, true)).toBeNull()
    const wrongRoot: BuildRun = (args) => Promise.resolve(args[0] === 'root' ? { ok: true, out: join(tmp(), 'other') } : { ok: false, out: 'must not install' })
    expect((await applyWebUpdate(n.packageRoot, 'stable', s.run, s.getJson, s.identity, wrongRoot)).manual_update).toBe(true)
    expect((await applyWebUpdate(n.packageRoot, 'experimental', s.run, s.getJson, s.identity, n.npm)).manual_update).toBe(true)
    expect(n.calls.some((c) => c[0] === 'install')).toBe(false)
  })

  it('refuses linked global packages', async () => {
    const real = join(tmp(), 'real-package')
    write(join(real, 'package.json'), JSON.stringify({ name: '@maudecode/talaria-web', version: '1.0.0' }))
    const globalRoot = join(tmp(), 'lib/node_modules')
    mkdirSync(join(globalRoot, '@maudecode'), { recursive: true })
    symlinkSync(real, join(globalRoot, '@maudecode/talaria-web'))
    const npm: BuildRun = () => Promise.resolve({ ok: true, out: globalRoot })
    expect(await npmInstallInfo(real, npm)).toBeNull()
  })

  it('a web root without .git reports the no_git sentinel', async () => {
    const s = sourceInstall()
    const bare = tmp()
    write(join(bare, 'web/package.json'), '{"version":"1.0.0"}\n')
    const status = await checkWebUpdate(bare, 'web-v1.0.0', 'stable', s.run, s.getJson, s.identity)
    expect(status).toMatchObject({ name: 'webui', no_git: true })
  })

  it.each([
    ['web-v2.0.0', 'web-exp-v1.5.0', 'experimental', false], ['web-v2.0.0', 'web-exp-v1.5.0', 'experimental', true],
    ['web-exp-v3.0.0', 'web-v2.0.0', 'stable', false], ['web-exp-v3.0.0', 'web-v2.0.0', 'stable', true],
    ['web-v2.0.0', 'web-exp-v2.0.0', 'experimental', false], ['web-v2.0.0', 'web-exp-v2.0.0', 'experimental', true],
  ] as const)('a packaged channel switch is manual and unknown (%s -> %s on %s, same source=%s)', async (installed, target, channel, sameSource) => {
    const s = sourceInstall()
    Object.assign(s.release, { tag: target, version: target.split('-v').pop() })
    s.id.release = { sourceRevision: sameSource ? s.latest : 'c'.repeat(40) }
    const result = await checkWebUpdate(null, installed, channel, s.run, s.getJson, s.identity)
    expect(result.behind).toBeNull()
    expect(result.manual_update).toBe(true)
    expect(result.release_url).toBe(s.release.release_url)
  })

  it.each([false, true])('summarizes the published notes of the Stable Web releases an npm update installs, saved channel mismatch=%s (TAL-759, TAL-1008)', async (mismatch) => {
    const s = sourceInstall()
    const n = npmPackageInstall(s)
    const notes = { tag_name: 'web-v2.0.0', published_at: '2026-09-19T00:00:00Z', assets: [], body: 'Chats open faster.\n\n<!-- talaria-publication:{"tag":"web-v2.0.0"} -->' }
    const getJson: GetJson = async (path, opts) => (opts.asset ? s.getJson(path, opts) : [notes, ...(await s.getJson(path, opts) as Dict[])])
    const prompts: string[] = []
    let channel: 'stable' | 'experimental' = mismatch ? 'experimental' : 'stable'
    const svc = updateService({
      stateDir: tmp(), webRoot: n.packageRoot, git: s.run, npm: n.npm, getJson, identity: s.identity, webuiVersion: 'web-v1.0.0',
      agentDir: () => null, channel: () => channel, includeAgent: () => false,
      blockers: () => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false }),
      scheduleRestart: () => undefined, llm: (_system, user) => { prompts.push(user); return Promise.resolve('- Notice: Chats open faster') }, log: () => undefined,
    })
    const webui = updatesCheckView(await svc.check(true, false, 'stable')).webui as Dict
    expect(webui).toMatchObject({ state: 'release_ready', summary_available: true })
    expect(webui).not.toHaveProperty('release_notes')
    await vi.waitFor(() => { expect(prompts).toHaveLength(1) })
    channel = 'stable'
    expect(await svc.summarize('webui')).toMatchObject({ target: 'webui', source: 'release_notes', generated_by: 'llm', cached: true })
    expect(prompts[0]).toContain('<release tag="web-v2.0.0">\nChats open faster.\n</release>')
    expect(prompts[0]).not.toContain('talaria-publication')
  })

  it('refuses to apply while chat work is active and reports the blockers', async () => {
    const { svc, restarts, installs, version } = npmService({ blockers: () => ({ active_streams: 1, active_runs: 2, blocking_stream_ids: ['st_1'], blocking_run_ids: ['r1', 'r2'], restart_blocked: true }) })
    const blocked = await svc.apply('webui')
    expect(blocked).toMatchObject({ ok: false, restart_blocked: true, active_streams: 1, active_runs: 2, blocking_stream_ids: ['st_1'] })
    expect(String(blocked.message)).toContain('1 active chat stream and 2 active agent runs')
    expect(restarts).toEqual([])
    expect(installs()).toBe(0)
    expect(version()).toBe('1.0.0')
  })

  /** TAL-946: completed Stable sets for 2.0.0 (newest), 1.2.0 and 1.1.0 above an npm install of 1.0.0, each with its own source and package. */
  function stableHistory() {
    const s = sourceInstall()
    const sets = [['2.0.0', s.latest], ['1.2.0', '2'.repeat(40)], ['1.1.0', '1'.repeat(40)], ['1.0.0', s.old]] as const
    const sha = (version: string): string => sets.find(([v]) => v === version)![1]
    const runtime = (version: string): Dict => ({ tag: `web-v${version}`, version, sourceRevision: sha(version), releaseSet: sha(version), contracts: { appWeb: [1], webRelay: [2] }, compatibleAgent: s.release.runtime.compatibleAgent })
    const getJson: GetJson = (path, { asset }) => {
      if (!asset) return Promise.resolve(sets.map(([, source], i) => ({ tag_name: `release-set-${source}`, published_at: `2026-09-1${String(9 - i)}T00:00:00Z`, assets: [{ name: 'release-set.json', id: 300 + i }] })))
      const [version, source] = sets[Number(path.split('/').pop()) - 300]!
      return Promise.resolve({ schemaVersion: 1, releaseSet: source, status: 'complete', contracts: { appWeb: { web: [1] }, webRelay: { web: [2] } }, agent: s.release.runtime.compatibleAgent,
        components: { web: { tag: `web-v${version}`, version, sourceRevision: source, releaseSet: source, image: s.release.image, npm: `@maudecode/talaria-web@${version}` } } })
    }
    const n = npmPackageInstall(s, 'success', runtime)
    const restarts: number[] = []
    const svc = updateService({
      stateDir: tmp(), webRoot: n.packageRoot, git: s.run, npm: n.npm, getJson, identity: s.identity, webuiVersion: 'web-v1.0.0', agentDir: () => null, channel: () => 'stable', includeAgent: () => false,
      blockers: () => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false }),
      scheduleRestart: () => restarts.push(1), log: () => undefined,
    })
    const installs = (): string[] => n.calls.filter((call) => call[0] === 'install').map((call) => call.at(-1)!)
    const version = (): string => (JSON.parse(readFileSync(join(n.packageRoot, 'package.json'), 'utf8')) as { version: string }).version
    return { s, n, getJson, svc, restarts, installs, version }
  }

  it('lists every newer completed Stable Web release an npm install can take, newest first (TAL-946)', async () => {
    const h = stableHistory()
    const webui = updatesCheckView(await h.svc.check(true, false, 'stable')).webui as Dict
    expect(webui).toMatchObject({ state: 'release_ready', behind: 3, target_version: 'web-v2.0.0', folded_count: 2 })
    const url = (version: string): string => `${REPOSITORY_URL}/releases/tag/release-set-${version === '2.0.0' ? h.s.latest : version.split('.')[1]!.repeat(40)}`
    expect(webui.versions).toEqual([
      { version: 'web-v2.0.0', ref: '2.0.0', release_url: url('2.0.0'), latest: true, folded: false },
      { version: 'web-v1.2.0', ref: '1.2.0', release_url: url('1.2.0'), latest: false, folded: true },
      { version: 'web-v1.1.0', ref: '1.1.0', release_url: url('1.1.0'), latest: false, folded: true },
    ])
  })

  it('installs the exact npm package of an intermediate Stable Web release (TAL-946)', async () => {
    const h = stableHistory()
    expect(await h.svc.apply('webui', 'stable', () => true, { version: '1.2.0' })).toMatchObject({ ok: true, npm: '@maudecode/talaria-web@1.2.0', restart_scheduled: true })
    expect(h.installs()).toEqual(['@maudecode/talaria-web@1.2.0'])
    expect(h.version()).toBe('1.2.0')
    expect(h.restarts).toEqual([1])
  })

  it('without a version still installs the newest Stable Web release (TAL-946)', async () => {
    const h = stableHistory()
    expect(await applyWebUpdate(h.n.packageRoot, 'stable', h.s.run, h.getJson, h.s.identity, h.n.npm, () => true, { stateDir: tmp() })).toMatchObject({ ok: true, npm: '@maudecode/talaria-web@2.0.0' })
    expect(h.installs()).toEqual(['@maudecode/talaria-web@2.0.0'])
  })

  it('rejects an absent, installed, or Experimental Web version without installing anything (TAL-946)', async () => {
    const h = stableHistory()
    for (const version of ['9.0.0', '1.0.0', '0.9.0']) {
      expect(await applyWebUpdate(h.n.packageRoot, 'stable', h.s.run, h.getJson, h.s.identity, h.n.npm, () => true, {}, version))
        .toMatchObject({ ok: false, message: `Talaria Web ${version} is not a newer Stable release for this installation. Check for updates and try again.` })
    }
    expect(await h.svc.apply('webui', 'experimental', () => true, { version: '1.2.0' })).toMatchObject({ ok: false, message: 'Choosing a version is available only on the Stable channel.' })
    expect(h.installs()).toEqual([])
    expect(h.version()).toBe('1.0.0')
  })
})

describe('published release sets (test_tal203_published_releases.py)', () => {
  const sha = 'a'.repeat(40)
  function fixture(): { manifest: Dict; entries: Dict[]; requests: [string, boolean][]; getJson: GetJson } {
    const manifest: Dict = {
      schemaVersion: 1, releaseSet: sha, status: 'complete',
      contracts: { appWeb: { web: [1] }, webRelay: { web: [2] } },
      agent: { version: '0.21.3', sourceRevision: 'd'.repeat(40) },
      components: { web: { tag: 'web-v2.0.0', version: '2.0.0', sourceRevision: sha, releaseSet: sha, image: `ghcr.io/maudecode/talaria-web@sha256:${'b'.repeat(64)}` } },
    }
    const entries: Dict[] = [
      { tag_name: 'web-v99.0.0', published_at: 'synthetic', assets: [] },
      { tag_name: `release-set-${'c'.repeat(40)}`, published_at: null, draft: true },
      { tag_name: `release-set-${sha}`, published_at: 'synthetic', assets: [{ name: 'release-set.json', id: 123 }] },
    ]
    const requests: [string, boolean][] = []
    const getJson: GetJson = (path, { asset }) => {
      requests.push([path, asset])
      expect(['/releases?per_page=100&page=1', '/releases/assets/123']).toContain(path)
      return Promise.resolve(asset ? manifest : entries)
    }
    return { manifest, entries, requests, getJson }
  }

  it('only completed release sets advertise updates', async () => {
    const f = fixture()
    const result = await publishedWebRelease('stable', f.getJson)
    expect(result.tag).toBe('web-v2.0.0')
    expect(result.sourceRevision).toBe(sha)
    expect(f.requests).toEqual([['/releases?per_page=100&page=1', false], ['/releases/assets/123', true]])
    expect(result.release_url).toContain('MaudeCode/talaria/releases/tag/release-set-')
    expect(result.runtime).toEqual({ tag: 'web-v2.0.0', version: '2.0.0', sourceRevision: sha, releaseSet: sha, contracts: { appWeb: [1], webRelay: [2] }, compatibleAgent: f.manifest.agent })
  })

  it.each([['status', 'candidate'], ['releaseSet', 'main'], ['schemaVersion', 2]])('rejects partial or inconsistent manifests (%s=%s)', async (field, value) => {
    const f = fixture()
    f.manifest[field] = value
    await expect(publishedWebRelease('stable', f.getJson)).rejects.toBeInstanceOf(ReleaseUnavailable)
  })

  it.each([['sourceRevision', 'main'], ['version', '3.0.0'], ['image', 'ghcr.io/maudecode/talaria-web:latest'], ['releaseSet', 'd'.repeat(40)]])('rejects mutable Web references (%s)', async (field, value) => {
    const f = fixture()
    ;(f.manifest.components as Dict).web = { ...((f.manifest.components as Dict).web as Dict), [field]: value }
    await expect(publishedWebRelease('stable', f.getJson)).rejects.toBeInstanceOf(ReleaseUnavailable)
  })

  it('experimental channel selection and an unchanged Web identity', async () => {
    const f = fixture()
    const webComponent = (f.manifest.components as Dict).web as Dict
    const oldSet = webComponent.releaseSet
    f.manifest.releaseSet = 'e'.repeat(40)
    f.entries[2]!.tag_name = `release-set-${'e'.repeat(40)}`
    expect((await publishedWebRelease('stable', f.getJson)).releaseSet).toBe(oldSet)
    webComponent.tag = 'web-exp-v2.0.0'
    expect((await publishedWebRelease('experimental', f.getJson)).tag).toBe('web-exp-v2.0.0')
    await expect(publishedWebRelease('stable', f.getJson)).rejects.toBeInstanceOf(ReleaseUnavailable)
  })

  it('a download redirect cannot forward the private repository token', async () => {
    const seen: { url: string; auth: string | undefined }[] = []
    const fetchStub = ((input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      const headers = init?.headers as Record<string, string> | undefined
      seen.push({ url, auth: headers?.Authorization })
      if (url.startsWith('https://api.github.com/')) return Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/synthetic' } }))
      return Promise.resolve(new Response('{"ok":1}', { status: 200 }))
    }) as typeof fetch
    const getJson = githubJson(fetchStub, { TALARIA_RELEASE_TOKEN: 'synthetic-private-token' })
    expect(await getJson('/releases/assets/123', { asset: true })).toEqual({ ok: 1 })
    expect(seen[0]?.auth).toBe('Bearer synthetic-private-token')
    expect(seen[1]).toEqual({ url: 'https://release-assets.githubusercontent.com/synthetic', auth: undefined })
    for (const location of ['http://release-assets.githubusercontent.com/synthetic', 'https://attacker.example/synthetic']) {
      const bad = ((): Promise<Response> => Promise.resolve(new Response(null, { status: 302, headers: { location } }))) as typeof fetch
      await expect(githubJson(bad, {})('/releases/assets/123', { asset: true })).rejects.toBeInstanceOf(ReleaseUnavailable)
    }
  })

  it('marks only unreachable, slow, or overloaded GitHub answers as transient', async () => {
    const answer = (status: number): typeof fetch => (() => Promise.resolve(new Response('{}', { status })))
    const transient = async (f: typeof fetch): Promise<boolean> => {
      try { await githubJson(f, {})('/releases', { asset: false }) } catch (error) { return (error as ReleaseUnavailable).transient }
      throw new Error('expected a failure')
    }
    expect(await transient((() => Promise.reject(new TypeError('fetch failed'))))).toBe(true)
    expect(await transient(answer(502))).toBe(true)
    expect(await transient(answer(429))).toBe(true)
    expect(await transient(answer(404))).toBe(false)
    const s = sourceInstall()
    const down: GetJson = () => Promise.reject(new ReleaseUnavailable('GitHub answered 503', true))
    expect(await checkWebUpdate(null, 'development', 'stable', s.run, down, s.identity)).toMatchObject({ stale_check: true, error: 'GitHub answered 503' })
    const missing: GetJson = () => Promise.reject(new ReleaseUnavailable('GitHub answered 404'))
    expect((await checkWebUpdate(null, 'development', 'stable', s.run, missing, s.identity)).stale_check).toBeUndefined()
  })

  it('selects by publication order, not response array order', async () => {
    const f = fixture()
    const older = structuredClone(f.manifest)
    older.releaseSet = 'c'.repeat(40)
    f.entries[2]!.published_at = '2026-09-19T00:00:00Z'
    f.entries.unshift({ tag_name: `release-set-${'c'.repeat(40)}`, published_at: '2026-09-18T00:00:00Z', assets: [{ name: 'release-set.json', id: 456 }] })
    const getJson: GetJson = (path) => Promise.resolve(path.endsWith('/123') ? f.manifest : path.endsWith('/456') ? older : f.entries)
    expect((await publishedWebRelease('stable', getJson)).manifestReleaseSet).toBe(f.manifest.releaseSet)
  })

  it.each([[null], [[]], ['invalid']])('malformed component metadata is unavailable (%s)', async (broken) => {
    const f = fixture()
    f.manifest.components = broken
    await expect(publishedWebRelease('stable', f.getJson)).rejects.toBeInstanceOf(ReleaseUnavailable)
  })

  it('the history lookup stops at its deadline', async () => {
    const f = fixture()
    const clock = [0, 0, 16_000][Symbol.iterator]()
    await expect(publishedWebRelease('stable', f.getJson, () => clock.next().value ?? 16_000)).rejects.toThrow('deadline')
    expect(f.requests).toHaveLength(1)
  })
})

describe('Agent checkout updates', () => {
  const retained = JSON.parse(readFileSync(join(WEB_ROOT, 'sidecar/tests/fixtures/cron-retained-v0.22.1.json'), 'utf8')) as { manual: Dict; botChat: Dict }

  const obligations = (['apply', 'force'] as const).flatMap((action) => ['default', 'named'].flatMap((profile) => ['stored-result', 'unknown-result', 'bot-chat'].map((kind) => ({ action, profile, kind }))))
  it.each(['apply', 'force'] as const)('holds external writers through the %s preflight and every checkout operation', async (action) => {
    const a = agentInstall()
    const home = tmp()
    const file = join(home, 'cron/bot_chat_pending/delivery-original.json')
    let held = false
    let attempted = false
    let heldAtIntent = false
    const racingGit: GitRun = async (args, cwd, timeout) => {
      if ((action === 'apply' && args[0] === 'status') || (action === 'force' && args[0] === 'checkout')) {
        attempted = true
        if (!held) write(file, JSON.stringify(retained.botChat))
      }
      return runGit(args, cwd, timeout)
    }
    const policy = {
      supportedRevisions: [a.v2], supportedRevision: a.v2, supportedVersion: '2.0.0', retainedStateHomes: () => [home],
      beforeMutation: () => { heldAtIntent = held; return Promise.resolve() },
      withMutation: async (_path: string, _revision: string, mutate: (git: GitRun) => Promise<Dict>) => {
        held = true
        try { return await mutate(racingGit) } finally { held = false }
      },
    }
    expect(action === 'apply' ? await applyAgentUpdate(a.agent, racingGit, 'stable', policy) : await forceAgentUpdate(a.agent, racingGit, () => undefined, 'stable', policy)).toMatchObject({ ok: true })
    expect(attempted).toBe(true)
    expect(heldAtIntent).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(held).toBe(false)
  })

  it.each([false, true])('keeps the runtime writer lease through dependency repair and verifies resume before restart, failure=%s', async (resumeFailure) => {
    const a = agentInstall(true)
    const sidecar = new FakeSidecar()
    sidecar.describe = { ...sidecar.describe!, agent_dir: a.agent }
    const events: string[] = []
    let held = false
    sidecar.respond('runtime.agent_mutation', async (params) => {
      if (params.action === 'begin') { held = true; events.push('begin'); return { ok: true, skipped: false, detail: '', token: 'a'.repeat(32) } }
      if (params.action === 'git') {
        if (!held) throw new Error('unfenced Git command')
        const result = await runGit(params.args, a.agent, params.timeout_ms)
        return { ok: result.ok, skipped: false, detail: result.out }
      }
      if (params.action === 'sync') { events.push(held ? 'sync-held' : 'sync-unfenced'); return { ok: true, skipped: false, detail: '' } }
      events.push('resume'); held = false
      return { ok: !resumeFailure, skipped: false, detail: resumeFailure ? 'resume unverified, native recovery retained' : '' }
    })
    const server = await bootTestServer({ sidecar })
    try {
      const wired = (server.deps.updates as unknown as { deps: UpdateServiceDeps }).deps
      wired.scheduleRestart = () => { events.push(held ? 'restart-unfenced' : 'restart') }
      const result = await server.deps.updates.apply('agent', null, () => true, { confirmedRevision: a.v2 })
      expect(result).toMatchObject({ ok: !resumeFailure, verified_revision: a.v2, restart_scheduled: !resumeFailure })
      expect(events).toEqual(resumeFailure ? ['begin', 'sync-held', 'resume'] : ['begin', 'sync-held', 'resume', 'restart'])
      const marker = join(server.state, 'agent-dependency-sync', createHash('sha256').update(a.agent).digest('hex'))
      expect(existsSync(marker)).toBe(resumeFailure)
      expect(server.deps.updates.blocksNewWork()).toBe(!resumeFailure)
      if (!resumeFailure) expect(result.gateway_restart).toBe('resumed')
      expect(sidecar.calls.some((call) => call.method === 'runtime.sync_dependencies')).toBe(false)
    } finally { await server.close() }
  })

  it.each(['apply', 'force'] as const)('continues the selected %s update after a scoped legacy refresh confirmation', async (action) => {
    const a = agentInstall(true)
    writeFileSync(join(a.agent, 'README'), 'retained local work\n')
    git(a.agent, 'stash', 'push', '-m', 'synthetic retained changes')
    const stashes = git(a.agent, 'stash', 'list', '--format=%H')
    const sidecar = new FakeSidecar()
    sidecar.describe = { ...sidecar.describe!, agent_dir: a.agent }
    const refreshToken = 'c'.repeat(32)
    const events: string[] = []
    let intent: string | undefined
    sidecar.respond('runtime.agent_mutation', async (params) => {
      if (params.action === 'begin') {
        if (!params.refresh_token) {
          intent = params.intent
          events.push('confirm')
          return { ok: false, skipped: false, detail: 'Active dashboard work may be interrupted.', refresh_confirmation: { token: refreshToken, services: ['synthetic.dashboard'] } }
        }
        expect(params.intent).toBe(intent)
        expect(params.refresh_token).toBe(refreshToken)
        expect(params.revision).toBe(a.v2)
        events.push('refresh')
        return { ok: true, skipped: false, detail: '', token: 'a'.repeat(32) }
      }
      if (params.action === 'git') {
        const result = await runGit(params.args, a.agent, params.timeout_ms)
        return { ok: result.ok, skipped: false, detail: result.out }
      }
      events.push(params.action)
      return { ok: true, skipped: false, detail: '' }
    })
    const server = await bootTestServer({ sidecar })
    try {
      const wired = (server.deps.updates as unknown as { deps: UpdateServiceDeps }).deps
      wired.scheduleRestart = () => { events.push('restart') }
      const request = async (extra: Dict = {}) => {
        const response = await server.get(`/api/updates/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'agent', version: 'v2.0.0', confirmed_agent_revision: a.v2, ...extra }) })
        expect(response.status).toBe(200)
        return response.json() as Promise<Dict>
      }
      const pending = await request()
      expect(pending).toMatchObject({ ok: false, confirmation_required: true, candidate_revision: a.v2, agent_channel: 'stable', refresh_confirmation: { token: refreshToken, services: ['synthetic.dashboard'] } })
      expect(intent).toBeTruthy()
      expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v1)
      expect(existsSync(join(server.state, 'agent-dependency-sync', createHash('sha256').update(a.agent).digest('hex')))).toBe(false)
      const history = await (await server.get('/api/update-notifications')).json() as { notifications: Dict[] }
      expect(history.notifications.find((row) => row.id === pending.notification_id)).toMatchObject({ phase: 'awaiting_confirmation', message: 'Active dashboard work may be interrupted.' })
      const result = await request({ agent_refresh_token: refreshToken })
      expect(result).toMatchObject({ ok: true, verified_revision: a.v2, gateway_restart: 'resumed' })
      expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v2)
      expect(git(a.agent, 'stash', 'list', '--format=%H')).toBe(stashes)
      expect(events).toEqual(['confirm', 'refresh', 'sync', 'finish', 'restart'])
      const completed = await (await server.get('/api/update-notifications')).json() as { notifications: Dict[] }
      const notice = completed.notifications.find((row) => row.id === result.notification_id)
      expect(notice).toMatchObject({ phase: 'verifying' })
      expect(((notice?.steps ?? []) as Dict[]).find((step) => step.id === 'web_restart')).toMatchObject({ state: 'active' })
      expect(server.deps.updateNotifications.pendingGatewayRestarts().filter((row) => row.id === result.notification_id).map((row) => [row.phase, Array.isArray(row.baseline)])).toEqual([['verifying', true]])
    } finally { await server.close() }
  })

  it.each(['apply', 'force'] as const)('preserves lifecycle capability guidance in %s results and notifications', async (action) => {
    const a = agentInstall(true)
    const sidecar = new FakeSidecar()
    sidecar.describe = { ...sidecar.describe!, agent_dir: a.agent }
    const detail = 'synthetic.dashboard running backend lifecycle APIs are unsupported for safe Agent update custody. Backend listener identity remains unverified. Finish active work, then have the owner gracefully refresh this service through its original supervisor. Verify the successor lifecycle APIs and intended installation/profile/PID, then retry the Agent update. Any retained service recovery remains owed.'
    sidecar.respond('runtime.agent_mutation', () => ({ ok: false, skipped: false, detail, recovery_required: false }))
    writeFileSync(join(a.agent, 'README'), 'local edit\n')
    writeFileSync(join(a.agent, 'untracked'), 'local work\n')
    const before = git(a.agent, 'status', '--porcelain')
    const server = await bootTestServer({ sidecar })
    try {
      const response = await server.get(`/api/updates/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'agent', confirmed_agent_revision: a.v2 }) })
      expect(response.status).toBe(200)
      const result = await response.json() as Dict
      expect(result).toMatchObject({ ok: false })
      expect(result.message).toContain(detail)
      const history = await (await server.get('/api/update-notifications')).json() as { notifications: Dict[] }
      expect(history.notifications.find((row) => row.id === result.notification_id)).toMatchObject({ phase: 'failed', detail: result.message })
      expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v1)
      expect(git(a.agent, 'status', '--porcelain')).toBe(before)
      expect(git(a.agent, 'stash', 'list')).toBe('')
      expect(sidecar.calls.filter((call) => call.method === 'runtime.agent_mutation').map((call) => (call.params as Dict).action)).toEqual(['begin'])
    } finally { await server.close() }
  })

  const recoveryFailures = (['apply', 'force'] as const).flatMap((action) =>
    (['before-source', 'dependencies', 'local-restore', 'sidecar-death'] as const)
      .filter((failure) => action !== 'force' || failure !== 'local-restore').map((failure) => ({ action, failure })))
  it.each(recoveryFailures)('the same server recovers $action after $failure without another update or handshake', async ({ action, failure }) => {
    const a = agentInstall(true)
    if (failure === 'local-restore') writeFileSync(join(a.agent, 'README'), 'preserved local edits\n')
    const sidecar = new FakeSidecar()
    sidecar.describe = { ...sidecar.describe!, agent_dir: a.agent, agent_revision: a.v1 }
    let owed = false
    let injected = false
    let lease = false
    let restores = 0
    let recoveries = 0
    let loaded = a.v1
    const begins: string[] = []
    let operation: import('@maudecode/talaria-web-contracts').AgentUpdateOperation | undefined
    sidecar.respond('runtime.agent_mutation', async (params) => {
      if (params.action === 'begin') {
        begins.push(params.revision)
        if (params.operation_id && params.baseline_revision) operation = { operation_id: params.operation_id, baseline_revision: params.baseline_revision, target_revision: params.revision, stage: 'install', source_moved: failure !== 'before-source' }
        if (failure === 'before-source' && !injected) {
          injected = owed = true
          return { ok: false, skipped: false, detail: 'synthetic supervisor disarm failure' }
        }
        lease = true
        return { ok: true, skipped: false, detail: '', token: 'd'.repeat(32) }
      }
      if (!lease) throw new Error('synthetic writer lease disconnected')
      if (params.action === 'git') {
        const result = await runGit(params.args, a.agent, params.timeout_ms)
        if (result.ok && ['merge', 'reset'].includes(params.args[0]!) && !injected && ['local-restore', 'sidecar-death'].includes(failure)) {
          injected = owed = true
          lease = false
          throw new Error('synthetic writer lease disconnected after source move')
        }
        return { ok: result.ok, skipped: false, detail: result.out }
      }
      if (params.action === 'sync' && failure === 'dependencies' && !injected) {
        injected = owed = true
        return { ok: false, skipped: false, detail: 'synthetic dependency failure' }
      }
      return { ok: recoveries > 0 || !owed, skipped: false, detail: owed ? 'synthetic dependency/lease recovery remains owed' : '' }
    })
    const recovered = failure === 'before-source' || failure === 'local-restore' ? a.v1 : a.v2
    sidecar.respond('runtime.agent_recovery', (params) => {
      if (params.probe) return { ok: !owed, owed, fingerprint: owed ? 'retained' : '', detail: '', ...(operation ? { operation } : {}) }
      if (params.complete_revision) {
        expect(params.complete_revision).toBe(recovered)
        owed = false
        if (operation) operation = { ...operation, stage: 'agent_ready', recovered_revision: recovered }
        return { ok: true, owed: false, fingerprint: '', detail: '', revision: recovered, ...(operation ? { operation } : {}) }
      }
      recoveries += 1
      if (recoveries === 1) return { ok: false, owed: true, fingerprint: 'retained', detail: 'synthetic repair is not ready' }
      if (failure === 'local-restore' && restores++ === 0) {
        // This is the native source-repair response; the real server restores its pending autostash next.
        git(a.agent, 'reset', '--hard', a.v1)
        return { ok: true, owed: true, fingerprint: 'retained', detail: '', local_restore: true, revision: a.v1 }
      }
      if (recovered === loaded) { owed = false; if (operation) operation = { ...operation, stage: 'agent_ready', recovered_revision: recovered } }
      return { ok: true, owed, fingerprint: owed ? 'retained' : '', detail: '', revision: recovered, runtime_pending: owed, ...(operation ? { operation } : {}) }
    })
    sidecar.respond('runtime.status', () => ({ ...sidecar.describe!, agent_revision: loaded }))
    sidecar.respond('runtime.ensure_current', () => {
      expect(loaded).toBe(recovered)
      return { current: true, agent_revision: loaded }
    })
    vi.spyOn(sidecar, 'recycle').mockImplementation((reason) => {
      sidecar.recycled.push(reason)
      loaded = git(a.agent, 'rev-parse', 'HEAD')
      sidecar.describe = { ...sidecar.describe!, agent_revision: loaded }
      sidecar.status = 'ready'
    })
    const server = await bootTestServer({ sidecar })
    const svc = server.deps.updates
    const wire = (svc as unknown as { deps: UpdateServiceDeps }).deps
    const phases: string[] = []
    const notify = wire.recoveryChanged!
    const transitions: AgentRecoveryState[] = []
    let wake: ((state: AgentRecoveryState) => void) | undefined
    const nextTransition = (): Promise<AgentRecoveryState> => new Promise((resolve) => {
      const ready = transitions.shift()
      if (ready) resolve(ready)
      else wake = resolve
    })
    wire.recoveryChanged = async (state) => {
      phases.push(state.phase)
      await notify(state)
      const row = (await server.deps.updateNotifications.list({ owner: 'local-owner', profile: 'default', serverOwner: true, tab: 'tab-recovery' })).tab_update
      if (row && ['running', 'waiting'].includes(state.phase)) expect(row).toMatchObject({ phase: 'recovering', active: true, presents_dialog: true, dialog_close: 'none' })
      if (['waiting', 'complete', 'blocked'].includes(state.phase)) {
        if (wake) { const resolve = wake; wake = undefined; resolve(state) }
        else transitions.push(state)
      }
    }
    let channel: 'stable' | 'experimental' = 'experimental'
    wire.agentChannel = () => channel
    wire.checkEnabled = () => false
    wire.autoApply = () => false
    wire.scheduleRestart = () => { throw new Error('recovery must not schedule a Web restart') }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      svc.startAutoApply()
      await vi.advanceTimersByTimeAsync(1)
      const response = await server.get(`/api/updates/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'agent', agent_channel: channel, confirmed_agent_revision: a.v2, tab_id: 'tab-recovery' }) })
      expect(response.status).toBe(200)
      const failed = await response.json() as Dict
      const initial = await (await server.get('/api/update-notifications?tab_id=tab-recovery')).json() as { tab_update: Dict }
      expect(initial.tab_update).toMatchObject({ id: failed.notification_id, phase: 'recovering', active: true, dialog_close: 'none' })
      expect(failed.notification_id).toBe(operation?.operation_id)
      const joined = await (await server.get(`/api/updates/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'agent', tab_id: 'tab-secondclient' }) })).json() as Dict
      expect(joined).toMatchObject({ status: 'already_in_progress', notification_id: failed.notification_id })
      expect(begins).toHaveLength(1)
      expect(failed.ok).toBe(false)
      expect(injected).toBe(true)
      channel = 'stable'
      git(a.origin, 'commit', '--allow-empty', '-m', 'newer release during retained recovery')
      git(a.origin, 'tag', 'v3.0.0')
      let delay = 0
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const changed = nextTransition()
        const probes = sidecar.calls.filter((call) => call.method === 'runtime.agent_recovery').length
        await vi.advanceTimersByTimeAsync(delay)
        expect(sidecar.calls.filter((call) => call.method === 'runtime.agent_recovery').length).toBeGreaterThan(probes)
        const state = await changed
        if (state.phase === 'complete') break
        expect(state.phase).toBe('waiting')
        // Keep the virtual clock still while the real Git/filesystem work completes.
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        delay = Math.max(0, new Date(state.retry_at!).getTime() - Date.now()) + 1
      }
      expect(svc.cachedStatus().agent_recovery).toMatchObject({ phase: 'complete' })
      expect(phases).toContain('waiting')
      expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(recovered)
      expect(failed.ok).toBe(false)
      expect(begins).toEqual(failure === 'local-restore' ? [a.v2, a.v1] : [a.v2])
      expect(sidecar.recycled).toHaveLength(recovered === a.v1 ? 0 : 1)
      if (failure === 'local-restore') expect(readFileSync(join(a.agent, 'README'), 'utf8')).toBe('preserved local edits\n')
      svc.stopAutoApply()
      vi.useRealTimers()
      const history = await (await server.get('/api/update-notifications')).json() as { notifications: Dict[] }
      expect(history.notifications.find((row) => row.id === failed.notification_id)).toMatchObject({ phase: recovered === a.v2 ? 'succeeded' : 'failed', verified_revision: recovered, active: false, recovery: { outcome: recovered === a.v2 ? 'target_installed' : 'baseline_restored' } })
      const final = history.notifications.find((row) => row.id === failed.notification_id)!
      expect(final).toMatchObject({ recovery: { rollback: failure === 'local-restore' } })
      if (failure === 'before-source') expect(final.message).toContain('no rollback occurred')
      if (failure === 'local-restore') expect(final.message).toContain('rolled back to the previous revision')
      expect(history.notifications.some((row) => row.kind === 'agent_recovery')).toBe(false)
    } finally { svc.stopAutoApply(); vi.useRealTimers(); await server.close() }
  })

  it.each(['apply', 'force'] as const)('refuses a source revision changed while acquiring the %s writer lease', async (action) => {
    const a = agentInstall()
    let changed = ''
    const intent = vi.fn(() => Promise.resolve())
    const policy = {
      supportedRevisions: [a.v2], supportedRevision: a.v2, supportedVersion: '2.0.0', beforeMutation: intent,
      withMutation: async (_path: string, _revision: string, mutate: (git: GitRun) => Promise<Dict>) => {
        git(a.agent, 'commit', '--allow-empty', '-m', 'a concurrent updater won the lease first')
        changed = git(a.agent, 'rev-parse', 'HEAD')
        return mutate(runGit)
      },
    }
    const result = action === 'apply' ? await applyAgentUpdate(a.agent, runGit, 'stable', policy) : await forceAgentUpdate(a.agent, runGit, () => undefined, 'stable', policy)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('source changed')
    expect(intent).not.toHaveBeenCalled()
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(changed)
  })

  it.each([false, true])('keeps checks read-only and recovers interrupted local edits only under the writer lease, installed=%s', async (installed) => {
    const a = agentInstall()
    writeFileSync(join(a.agent, 'README'), 'local note\n')
    const saved = git(a.agent, 'stash', 'create', 'interrupted update')
    git(a.agent, 'update-ref', `refs/talaria/autostash/pending/${saved}`, saved)
    git(a.agent, 'checkout', '--', 'README')
    if (installed) { git(a.agent, 'fetch', 'origin', '--tags'); git(a.agent, 'reset', '--hard', a.v2) }
    const before = readFileSync(join(a.agent, 'README'), 'utf8')
    const checked = await checkAgentUpdate(a.agent, runGit)
    expect(readFileSync(join(a.agent, 'README'), 'utf8')).toBe(before)
    expect(checked.metadata_repair).toBe(true)
    let held = false
    const unfenced: string[] = []
    const observed: GitRun = (args, cwd, timeout) => {
      if (['apply', 'merge', 'reset', 'checkout'].includes(args[0]!) && !held) unfenced.push(args[0]!)
      return runGit(args, cwd, timeout)
    }
    const policy = { supportedRevisions: [a.v2], supportedRevision: a.v2, supportedVersion: '2.0.0',
      withMutation: async (_path: string, _revision: string, mutate: (git: GitRun) => Promise<Dict>) => {
        held = true
        try { return await mutate(observed) } finally { held = false }
      } }
    const result = await applyAgentUpdate(a.agent, observed, 'stable', policy)
    expect(result.ok).toBe(true)
    expect(readFileSync(join(a.agent, 'README'), 'utf8')).toBe('local note\n')
    expect(unfenced).toEqual([])
    expect(git(a.agent, 'for-each-ref', '--format=%(refname)', 'refs/talaria/autostash/pending')).toBe('')
  })

  it.each(obligations)('retained cron obligations stop $action for $profile/$kind before source, stash, or dependency intent changes', async ({ action, profile, kind }) => {
    const a = agentInstall(true)
    const home = join(tmp(), profile === 'default' ? 'home' : 'home/profiles/named')
    const file = join(home, 'cron', kind === 'bot-chat' ? 'bot_chat_pending/delivery-original.json' : 'manual_runs/job-original.json')
    const record = kind === 'bot-chat' ? retained.botChat : { ...retained.manual, ...(kind === 'stored-result' ? { result: [true, 'output', 'answer', null] } : {}) }
    write(file, JSON.stringify(record))
    write(join(a.agent, 'README'), 'local change\n')
    write(join(a.agent, 'untracked'), 'local untracked\n')
    git(a.agent, 'stash', 'push', '-m', 'preexisting')
    write(join(a.agent, 'README'), 'another local change\n')
    const before = { head: git(a.agent, 'rev-parse', 'HEAD'), status: git(a.agent, 'status', '--porcelain'), stash: stashes(a.agent), record: readFileSync(file, 'utf8') }
    const intent = vi.fn(() => Promise.resolve())
    const policy = { supportedRevisions: [a.v2], supportedRevision: a.v2, supportedVersion: '2.0.0', retainedStateHomes: () => [home], beforeMutation: intent }
    const result = action === 'apply' ? await applyAgentUpdate(a.agent, runGit, 'stable', policy) : await forceAgentUpdate(a.agent, runGit, () => undefined, 'stable', policy)
    expect(result, `${profile}/${kind}`).toMatchObject({ ok: false, recovery_compatibility: { manual_execution: kind === 'bot-chat', bot_chat_delivery: kind !== 'bot-chat' } })
    expect(result.message).toContain('Reconcile')
    expect(intent).not.toHaveBeenCalled()
    expect({ head: git(a.agent, 'rev-parse', 'HEAD'), status: git(a.agent, 'status', '--porcelain'), stash: stashes(a.agent), record: readFileSync(file, 'utf8') }).toEqual(before)
  })

  it.each(['apply', 'force'] as const)('allows %s with empty state, completed delivery evidence, or a matching legacy format', async (action) => {
    for (const state of ['empty', 'settled', 'legacy']) {
      const a = agentInstall()
      write(join(a.origin, 'cron/bot_chat_delivery.py'), 'def drain():\n    pass\n')
      git(a.origin, 'add', '.')
      git(a.origin, 'commit', '-m', 'legacy reader')
      git(a.origin, 'tag', '-f', 'v2.0.0')
      const target = git(a.origin, 'rev-parse', 'HEAD')
      const home = tmp()
      if (state !== 'empty') write(join(home, 'cron/bot_chat_pending/delivery-original.json'), JSON.stringify({ ...retained.botChat, ...(state === 'settled' ? { status: 'transferred' } : { profile: '' }) }))
      const policy = { supportedRevisions: [target], supportedRevision: target, supportedVersion: '2.0.0', retainedStateHomes: () => [home] }
      expect(action === 'apply' ? await applyAgentUpdate(a.agent, runGit, 'stable', policy) : await forceAgentUpdate(a.agent, runGit, () => undefined, 'stable', policy)).toMatchObject({ ok: true, verified_revision: target })
    }
  })

  it('allows retained obligations with compatible canonical target readers, inspecting only target blobs', async () => {
    const a = agentInstall()
    for (const [file, names] of [
      ['cron/scheduler_authority.py', ['journal_path', '_lift_pause']], ['cron/scheduler_bookkeeping.py', ['fail_empty_response', 'finish_completed_run']],
      ['hermes_cli/gateway_client.py', ['connect_gateway']], ['hermes_cli/gateway_runtime.py', ['discover_gateway_endpoint']],
      ['cron/executions.py', ['give_up_execution', 'recover_receipted_execution']], ['cron/bot_chat_legacy.py', ['drain_legacy_pending']],
    ] as const) write(join(a.origin, file), `raise AssertionError('candidate must never be imported')\n${names.map((name) => `def ${name}():\n    pass\n`).join('')}`)
    git(a.origin, 'add', '.')
    git(a.origin, 'commit', '-m', 'canonical readers')
    git(a.origin, 'tag', '-f', 'v2.0.0')
    const target = git(a.origin, 'rev-parse', 'HEAD')
    const home = tmp()
    write(join(home, 'cron/manual_runs/job-original.json'), JSON.stringify(retained.manual))
    write(join(home, 'cron/bot_chat_pending/delivery-original.json'), JSON.stringify(retained.botChat))
    expect(await applyAgentUpdate(a.agent, runGit, 'stable', { supportedRevisions: [target], supportedRevision: target, supportedVersion: '2.0.0', retainedStateHomes: () => [home] })).toMatchObject({ ok: true, verified_revision: target })
  })

  it('holds on unreadable evidence, failed target inspection, and explicit acknowledgement of an incompatible revision', async () => {
    const a = agentInstall(true)
    const home = tmp()
    const file = join(home, 'cron/bot_chat_pending/delivery-original.json')
    const intent = vi.fn(() => Promise.resolve())
    const policy = { supportedRevisions: [a.v1], supportedRevision: a.v1, supportedVersion: '1.0.0', confirmedRevision: a.v2, retainedStateHomes: () => [home], beforeMutation: intent }
    write(file, 'broken json')
    const unreadable = await applyAgentUpdate(a.agent, runGit, 'stable', policy)
    expect(unreadable.ok).toBe(false)
    expect(unreadable.message).toContain('could not be verified')
    write(file, JSON.stringify(retained.botChat))
    const failedTree: GitRun = (args, cwd, timeout) => args[0] === 'ls-tree' ? Promise.resolve({ ok: false, out: 'unreadable tree' }) : runGit(args, cwd, timeout)
    const unverified = await forceAgentUpdate(a.agent, failedTree, () => undefined, 'stable', policy)
    expect(unverified.ok).toBe(false)
    expect(unverified.message).toContain('could not be verified')
    expect(await applyAgentUpdate(a.agent, runGit, 'stable', policy)).toMatchObject({ ok: false, recovery_compatibility: { bot_chat_delivery: false } })
    expect(intent).not.toHaveBeenCalled()
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v1)
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(retained.botChat))
  })

  it('checks retained compatibility before repairing an already-installed Agent dependency marker', async () => {
    const a = agentInstall(true)
    const events: string[] = []
    const stateDir = tmp()
    const home = tmp()
    const sync = vi.fn(() => Promise.resolve({ ok: false, skipped: false, detail: 'retry' }))
    const svc = agentService(a.agent, runGit, events, sync, stateDir, () => [home])
    const failed = await svc.apply('agent', null, () => true, { confirmedRevision: a.v2 })
    expect(failed.ok).toBe(false)
    expect(failed.message).toContain('dependency sync failed')
    const marker = join(stateDir, 'agent-dependency-sync', createHash('sha256').update(a.agent).digest('hex'))
    const original = readFileSync(marker, 'utf8')
    sync.mockClear()
    write(join(home, 'cron/manual_runs/job-original.json'), JSON.stringify(retained.manual))
    expect(await svc.apply('agent')).toMatchObject({ ok: false, recovery_compatibility: { manual_execution: false } })
    expect(readFileSync(marker, 'utf8')).toBe(original)
    expect(sync).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it.each([false, true])('resolves shared profile homes at the runtime boundary, isolated=%s', async (isolated) => {
    const a = agentInstall()
    const base = tmp()
    const named = join(base, 'profiles/named')
    mkdirSync(named, { recursive: true })
    const recordHome = isolated ? base : named
    write(join(recordHome, 'cron/manual_runs/job-original.json'), JSON.stringify(retained.manual))
    const server = await bootTestServer({ sidecar: null, env: { HERMES_HOME: isolated ? named : base, HERMES_WEBUI_ISOLATED_PROFILE: isolated ? '1' : '0' } })
    try {
      const wired = (server.deps.updates as unknown as { deps: UpdateServiceDeps }).deps
      const homes = wired.agentHomes!()
      expect(homes).toEqual(isolated ? [named] : [base, named])
      expect(await applyAgentUpdate(a.agent, runGit, 'stable', { supportedRevisions: [a.v2], supportedRevision: a.v2, supportedVersion: '2.0.0', retainedStateHomes: () => homes })).toMatchObject({ ok: isolated })
    } finally { await server.close() }
  })

  it('counts actual commits, not release gaps, and keeps Experimental distinct from Stable', async () => {
    const a = agentInstall()
    for (let i = 0; i < 4; i++) git(a.origin, 'commit', '--allow-empty', '-m', `unreleased ${i}`)
    git(a.origin, 'tag', '-f', 'v2.0.0') // One release gap contains five real commits.
    const stable = git(a.origin, 'rev-parse', 'HEAD')
    git(a.origin, 'commit', '--allow-empty', '-m', 'experimental only')
    const main = git(a.origin, 'rev-parse', 'HEAD')
    expect(await checkAgentUpdate(a.agent, runGit)).toMatchObject({ behind: 5, latest_sha: stable, channel: 'stable' })
    expect(await checkAgentUpdate(a.agent, runGit, 'experimental')).toMatchObject({ behind: 6, latest_sha: main, channel: 'experimental' })
  })

  it('requires acknowledgement of the exact unsupported Agent target before changing files', async () => {
    const a = agentInstall()
    const policy = { supportedRevisions: [a.v1], supportedRevision: a.v1, supportedVersion: '1.0.0' }
    const result = await applyAgentUpdate(a.agent, runGit, 'stable', policy)
    expect(result).toMatchObject({ ok: false, confirmation_required: true, candidate_revision: a.v2 })
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v1)
    expect(await applyAgentUpdate(a.agent, runGit, 'stable', { ...policy, confirmedRevision: a.v1 })).toMatchObject({ ok: false, confirmation_required: true })
    expect(await applyAgentUpdate(a.agent, runGit, 'stable', { ...policy, confirmedRevision: a.v2 })).toMatchObject({ ok: true, verified_revision: a.v2, verified_version: 'v2.0.0' })
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v2)
  })

  it('rejects a moved confirmation and protects local files on the force path', async () => {
    const a = agentInstall()
    const policy = { supportedRevisions: [a.v1], supportedRevision: a.v1, supportedVersion: '1.0.0' }
    writeFileSync(join(a.agent, 'README'), 'local work\n')
    expect(await forceAgentUpdate(a.agent, runGit, () => undefined, 'stable', policy)).toMatchObject({ ok: false, confirmation_required: true })
    expect(readFileSync(join(a.agent, 'README'), 'utf8')).toBe('local work\n')
    git(a.origin, 'commit', '--allow-empty', '-m', 'new candidate')
    git(a.origin, 'tag', 'v3.0.0')
    const next = git(a.origin, 'rev-parse', 'HEAD')
    expect(await applyAgentUpdate(a.agent, runGit, 'stable', { ...policy, confirmedRevision: a.v2 })).toMatchObject({ ok: false, candidate_revision: next })
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v1)
    expect(readFileSync(join(a.agent, 'README'), 'utf8')).toBe('local work\n')
    expect(await applyAgentUpdate(a.agent, runGit, 'stable', { supportedRevisions: [next], supportedRevision: next, supportedVersion: '3.0.0', confirmedRevision: a.v2 })).toMatchObject({ ok: false })
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v1)
    expect(await applyAgentUpdate(a.agent, runGit, 'stable', { supportedRevisions: [next], supportedRevision: next, supportedVersion: '3.0.0' })).toMatchObject({ ok: true })
  })

  it('requires exact confirmation before force-cleaning an already-installed unsupported revision', async () => {
    const a = agentInstall()
    await checkAgentUpdate(a.agent, runGit)
    git(a.agent, 'merge', '--ff-only', a.v2)
    writeFileSync(join(a.agent, 'README'), 'preserve local edit\n')
    writeFileSync(join(a.agent, 'untracked.txt'), 'preserve untracked file\n')
    const policy = { supportedRevisions: [a.v1], supportedRevision: a.v1, supportedVersion: '1.0.0' }
    expect(await applyAgentUpdate(a.agent, runGit, 'stable', policy)).toMatchObject({ ok: true, up_to_date: true })
    expect(await forceAgentUpdate(a.agent, runGit, () => undefined, 'stable', policy)).toMatchObject({ ok: false, confirmation_required: true, candidate_revision: a.v2 })
    expect(readFileSync(join(a.agent, 'README'), 'utf8')).toBe('preserve local edit\n')
    expect(readFileSync(join(a.agent, 'untracked.txt'), 'utf8')).toBe('preserve untracked file\n')
    expect(await forceAgentUpdate(a.agent, runGit, () => undefined, 'stable', { ...policy, confirmedRevision: a.v2 })).toMatchObject({ ok: true })
    expect(readFileSync(join(a.agent, 'README'), 'utf8')).toBe('agent\n')
    expect(existsSync(join(a.agent, 'untracked.txt'))).toBe(false)
  })

  it('ranks semantic Agent releases above the legacy date tags', async () => {
    const a = agentInstall()
    git(a.origin, 'tag', '-d', 'v1.0.0', 'v2.0.0')
    git(a.agent, 'tag', '-d', 'v1.0.0')
    git(a.origin, 'tag', 'v2026.9.21', a.v1)
    git(a.origin, 'tag', 'v2026.9.24', a.v2)
    await checkAgentUpdate(a.agent, runGit)
    git(a.agent, 'merge', '--ff-only', a.v2)
    git(a.origin, 'commit', '--allow-empty', '-m', 'first semantic release')
    git(a.origin, 'tag', 'v0.21.6')
    const next = git(a.origin, 'rev-parse', 'HEAD')
    git(a.origin, 'commit', '--allow-empty', '-m', 'nightly canary')
    git(a.origin, 'tag', 'v0.21.6+canary.20261011T070142Z')
    expect(await checkAgentUpdate(a.agent, runGit)).toMatchObject({ current_version: 'v2026.9.24', latest_version: 'v0.21.6', latest_sha: next, behind: 1 })
  })

  it('reports an installed release only when HEAD is exactly that tag', async () => {
    const a = agentInstall()
    expect(await checkAgentUpdate(a.agent, runGit)).toMatchObject({ current_version: 'v1.0.0' })
    git(a.agent, 'commit', '--allow-empty', '-m', 'local work after v1.0.0')
    const head = git(a.agent, 'rev-parse', 'HEAD')
    expect(await checkAgentUpdate(a.agent, runGit)).toMatchObject({ current_version: head.slice(0, 12) })
  })

  it('an unavailable commit count stays unknown and Stable never falls back to a branch', async () => {
    const a = agentInstall()
    const unreadable: GitRun = (args, cwd, timeout) => args[0] === 'rev-list' ? Promise.resolve({ ok: false, out: 'unreadable' }) : runGit(args, cwd, timeout)
    expect(await checkAgentUpdate(a.agent, unreadable)).toMatchObject({ behind: null, error: 'Agent commit count is unavailable' })
    for (const repo of [a.origin, a.agent]) for (const tag of ['v1.0.0', 'v2.0.0']) git(repo, 'tag', '-d', tag)
    expect(await checkAgentUpdate(a.agent, runGit)).toMatchObject({ behind: null, error: 'No stable Agent release is available' })
    expect(await checkAgentUpdate(a.agent, runGit, 'experimental')).toMatchObject({ behind: 1, channel: 'experimental' })
  })

  it('keys the update cache by the independent Agent channel', async () => {
    const a = agentInstall()
    const s = sourceInstall()
    git(a.origin, 'commit', '--allow-empty', '-m', 'experimental only')
    const latest = git(a.origin, 'rev-parse', 'HEAD')
    let channel: 'stable' | 'experimental' = 'stable'
    const svc = updateService({
      webRoot: web(s.client), git: (args, cwd, timeout) => cwd === a.agent ? runGit(args, cwd, timeout) : s.run(args, cwd, timeout), getJson: noReleases, identity: s.identity, webuiVersion: 'test',
      agentDir: () => a.agent, channel: () => 'experimental', agentChannel: () => channel, includeAgent: () => true,
      blockers: () => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false }),
      scheduleRestart: () => undefined, log: () => undefined,
    })
    const stable = await svc.check()
    expect(stable).toMatchObject({ channel: 'experimental', agent_channel: 'stable', agent: { latest_sha: a.v2, behind: 1 } })
    channel = 'experimental'
    expect(svc.cachedStatus()).toMatchObject({ agent: null, stale_agent_channel: true })
    expect(await svc.check()).toMatchObject({ channel: 'experimental', agent_channel: 'experimental', agent: { latest_sha: latest, behind: 2 } })
  })

  it.each(['main', 'master'])('recovers a dangling default-branch reference using %s', async (branch) => {
    const a = agentInstall()
    if (branch === 'main') git(a.origin, 'branch', '-m', 'master', 'main')
    else {
      git(a.origin, 'branch', '-m', 'master', 'old-default')
      git(a.agent, 'fetch', '--prune', 'origin')
      git(a.agent, 'remote', 'set-head', 'origin', '--auto')
      git(a.origin, 'branch', '-m', 'old-default', 'master')
    }
    git(a.agent, 'fetch', '--prune', 'origin')
    const staleHead = git(a.agent, 'symbolic-ref', 'refs/remotes/origin/HEAD')
    expect(staleHead).not.toBe(`refs/remotes/origin/${branch}`)
    expect(await checkAgentUpdate(a.agent, runGit, 'experimental')).toMatchObject({ channel: 'experimental', branch: `origin/${branch}`, behind: 1, latest_sha: a.v2 })
    expect(await applyAgentUpdate(a.agent, runGit, 'experimental', { supportedRevisions: [a.v2], supportedRevision: a.v2, supportedVersion: '2.0.0' })).toMatchObject({ ok: true })
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v2)
  })

  it('preserves a resolvable custom default branch instead of preferring main', async () => {
    const a = agentInstall()
    git(a.origin, 'branch', 'main', a.v1)
    git(a.origin, 'branch', '-m', 'master', 'trunk')
    git(a.agent, 'fetch', '--prune', 'origin')
    git(a.agent, 'remote', 'set-head', 'origin', '--auto')
    expect(await checkAgentUpdate(a.agent, runGit, 'experimental')).toMatchObject({ branch: 'origin/trunk', behind: 1, latest_sha: a.v2 })
  })

  it.each(['main', 'trunk'])('follows the authoritative default %s when the former default is retained', async (branch) => {
    const a = agentInstall()
    git(a.origin, 'checkout', '-b', branch)
    git(a.origin, 'commit', '--allow-empty', '-m', 'new default')
    const target = git(a.origin, 'rev-parse', 'HEAD')
    git(a.agent, 'fetch', 'origin', '--tags', '--force')
    expect(git(a.agent, 'symbolic-ref', 'refs/remotes/origin/HEAD')).toBe('refs/remotes/origin/master')
    expect(git(a.agent, 'rev-parse', 'origin/master')).toBe(a.v2)
    expect(await checkAgentUpdate(a.agent, runGit, 'experimental')).toMatchObject({ branch: `origin/${branch}`, behind: 2, latest_sha: target })
    expect(await applyAgentUpdate(a.agent, runGit, 'experimental', { supportedRevisions: [target], supportedRevision: target, supportedVersion: '3.0.0' })).toMatchObject({ ok: true, verified_revision: target, verified_version: null })
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(target)
  })

  it('fails closed when the authoritative default cannot be refreshed', async () => {
    const a = agentInstall()
    writeFileSync(join(a.agent, 'README'), 'preserve local edit\n')
    const unavailable: GitRun = (args, cwd, timeout) => args[0] === 'remote' && args[1] === 'set-head'
      ? Promise.resolve({ ok: false, out: 'remote unavailable' }) : runGit(args, cwd, timeout)
    const stable = await checkAgentUpdate(a.agent, unavailable, 'stable')
    expect(stable.behind).toBe(1)
    expect(stable.error).toBeUndefined()
    expect(await checkAgentUpdate(a.agent, unavailable, 'experimental')).toMatchObject({ behind: null, error: 'Agent default branch could not be refreshed from origin' })
    expect(await applyAgentUpdate(a.agent, unavailable, 'experimental')).toMatchObject({ ok: false })
    expect(await forceAgentUpdate(a.agent, unavailable, () => undefined, 'experimental')).toMatchObject({ ok: false })
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v1)
    expect(readFileSync(join(a.agent, 'README'), 'utf8')).toBe('preserve local edit\n')
  })

  it.each([
    ['the updater deadline', 'git fetch origin --quiet --tags --force timed out after 15s', 'The update check timed out after 15s. Try again.', 'The update check timed out after 15s. Try again.'],
    ['a libcurl stall', 'fatal: unable to access \'https://example.invalid/agent.git/\': Operation timed out after 30000 milliseconds with 0 bytes received', 'Could not reach the remote repository. Check your internet connection and try again.', 'Could not reach the remote repository. Check your connection.'],
    ['an unresolved host', 'fatal: unable to access \'https://example.invalid/agent.git/\': Could not resolve host: example.invalid', 'Could not reach the remote repository. Check your internet connection and try again.', 'Could not reach the remote repository. Check your connection.'],
    ['another fetch failure', 'fatal: couldn\'t find remote ref refs/heads/gone', 'fetch failed: fatal: couldn\'t find remote ref refs/heads/gone', 'fetch failed: fatal: couldn\'t find remote ref refs/heads/gone'],
  ])('reports a fetch failure from %s with its own wording (TAL-1149)', async (_case, out, applyMessage, forceMessage) => {
    const agent = tmp()
    mkdirSync(join(agent, '.git'))
    const failing: GitRun = () => Promise.resolve({ ok: false, out })
    expect(await applyAgentUpdate(agent, failing)).toEqual({ ok: false, message: applyMessage })
    expect(await forceAgentUpdate(agent, failing, () => undefined)).toEqual({ ok: false, message: forceMessage })
  })

  it('keeps a locked fetch a lock conflict, not a timeout (TAL-1149)', async () => {
    const agent = tmp()
    mkdirSync(join(agent, '.git'))
    const locked: GitRun = () => Promise.resolve({ ok: false, out: "fatal: Unable to create '/agent/.git/index.lock': File exists." })
    expect(await applyAgentUpdate(agent, locked)).toMatchObject({ ok: false, lock_conflict: true })
  })

  /** TAL-1025: synthetic secrets git echoes from a credentialed remote; none may survive into a returned payload. */
  const SECRETS = ['SUFFIX_PRIVATE', 'synthetic-password', 'PRIVATE_PW', 'ghp_SYNTHETICSYNTHETICSYNTHETIC']
  const CREDENTIALED = "'https://agent:synthetic-password@example.invalid/agent.git/?token=synthetic'SUFFIX_PRIVATE'"
  const LOCKED = `fatal: Unable to create '/agent/.git/index.lock': File exists. Another git process seems to be running; remote https://agent:pass'PRIVATE_PW@example.invalid/agent.git?token=synthetic'SUFFIX_PRIVATE`
  const expectNoSecret = (result: Dict): void => { for (const secret of SECRETS) expect(JSON.stringify(result)).not.toContain(secret) }

  it('masks an apostrophe-bearing query secret in a failed Agent check (TAL-1025)', async () => {
    const agent = tmp()
    mkdirSync(join(agent, '.git'))
    const failing: GitRun = () => Promise.resolve({ ok: false, out: `fatal: unable to access ${CREDENTIALED}: The requested URL returned error: 403` })
    vi.useFakeTimers()
    let result: Dict
    try {
      const pending = checkAgentUpdate(agent, failing)
      await vi.advanceTimersByTimeAsync(FETCH_RETRY_MS)
      result = await pending
    } finally { vi.useRealTimers() }
    expectNoSecret(result)
    expect(result).toMatchObject({ behind: null, stale_check: true,
      error: "fetch failed: fatal: unable to access 'https://<redacted>@example.invalid/agent.git/?token=<redacted>': The requested URL returned error: 403" })
  })

  it.each([
    ['apply', 'a locked fetch', LOCKED, true],
    ['force', 'a locked fetch', LOCKED, true],
    ['apply', 'a credentialed fetch failure', `fatal: repository ${CREDENTIALED} not found`, false],
    ['force', 'a credentialed fetch failure', `fatal: repository ${CREDENTIALED} not found`, false],
  ] as const)('%s keeps %s free of credentials (TAL-1025)', async (action, _case, out, lock) => {
    const agent = tmp()
    mkdirSync(join(agent, '.git'))
    const failing: GitRun = () => Promise.resolve({ ok: false, out })
    const result = action === 'apply' ? await applyAgentUpdate(agent, failing) : await forceAgentUpdate(agent, failing, () => undefined)
    expectNoSecret(result)
    expect(result.ok).toBe(false)
    expect(result.lock_conflict).toBe(lock || undefined)
    expect(String(result.message)).toContain('fetch failed')
  })

  it.each([
    ['status', LOCKED, 'Failed to inspect repo status due to a repository lock: ', true],
    ['status', `fatal: ${CREDENTIALED} ${'x'.repeat(190)} ghp_SYNTHETICSYNTHETICSYNTHETIC`, 'Failed to inspect repo status: ', false],
    ['merge', LOCKED, 'Pull failed due to a repository lock: ', true],
    ['merge', `fatal: ${CREDENTIALED} was rejected`, 'Pull failed: ', false],
    ['merge', `error: RPC failed; partial output from ${CREDENTIALED} before git merge --ff-only timed out after 30s`, 'Pull failed: ', false],
  ] as const)('a failed Agent %s step exposes only its sanitized diagnostic (TAL-1025)', async (step, out, prefix, lock) => {
    // In-process: a synthetic Stable checkout one release behind, failing only at the injected step.
    const agent = tmp()
    mkdirSync(join(agent, '.git'))
    const [v1, v2] = ['1'.repeat(40), '2'.repeat(40)]
    const calls: string[] = []
    const fake: GitRun = (args) => {
      calls.push(args[0] ?? '')
      const ok = (text = ''): Promise<GitOutcome> => Promise.resolve({ ok: true, out: text })
      if (args[0] === step) return Promise.resolve({ ok: false, out })
      if (args[0] === 'tag') return ok(args.includes('--merged') ? 'v2.0.0' : 'v2.0.0\nv1.0.0')
      if (args[0] === 'remote') return ok('https://example.invalid/agent.git')
      if (args[0] === 'rev-parse') return ok(args[1] === 'HEAD' ? v1 : v2)
      if (args[0] === 'rev-list') return ok('1')
      if (args[0] === 'describe') return Promise.resolve({ ok: false, out: 'no tag' })
      return ok()
    }
    const result = await applyAgentUpdate(agent, fake, 'stable', { supportedRevisions: [v2], supportedRevision: v2, supportedVersion: '2.0.0' })
    expectNoSecret(result)
    expect(result.ok).toBe(false)
    expect(result.lock_conflict).toBe(lock || undefined)
    expect(String(result.message).startsWith(prefix)).toBe(true)
    expect(String(result.message)).toContain('<redacted>')
    expect(calls.includes('merge')).toBe(step === 'merge')
  })

  it('masks quoted, short and token-shaped secrets, keeping text outside them (TAL-1025)', () => {
    expect(sanitizeGitDiagnostic(`fatal: unable to access ${CREDENTIALED}: denied`)).toBe("fatal: unable to access 'https://<redacted>@example.invalid/agent.git/?token=<redacted>': denied")
    expect(sanitizeGitDiagnostic('GET /x?api_key=ab"cd&page=2 "/y?secret=s3"')).toBe('GET /x?api_key=<redacted>&page=2 "/y?secret=<redacted>"')
    expect(sanitizeGitDiagnostic("https://user:pa'ss\"PRIVATE_PW@example.invalid/a.git")).toBe('https://<redacted>@example.invalid/a.git')
    expect(sanitizeGitDiagnostic('?token=Q')).toBe('?token=<redacted>')
    expect(sanitizeGitDiagnostic("x?token=ab':cd'.Q, done.")).toBe('x?token=<redacted> done.')
    expect(sanitizeGitDiagnostic('push ghp_SYNTHETICSYNTHETICSYNTHETIC done')).toBe('push <redacted> done')
    expect(sanitizeGitDiagnostic('')).toBe('')
    expect(sanitizeGitDiagnostic("fatal: couldn't find remote ref refs/heads/gone")).toBe("fatal: couldn't find remote ref refs/heads/gone")
    // A bound applies after redaction: a lengthened short secret and a token cut by the bound both stay masked.
    const short = sanitizeGitDiagnostic('?key=Q&next=1', 8)
    expect(short).toBe('?key=<re…')
    expect(short).not.toContain('Q')
    const straddling = sanitizeGitDiagnostic(`${'a'.repeat(290)} ghp_SYNTHETICSYNTHETICSYNTHETIC tail`)
    expect(straddling).not.toContain('ghp_')
    expect(straddling.length).toBeLessThanOrEqual(301)
  })

  function agentInstall(withSync = false): { agent: string; origin: string; v1: string; v2: string } {
    const root = tmp()
    const origin = join(root, 'origin')
    git(root, 'init', '-b', 'master', origin)
    writeFileSync(join(origin, 'VERSION'), '1.0.0\n')
    writeFileSync(join(origin, 'README'), 'agent\n')
    git(origin, 'add', '.')
    git(origin, 'commit', '-m', 'agent v1')
    git(origin, 'tag', 'v1.0.0')
    const v1 = git(origin, 'rev-parse', 'HEAD')
    const agent = join(root, 'agent')
    git(root, 'clone', origin, agent)
    writeFileSync(join(origin, 'VERSION'), '2.0.0\n')
    if (withSync) {
      mkdirSync(join(origin, 'hermes_cli'))
      writeFileSync(join(origin, 'hermes_cli/venv_sync.py'), '# dependency sync entry point\n')
      git(origin, 'add', 'hermes_cli')
    }
    git(origin, 'commit', '-am', 'agent v2')
    git(origin, 'tag', 'v2.0.0')
    const v2 = git(origin, 'rev-parse', 'HEAD')
    return { agent, origin, v1, v2 }
  }

  it('reports the tag gap, fast-forwards with a stash, and leaves the gateway restart to the idle wait', async () => {
    const a = agentInstall()
    expect(await checkAgentUpdate(null, runGit)).toEqual({ name: 'agent', behind: null, no_git: true })
    const status = await checkAgentUpdate(a.agent, runGit)
    expect(status).toMatchObject({ name: 'agent', behind: 1, current_sha: a.v1, latest_sha: a.v2, release_based: true, dirty: false, channel: 'stable' })
    writeFileSync(join(a.agent, 'notes.txt'), 'untracked survives\n')
    writeFileSync(join(a.agent, 'README'), 'local note\n')
    const gateway: string[] = []
    const svc = updateService({
      webRoot: join(tmp(), 'web'), getJson: noReleases, identity: { release: () => DEV, stamped: () => DEV, runningSourceRevision: () => null }, webuiVersion: 'x',
      agentDir: () => a.agent, channel: () => 'stable', includeAgent: () => true, blockers: () => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false }),
      scheduleRestart: () => gateway.push('restart'), log: () => undefined,
    })
    expect(await svc.apply('agent')).toMatchObject({ ok: false, confirmation_required: true })
    const result = await svc.apply('agent', null, () => true, { confirmedRevision: a.v2 })
    expect(result).toMatchObject({ ok: true, target: 'agent', ref: 'v2.0.0', restart_scheduled: true, gateway_restart: 'waiting_for_idle' })
    expect(gateway).toEqual(['restart'])
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v2)
    expect(readFileSync(join(a.agent, 'notes.txt'), 'utf8')).toBe('untracked survives\n')
    expect(readFileSync(join(a.agent, 'README'), 'utf8')).toBe('local note\n') // stash popped back over the update
    expect(readFileSync(join(a.agent, 'VERSION'), 'utf8')).toBe('2.0.0\n')
    expect((await checkAgentUpdate(a.agent, runGit)).behind).toBe(0)
  })

  /** TAL-350: a service whose Web root owns this test's `sidecar/agent_support.json` (`undefined` leaves it missing). */
  function windowService(a: { agent: string }, support: unknown, opts: { agentChannel?: 'stable' | 'experimental'; pin?: string; deps?: Partial<UpdateServiceDeps>; onGit?: (args: string[]) => GitOutcome | undefined } = {}): UpdateService {
    const s = sourceInstall()
    if (support !== undefined) write(join(web(s.client), 'sidecar/agent_support.json'), typeof support === 'string' ? support : JSON.stringify(support))
    if (opts.pin) s.id.release = { ...s.id.release, compatibleAgent: { ...(s.id.release.compatibleAgent as Dict), sourceRevision: opts.pin } }
    return updateService({
      webRoot: web(s.client), git: (args, cwd, timeout) => cwd === a.agent ? Promise.resolve(opts.onGit?.(args)).then((stub) => stub ?? runGit(args, cwd, timeout)) : s.run(args, cwd, timeout), getJson: noReleases, identity: s.identity, webuiVersion: 'test',
      agentDir: () => a.agent, channel: () => 'experimental', agentChannel: () => opts.agentChannel ?? 'stable', includeAgent: () => true,
      blockers: () => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false }),
      scheduleRestart: () => undefined, log: () => undefined, ...opts.deps,
    })
  }
  const verified = (...revisions: string[]): Dict => ({ schemaVersion: 1, releases: revisions.map((sourceRevision, i) => ({ releaseTag: `v${i + 1}.0.0`, version: `${i + 1}.0.0`, sourceRevision })) })

  it('supports any release in the verified window, not only the pin, and applies it without confirmation', async () => {
    const a = agentInstall()
    const svc = windowService(a, verified(a.v1, a.v2)) // The pin stays Talaria's own, outside this synthetic window.
    expect((await svc.check(true)).agent).toMatchObject({ latest_sha: a.v2, support: 'supported', current_support: 'supported', unsupported: false })
    expect(await svc.apply('agent')).toMatchObject({ ok: true, verified_revision: a.v2 })
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v2)
  })

  it('keeps the exact-SHA confirmation for a target outside the window and reports the installed Agent', async () => {
    const a = agentInstall()
    const svc = windowService(a, verified(a.v1))
    expect((await svc.check(true)).agent).toMatchObject({ latest_sha: a.v2, support: 'unchecked', current_support: 'supported', unsupported: true })
    expect(await svc.apply('agent')).toMatchObject({ ok: false, confirmation_required: true, candidate_revision: a.v2, support: 'unchecked' })
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v1)
    expect(await svc.apply('agent', null, () => true, { confirmedRevision: a.v2 })).toMatchObject({ ok: true, verified_revision: a.v2 })
    expect((await svc.check(true)).agent).toMatchObject({ current_sha: a.v2, current_support: 'unchecked' })
  })

  it('classifies a moved release tag and an Experimental main commit as unchecked', async () => {
    const a = agentInstall()
    git(a.origin, 'commit', '--allow-empty', '-m', 'retagged release')
    git(a.origin, 'tag', '-f', 'v2.0.0')
    const moved = git(a.origin, 'rev-parse', 'HEAD')
    expect((await windowService(a, verified(a.v1, a.v2)).check(true)).agent).toMatchObject({ latest_version: 'v2.0.0', latest_sha: moved, support: 'unchecked' })
    git(a.origin, 'commit', '--allow-empty', '-m', 'experimental only')
    const main = git(a.origin, 'rev-parse', 'HEAD')
    expect((await windowService(a, verified(a.v1, moved), { agentChannel: 'experimental' }).check(true)).agent).toMatchObject({ channel: 'experimental', latest_sha: main, support: 'unchecked' })
  })

  it.each<[string, (v2: string) => unknown]>([
    ['missing', () => undefined],
    ['unreadable', () => '{'],
    ['listless', () => ({ schemaVersion: 1 })],
    ['partly invalid', (v2) => ({ schemaVersion: 1, releases: [{ releaseTag: 'v2.0.0', version: '2.0.0', sourceRevision: v2 }, { releaseTag: 'v9.0.0', version: '9.0.0', sourceRevision: 'v9.0.0' }] })],
  ])('a %s window record leaves every target unchecked, even the pin', async (_name, support) => {
    const a = agentInstall()
    const svc = windowService(a, support(a.v2), { pin: a.v2 })
    expect((await svc.check(true)).agent).toMatchObject({ latest_sha: a.v2, support: 'unchecked', current_support: 'unchecked', unsupported: true })
    expect(await svc.apply('agent')).toMatchObject({ ok: false, confirmation_required: true })
  })

  it.each(['supported', 'unchecked'])('rejects a stale confirmation for another SHA on apply, force and retry (%s target)', async (support) => {
    const a = agentInstall()
    const svc = windowService(a, support === 'supported' ? verified(a.v2) : verified())
    const stale = { confirmedRevision: a.v1 }
    for (const result of [await svc.apply('agent', null, () => true, stale), await svc.force('agent', null, stale), await svc.clearLock('agent', stale)]) {
      expect(result.ok).toBe(false)
      if (support === 'unchecked') expect(result).toMatchObject({ confirmation_required: true, candidate_revision: a.v2 })
    }
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v1)
  })

  function summaryService(a: { agent: string; origin: string }, opts: { channel?: 'stable' | 'experimental'; git?: GitRun; getPublicJson?: GetJson; llm?: (system: string, user: string) => Promise<string>; now?: () => number; stateDir?: string; summarizeAutomatically?: () => boolean; checkEnabled?: () => boolean; includeAgent?: () => boolean; log?: (line: string) => void } = {}): { svc: UpdateService; prompts: string[] } {
    // The checkout fetches its local origin but reports a GitHub remote, whose releases `getPublicJson` stubs.
    const run: GitRun = (args, cwd, t) => (args[0] === 'remote' && args[1] === 'get-url' ? Promise.resolve({ ok: true, out: 'https://github.com/Synthetic/agent.git' }) : runGit(args, cwd, t))
    const prompts: string[] = []
    const svc = updateService({
      webRoot: join(tmp(), 'web'), git: opts.git ?? run, getJson: noReleases, ...(opts.getPublicJson ? { getPublicJson: opts.getPublicJson } : {}), identity: { release: () => DEV, stamped: () => DEV, runningSourceRevision: () => null }, webuiVersion: 'x',
      agentDir: () => a.agent, channel: () => 'stable', agentChannel: () => opts.channel ?? 'stable', includeAgent: opts.includeAgent ?? (() => true), blockers: () => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false }),
      scheduleRestart: () => undefined, llm: (system, user) => { prompts.push(user); return opts.llm ? opts.llm(system, user) : Promise.resolve('- Notice: Chats open faster') }, log: () => undefined,
      ...(opts.now ? { now: opts.now } : {}), ...(opts.stateDir ? { stateDir: opts.stateDir } : {}), summarizeAutomatically: opts.summarizeAutomatically ?? (() => false), ...(opts.checkEnabled ? { checkEnabled: opts.checkEnabled } : {}),
      ...(opts.log ? { log: opts.log } : {}),
    })
    return { svc, prompts }
  }

  it('folds every pending commit and only reads new commits on the next check (TAL-1009)', async () => {
    const a = agentInstall()
    const stateDir = tmp()
    const commands: string[][] = []
    const run: GitRun = (args, cwd, timeout) => { commands.push(args); return runGit(args, cwd, timeout) }
    const { svc, prompts } = summaryService(a, { channel: 'experimental', stateDir, git: run, summarizeAutomatically: () => true })
    for (let i = 1; i <= 39; i++) git(a.origin, 'commit', '--allow-empty', '-m', `pending subject ${String(i)}`)
    await svc.check(true)
    await svc.summarize('agent')
    expect(prompts.join('\n')).toContain('pending subject 1\n')
    const previous = git(a.origin, 'rev-parse', 'HEAD')
    commands.length = 0
    for (let i = 40; i <= 44; i++) git(a.origin, 'commit', '--allow-empty', '-m', `pending subject ${String(i)}`)
    await svc.check(true)
    const result = await svc.summarize('agent')
    expect(prompts).toHaveLength(2)
    for (let i = 1; i <= 44; i++) expect(prompts.join('\n')).toContain(`pending subject ${String(i)}\n`)
    expect(prompts[1]).toContain('Chats open faster')
    expect(prompts[1]).not.toContain('pending subject 39\n')
    expect(commands.filter((args) => args[0] === 'log')).toEqual([['log', '--format=%H%x00%s', `${previous}..${git(a.origin, 'rev-parse', 'HEAD')}`]])
    expect(result.summary).not.toMatch(/latest 24|summary covers|commit subjects/)
    expect(await svc.summarize('agent')).toMatchObject({ cached: true })
    const restarted = summaryService(a, { channel: 'experimental', stateDir, git: run })
    commands.length = 0
    await restarted.svc.check(true)
    expect(await restarted.svc.summarize('agent')).toMatchObject({ cached: true })
    expect(restarted.prompts).toHaveLength(0)
    expect(commands.filter((args) => args[0] === 'log')).toHaveLength(0)
  })

  const pendingSummary = (stateDir: string): Dict => (Object.fromEntries(JSON.parse(readFileSync(join(stateDir, 'update-summaries.json'), 'utf8')) as [string, Dict][]))['pending:agent']!

  it('collects without automatic AI and folds only unsummarized items on demand (TAL-1009)', async () => {
    const a = agentInstall()
    const stateDir = tmp()
    const { svc, prompts } = summaryService(a, { channel: 'experimental', stateDir })
    await svc.check(true)
    await vi.waitFor(() => { expect(pendingSummary(stateDir).items).toHaveLength(1) })
    expect(prompts).toHaveLength(0)
    await svc.summarize('agent')
    for (let i = 1; i <= 3; i++) git(a.origin, 'commit', '--allow-empty', '-m', `unsummarized ${String(i)}`)
    await svc.check(true)
    await vi.waitFor(() => { expect(pendingSummary(stateDir).items).toHaveLength(4) })
    expect(prompts).toHaveLength(1)
    expect(await svc.summarize('agent')).toMatchObject({ cached: false })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('Chats open faster')
    for (let i = 1; i <= 3; i++) expect(prompts[1]).toContain(`- unsummarized ${String(i)}`)
    expect(prompts[1]).not.toContain('- agent v2')
  })

  it.each(['installed', 'diverged'])('rebuilds the pending list and drops prior sections when the range is %s (TAL-1009)', async (mode) => {
    const a = agentInstall()
    const stateDir = tmp()
    const { svc, prompts } = summaryService(a, { channel: 'experimental', stateDir })
    await svc.check(true)
    await svc.summarize('agent')
    if (mode === 'installed') git(a.agent, 'reset', '--hard', a.v2)
    else git(a.origin, 'reset', '--hard', a.v1)
    git(a.origin, 'commit', '--allow-empty', '-m', 'replacement update')
    await svc.check(true)
    await svc.summarize('agent')
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('replacement update')
    expect(prompts[1]).not.toContain('Chats open faster')
    expect(prompts[1]).not.toContain('- agent v2')
    expect(pendingSummary(stateDir).items).toHaveLength(1)
  })

  it('retains the complete checkpoint after a read failure and retries on the next check (TAL-1009)', async () => {
    const a = agentInstall()
    const stateDir = tmp()
    let fail = false
    const run: GitRun = (args, cwd, timeout) => args[0] === 'log' && fail ? Promise.resolve({ ok: false, out: 'synthetic read failure' }) : runGit(args, cwd, timeout)
    const { svc, prompts } = summaryService(a, { channel: 'experimental', stateDir, git: run })
    await svc.check(true)
    await svc.summarize('agent')
    const before = readFileSync(join(stateDir, 'update-summaries.json'), 'utf8')
    git(a.origin, 'commit', '--allow-empty', '-m', 'retry update')
    fail = true
    await svc.check(true)
    expect(await svc.summarize('agent')).toMatchObject({ generated_by: 'fallback', cached: false })
    expect(readFileSync(join(stateDir, 'update-summaries.json'), 'utf8')).toBe(before)
    expect(prompts).toHaveLength(1)
    fail = false
    await svc.check(true)
    await svc.summarize('agent')
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('retry update')
    expect(pendingSummary(stateDir).items).toHaveLength(2)
  })

  it.each([false, true])('bounds commit folds and retries without checkpointing a partial model answer, partial failure=%s (TAL-1009)', async (partialFailure) => {
    const a = agentInstall()
    const items = Array.from({ length: 205 }, (_, i) => ({ id: (i + 1).toString(16).padStart(40, '0'), text: `subject-${String(i)}` }))
    const run: GitRun = (args, cwd, timeout) => args[0] === 'log' ? Promise.resolve({ ok: true, out: [...items].reverse().map((item) => `${item.id}\0${item.text}`).join('\n') }) : runGit(args, cwd, timeout)
    const stateDir = tmp()
    let calls = 0
    const { svc, prompts } = summaryService(a, { channel: 'experimental', git: run, stateDir, llm: () => ++calls === 2 && partialFailure ? Promise.reject(new Error('model unavailable')) : Promise.resolve('- Notice: Chats open faster') })
    await svc.check(true)
    if (partialFailure) {
      expect(await svc.summarize('agent')).toMatchObject({ generated_by: 'fallback', cached: false })
      expect(pendingSummary(stateDir)).toMatchObject({ summary_sections: null, summarized_through: null })
      prompts.length = 0
    }
    await svc.summarize('agent')
    expect(prompts.map((prompt) => [...prompt.matchAll(/^- subject-/gm)].length)).toEqual([100, 100, 5])
    for (const item of items) expect(prompts.join('\n')).toContain(`- ${item.text}\n`)
    expect(prompts[1]).toContain('Chats open faster')
  })

  it('fetches only new release notes and retains the checkpoint on a partial read failure (TAL-1009)', async () => {
    const a = agentInstall()
    const stateDir = tmp()
    let fail = false
    const paths: string[] = []
    const getPublicJson: GetJson = (path) => {
      paths.push(path)
      if (fail && path.endsWith('/v2.2.0')) return Promise.reject(new Error('notes unavailable'))
      return Promise.resolve({ body: `Release notes for ${path.split('/').pop() ?? ''}` })
    }
    const { svc, prompts } = summaryService(a, { stateDir, getPublicJson })
    await svc.check(true)
    await svc.summarize('agent')
    const checkpoint = readFileSync(join(stateDir, 'update-summaries.json'), 'utf8')
    for (let i = 1; i <= 2; i++) { git(a.origin, 'commit', '--allow-empty', '-m', `release ${String(i)}`); git(a.origin, 'tag', `v2.${String(i)}.0`) }
    paths.length = 0
    fail = true
    await svc.check(true)
    expect(await svc.summarize('agent')).toMatchObject({ generated_by: 'fallback' })
    expect(readFileSync(join(stateDir, 'update-summaries.json'), 'utf8')).toBe(checkpoint)
    expect(paths.every((path) => !path.endsWith('/v2.0.0'))).toBe(true)
    fail = false
    paths.length = 0
    await svc.check(true)
    await svc.summarize('agent')
    expect(paths).toEqual(['/repos/Synthetic/agent/releases/tags/v2.1.0', '/repos/Synthetic/agent/releases/tags/v2.2.0'])
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('Chats open faster')
    expect(prompts[1]).not.toContain('Release notes for v2.0.0')
    expect(pendingSummary(stateDir).items).toHaveLength(3)
  })

  it.each(['installed', 'channel', 'diverged'])('keeps the commit fallback when a historical checkpoint belongs to a different range: %s (TAL-1009)', async (mode) => {
    const a = agentInstall()
    const stateDir = tmp()
    let fail = false
    const opts: { channel: 'stable' | 'experimental'; stateDir: string; getPublicJson: GetJson } = {
      channel: mode === 'channel' ? 'experimental' : 'stable', stateDir,
      getPublicJson: () => fail ? Promise.reject(new Error('notes unavailable')) : Promise.resolve({ body: 'Earlier release notes' }),
    }
    const { svc, prompts } = summaryService(a, opts)
    await svc.check(true)
    await svc.summarize('agent')
    const checkpoint = readFileSync(join(stateDir, 'update-summaries.json'), 'utf8')
    if (mode === 'installed') git(a.agent, 'reset', '--hard', a.v2)
    if (mode === 'diverged') git(a.origin, 'reset', '--hard', a.v1)
    git(a.origin, 'commit', '--allow-empty', '-m', 'available fallback subject')
    git(a.origin, 'tag', 'v2.1.0')
    opts.channel = 'stable'
    fail = true
    await svc.check(true)
    expect(await svc.summarize('agent')).toMatchObject({ source: 'commits', generated_by: 'llm', cached: false })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('- available fallback subject')
    expect(prompts[1]).not.toContain('Chats open faster')
    expect(readFileSync(join(stateDir, 'update-summaries.json'), 'utf8')).toBe(checkpoint)
  })

  it('serializes a newer check behind an older in-flight fold without losing either range (TAL-1009)', async () => {
    const a = agentInstall()
    const stateDir = tmp()
    let answer!: (text: string) => void
    let calls = 0
    const { svc, prompts } = summaryService(a, { channel: 'experimental', stateDir, summarizeAutomatically: () => true, llm: () => ++calls === 1 ? new Promise<string>((resolve) => { answer = resolve }) : Promise.resolve('- Notice: Both updates') })
    await svc.check(true)
    await vi.waitFor(() => { expect(prompts).toHaveLength(1) })
    git(a.origin, 'commit', '--allow-empty', '-m', 'concurrent update')
    await svc.check(true)
    const requested = svc.summarize('agent')
    answer('- Notice: Earlier update')
    expect(await requested).toMatchObject({ generated_by: 'llm' })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('Earlier update')
    expect(prompts[1]).toContain('concurrent update')
    expect(pendingSummary(stateDir)).toMatchObject({ latest_sha: git(a.origin, 'rev-parse', 'HEAD'), items: [expect.anything(), expect.anything()] })
  })

  it('pre-generates summaries without blocking checks and shares the in-flight range (TAL-1008)', async () => {
    const a = agentInstall()
    let resolveAnswer!: (value: string) => void
    const answer = new Promise<string>((resolve) => { resolveAnswer = resolve })
    const { svc, prompts } = summaryService(a, { summarizeAutomatically: () => true, llm: () => answer })
    await svc.check(true)
    await vi.waitFor(() => { expect(prompts).toHaveLength(1) })
    const requested = svc.summarize('agent')
    resolveAnswer('- Notice: Chats open faster')
    const result = await requested
    expect(result).toMatchObject({ generated_by: 'llm' })
    expect(result.summary).toContain('Chats open faster')
    expect(await svc.summarize('agent')).toMatchObject({ cached: true })
    await svc.check(true)
    expect(prompts).toHaveLength(1)
    git(a.origin, 'commit', '--allow-empty', '-m', 'new update')
    git(a.origin, 'tag', 'v3.0.0')
    await svc.check(true)
    await vi.waitFor(() => { expect(prompts).toHaveLength(2) })
    await svc.summarize('agent')
  })

  it.each(['channel', 'include-agent'])('pre-generates for the checked update identity instead of the saved %s (TAL-1008)', async (mode) => {
    let enabled = mode === 'channel'
    const opts = { channel: 'stable' as 'stable' | 'experimental', includeAgent: () => enabled, summarizeAutomatically: () => true }
    const { svc, prompts } = summaryService(agentInstall(), opts)
    await svc.check(true, true, 'stable', mode === 'channel' ? 'experimental' : 'stable')
    await vi.waitFor(() => { expect(prompts).toHaveLength(1) })
    // Once the checked identity becomes the saved one, requests reuse that exact answer.
    if (mode === 'channel') opts.channel = 'experimental'
    enabled = true
    expect(await svc.summarize('agent')).toMatchObject({ generated_by: 'llm', cached: true })
    expect(prompts).toHaveLength(1)
  })

  it.each(['summary disabled', 'checks disabled'])('does not pre-generate when %s (TAL-1008)', async (mode) => {
    const { svc, prompts } = summaryService(agentInstall(), { summarizeAutomatically: () => mode !== 'summary disabled', checkEnabled: () => mode !== 'checks disabled' })
    await svc.check(true)
    await new Promise((resolve) => setImmediate(resolve))
    expect(prompts).toHaveLength(0)
  })

  it('persists model answers across service reconstruction (TAL-1008)', async () => {
    const a = agentInstall()
    const stateDir = tmp()
    const first = summaryService(a, { stateDir })
    await first.svc.check(true)
    expect(await first.svc.summarize('agent')).toMatchObject({ generated_by: 'llm', cached: false })
    const second = summaryService(a, { stateDir })
    await second.svc.check(true)
    expect(await second.svc.summarize('agent')).toMatchObject({ generated_by: 'llm', cached: true })
    expect(second.prompts).toHaveLength(0)
  })

  it('logs a background model failure once per range and leaves fallback uncached (TAL-1008)', async () => {
    const logs: string[] = []
    const stateDir = tmp()
    const { svc, prompts } = summaryService(agentInstall(), { stateDir, summarizeAutomatically: () => true, log: (line) => logs.push(line), llm: () => Promise.reject(new Error('model unavailable')) })
    await svc.check(true)
    expect(await svc.summarize('agent')).toMatchObject({ generated_by: 'fallback', cached: false })
    await svc.check(true)
    expect(await svc.summarize('agent')).toMatchObject({ generated_by: 'fallback', cached: false })
    expect(prompts).toHaveLength(2)
    expect(logs.filter((line) => line.includes('summary'))).toHaveLength(1)
    expect(pendingSummary(stateDir)).toMatchObject({ summary_sections: null, summarized_through: null })
  })

  it('summarizes the Stable release notes between the installed and target tags, not commit subjects (TAL-759)', async () => {
    const a = agentInstall()
    git(a.origin, 'commit', '--allow-empty', '-m', 'synthetic internal refactor')
    git(a.origin, 'tag', 'v2.1.0')
    const paths: string[] = []
    const getPublicJson: GetJson = (path) => { paths.push(path); const tag = path.split('/').pop() ?? ''; return Promise.resolve({ tag_name: tag, draft: false, body: `Release notes for ${tag}` }) }
    const { svc, prompts } = summaryService(a, { getPublicJson })
    await svc.check(true)
    const result = await svc.summarize('agent')
    expect(result).toMatchObject({ ok: true, target: 'agent', current_version: 'v1.0.0', target_version: 'v2.1.0', source: 'release_notes', generated_by: 'llm', cached: false, summary_sections: [{ title: "What you'll notice", items: ['Chats open faster.'] }] })
    expect(paths).toEqual(['/repos/Synthetic/agent/releases/latest', '/repos/Synthetic/agent/releases/tags/v2.0.0', '/repos/Synthetic/agent/releases/tags/v2.1.0'])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.indexOf('Release notes for v2.0.0')).toBeGreaterThan(-1)
    expect(prompts[0]!.indexOf('Release notes for v2.0.0')).toBeLessThan(prompts[0]!.indexOf('Release notes for v2.1.0'))
    expect(prompts[0]).not.toContain('synthetic internal refactor')
    expect(await svc.summarize('agent')).toMatchObject({ cached: true, source: 'release_notes' })
    expect(prompts).toHaveLength(1)
  })

  /** TAL-930: v0.21.7 is published at `a.v2`; v0.21.8 is tagged on origin, and `latest` is the stub's `releases/latest` answer. */
  function unpublishedTagInstall(latest: () => Promise<unknown>, now?: () => number): { a: ReturnType<typeof agentInstall>; next: string; svc: UpdateService; paths: string[] } {
    const a = agentInstall()
    git(a.origin, 'tag', '-d', 'v1.0.0', 'v2.0.0')
    git(a.agent, 'tag', '-d', 'v1.0.0')
    git(a.origin, 'tag', 'v0.21.6', a.v1)
    git(a.origin, 'tag', 'v0.21.7', a.v2)
    git(a.origin, 'commit', '--allow-empty', '-m', 'release draft')
    git(a.origin, 'tag', 'v0.21.8')
    const paths: string[] = []
    const { svc } = summaryService(a, { getPublicJson: (path) => { paths.push(path); return path.endsWith('/releases/latest') ? latest() : Promise.resolve({ tag_name: path.split('/').pop(), body: 'notes' }) }, ...(now ? { now } : {}) })
    return { a, next: git(a.origin, 'rev-parse', 'HEAD'), svc, paths }
  }

  it('Stable skips a newer tag whose GitHub release is not published (TAL-930)', async () => {
    const { a, svc, paths } = unpublishedTagInstall(() => Promise.resolve({ tag_name: 'v0.21.7', draft: false, prerelease: false }))
    const agent = (await svc.check(true)).agent as Dict
    expect(agent).toMatchObject({ latest_version: 'v0.21.7', latest_sha: a.v2, behind: 1 })
    expect((agent.versions as Dict[]).map((v) => v.version)).toEqual(['v0.21.7'])
    await svc.check(true)
    expect(paths.filter((p) => p.endsWith('/releases/latest'))).toEqual(['/repos/Synthetic/agent/releases/latest'])
    expect(await svc.apply('agent', null, () => true, { confirmedRevision: a.v2 })).toMatchObject({ ok: true, verified_revision: a.v2, verified_version: 'v0.21.7' })
  })

  it('keeps the last verified published tag when a later releases/latest read fails (TAL-930)', async () => {
    let clock = 0
    let latest: () => Promise<unknown> = () => Promise.resolve({ tag_name: 'v0.21.7', draft: false, prerelease: false })
    const { a, svc, paths } = unpublishedTagInstall(() => latest(), () => clock)
    expect((await svc.check(true)).agent).toMatchObject({ latest_version: 'v0.21.7', latest_sha: a.v2 })
    latest = () => Promise.reject(new ReleaseUnavailable('GitHub answered 403'))
    clock = CACHE_TTL_S + 1
    expect((await svc.check(true)).agent).toMatchObject({ latest_version: 'v0.21.7', latest_sha: a.v2 })
    expect(paths.filter((p) => p.endsWith('/releases/latest'))).toHaveLength(2)
  })

  it.each<[string, () => Promise<unknown>]>([
    ['the published release is the newest tag', () => Promise.resolve({ tag_name: 'v0.21.8', draft: false, prerelease: false })],
    ['the releases/latest read fails', () => Promise.reject(new ReleaseUnavailable('GitHub answered 403'))],
    ['the latest release is a draft', () => Promise.resolve({ tag_name: 'v0.21.7', draft: true, prerelease: false })],
    ['the latest release is a prerelease', () => Promise.resolve({ tag_name: 'v0.21.7', draft: false, prerelease: true })],
    ['the latest release tag is not a strict vX.Y.Z', () => Promise.resolve({ tag_name: 'v0.21.7+canary.1', draft: false, prerelease: false })],
  ])('Stable targets the newest tag when %s (TAL-930)', async (_name, latest) => {
    const { next, svc } = unpublishedTagInstall(latest)
    expect((await svc.check(true)).agent).toMatchObject({ latest_version: 'v0.21.8', latest_sha: next, behind: 2 })
  })

  const notesFor = (paths: string[], body = (tag: string) => `Release notes for ${tag}`): GetJson => (path) => { paths.push(path); const tag = path.split('/').pop() ?? ''; return Promise.resolve({ tag_name: tag, body: body(tag) }) }

  it('Experimental Agent updates summarize commit subjects and never read release notes', async () => {
    const a = agentInstall()
    git(a.origin, 'commit', '--allow-empty', '-m', 'synthetic experimental change')
    const paths: string[] = []
    const { svc, prompts } = summaryService(a, { channel: 'experimental', getPublicJson: notesFor(paths) })
    await svc.check(true)
    expect(await svc.summarize('agent')).toMatchObject({ source: 'commits', generated_by: 'llm' })
    expect(prompts[0]).toContain('- synthetic experimental change')
    expect(paths).toEqual([])
  })

  it('falls back to commit subjects when no Stable release notes can be read', async () => {
    const a = agentInstall()
    const { svc, prompts } = summaryService(a, { getPublicJson: () => Promise.reject(new ReleaseUnavailable('GitHub answered 404')) })
    await svc.check(true)
    expect(await svc.summarize('agent')).toMatchObject({ source: 'commits' })
    expect(prompts[0]).toContain('- agent v2')
  })

  it('folds all twelve pending releases without dropping or trimming notes (TAL-1009)', async () => {
    const a = agentInstall()
    for (let i = 1; i <= 11; i++) { git(a.origin, 'commit', '--allow-empty', '-m', `release ${String(i)}`); git(a.origin, 'tag', `v2.${String(i)}.0`) }
    const paths: string[] = []
    const body = (tag: string) => `Release notes for ${tag}\n${'x'.repeat(25_000)}END-${tag}`
    const { svc, prompts } = summaryService(a, { getPublicJson: notesFor(paths, body) })
    await svc.check(true)
    const result = await svc.summarize('agent')
    expect(paths).toHaveLength(13)
    for (let i = 0; i <= 11; i++) {
      const tag = `v2.${String(i)}.0`
      expect(prompts.join('')).toContain(`Release notes for ${tag}`)
      expect(prompts.join('')).toContain(`END-${tag}`)
    }
    for (const prompt of prompts) {
      const chars = [...prompt.matchAll(/<release tag="[^"]+">\n([\s\S]*?)\n<\/release>/g)].reduce((n, m) => n + m[1]!.length, 0)
      expect(chars).toBeLessThanOrEqual(24_000)
    }
    expect(result.summary).not.toMatch(/summary covers|latest 24/)
  })

  it('answers none without a pending update and keeps deterministic sections when the model fails', async () => {
    const a = agentInstall()
    git(a.origin, 'commit', '--allow-empty', '-m', 'synthetic internal refactor')
    git(a.origin, 'tag', 'v2.1.0')
    let calls = 0
    const { svc } = summaryService(a, { getPublicJson: notesFor([]), llm: () => { calls += 1; return Promise.reject(new Error('model unavailable')) } })
    expect(await svc.summarize('agent')).toEqual({ ok: true, target: 'agent', current_version: null, target_version: null, summary: '', summary_sections: [], generated_by: 'none', source: 'none', cached: false })
    expect(calls).toBe(0)
    await svc.check(true)
    // A check cached before update checks were turned off is never summarized.
    expect(await svc.summarize('agent', true)).toMatchObject({ generated_by: 'none', source: 'none' })
    expect(calls).toBe(0)
    expect(await svc.summarize('agent')).toMatchObject({ generated_by: 'fallback', source: 'release_notes', summary_sections: [{ title: 'About this update', items: ['Hermes Agent v2.0.0, v2.1.0 are available.'] }] })
    expect(calls).toBe(1)
    // A fallback is not cached, so the next request asks the model again.
    await svc.summarize('agent')
    expect(calls).toBe(2)
  })

  it('says the Agent build has no changes when its resolved commit range is empty (TAL-1589)', async () => {
    const a = agentInstall()
    // The range resolves (the log succeeds) but lists no commits.
    const run: GitRun = (args, cwd, t) => (args[0] === 'remote' && args[1] === 'get-url' ? Promise.resolve({ ok: true, out: 'https://github.com/Synthetic/agent.git' }) : args[0] === 'log' ? Promise.resolve({ ok: true, out: '' }) : runGit(args, cwd, t))
    const { svc, prompts } = summaryService(a, { channel: 'experimental', git: run })
    await svc.check(true)
    expect(await svc.summarize('agent')).toMatchObject({ generated_by: 'fallback', source: 'commits', summary_sections: [{ title: 'About this update', items: ['This build has no Hermes Agent changes.'] }] })
    expect(prompts).toEqual([])
  })

  /** TAL-1591: the sidecar refuses model work while the Agent runtime is mid-update. */
  function deferredSummaryService(opts: { llm?: () => Promise<string> } = {}) {
    const stateDir = tmp()
    const logs: string[] = []
    let stale = true
    const llm = opts.llm ?? (() => stale ? Promise.reject(new SidecarError('Agent update recovery is incomplete.', { condition: 'agent_runtime_stale', data: { agent_update_state: 'incomplete', retryable: true } })) : Promise.resolve('- Notice: Chats open faster'))
    const { svc, prompts } = summaryService(agentInstall(), { stateDir, summarizeAutomatically: () => true, getPublicJson: notesFor([]), log: (line) => logs.push(line), llm })
    let reconnect: ((runtime: RuntimeDescribe) => void) | undefined
    Object.assign((svc as unknown as { deps: object }).deps, { onAgentReconnect: (listener: (runtime: RuntimeDescribe) => void) => { reconnect = listener; return () => { reconnect = undefined } } })
    return { svc, prompts, stateDir, logs, current: () => { stale = false }, reconnect: (runtime: RuntimeDescribe) => reconnect?.(runtime) }
  }
  const deferredSections = [{ title: 'About this update', items: ['The summary will be ready when the Agent update finishes.'] }]

  it('defers the Agent summary while the runtime is stale and generates it once the sidecar reconnects current (TAL-1591)', async () => {
    const { svc, prompts, stateDir, logs, current, reconnect } = deferredSummaryService()
    await svc.check(true)
    await vi.waitFor(() => { expect(prompts).toHaveLength(1) })
    // On-demand Summarize asks again and answers honestly while the runtime still refuses.
    expect(await svc.summarize('agent')).toMatchObject({ generated_by: 'fallback', source: 'release_notes', summary_sections: deferredSections })
    expect(prompts).toHaveLength(2)
    expect(logs.filter((line) => line.includes('summary'))).toEqual([])
    expect(pendingSummary(stateDir)).toMatchObject({ items: [{ id: 'v2.0.0', text: 'Release notes for v2.0.0' }], summary_sections: null, summarized_through: null })
    // A refresh while the runtime is known stale skips the model call.
    await svc.check(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(prompts).toHaveLength(2)
    current()
    svc.startAutoApply(300000)
    try {
      reconnect({ ...new FakeSidecar().describe!, stale: true })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(prompts).toHaveLength(2)
      reconnect(new FakeSidecar().describe!)
      await vi.waitFor(() => { expect(pendingSummary(stateDir)).toMatchObject({ summary_sections: [{ title: "What you'll notice", items: ['Chats open faster.'] }], summarized_through: 'v2.0.0' }) })
      expect(prompts).toHaveLength(3)
      reconnect(new FakeSidecar().describe!)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(prompts).toHaveLength(3)
      expect(await svc.summarize('agent')).toMatchObject({ generated_by: 'llm', cached: true })
      expect(logs.filter((line) => line.includes('summary'))).toEqual([])
    } finally { svc.stopAutoApply() }
  })

  it('generates a deferred Agent summary once recovery completes (TAL-1591)', async () => {
    const { svc, prompts, stateDir, current } = deferredSummaryService()
    await svc.check(true)
    await vi.waitFor(() => { expect(prompts).toHaveLength(1) })
    let owed = true
    // Only the recovery hook may regenerate: the post-recovery refresh check is stubbed out.
    const check = vi.spyOn(svc, 'check').mockResolvedValue({})
    Object.assign((svc as unknown as { deps: object }).deps, {
      recoverAgent: (probe: boolean) => { if (!probe) owed = false; return Promise.resolve({ ok: !owed, owed, fingerprint: owed ? 'retained' : '', detail: '' }) },
    })
    current()
    svc.startAutoApply(300000)
    try {
      await vi.waitFor(() => { expect(svc.cachedStatus().agent_recovery).toMatchObject({ phase: 'complete' }) })
      await vi.waitFor(() => { expect(pendingSummary(stateDir)).toMatchObject({ summary_sections: [{ title: "What you'll notice", items: ['Chats open faster.'] }], summarized_through: 'v2.0.0' }) })
      expect(prompts).toHaveLength(2)
      expect(check).toHaveBeenCalled()
    } finally { svc.stopAutoApply() }
  })

  it('clears the deferral when an on-demand summary succeeds without a runtime signal (TAL-1591)', async () => {
    const { svc, prompts, stateDir, current } = deferredSummaryService()
    await svc.check(true)
    await vi.waitFor(() => { expect(prompts).toHaveLength(1) })
    current()
    expect(await svc.summarize('agent')).toMatchObject({ generated_by: 'llm', summary_sections: [{ title: "What you'll notice", items: ['Chats open faster.'] }] })
    expect(pendingSummary(stateDir)).toMatchObject({ summarized_through: 'v2.0.0' })
    expect(prompts).toHaveLength(2)
  })

  it('retries a refusal that was in flight when the runtime became current (TAL-1591)', async () => {
    const refuse = () => new SidecarError('Agent update recovery is incomplete.', { condition: 'agent_runtime_stale' })
    let calls = 0
    let settle: (() => void) | undefined
    const { svc, prompts, stateDir, reconnect } = deferredSummaryService({
      llm: () => {
        calls += 1
        if (calls === 1) return Promise.reject(refuse())
        if (calls === 2) return new Promise<string>((_resolve, reject) => { settle = () => { reject(refuse()) } })
        return Promise.resolve('- Notice: Chats open faster')
      },
    })
    await svc.check(true)
    await vi.waitFor(() => { expect(prompts).toHaveLength(1) })
    const onDemand = svc.summarize('agent')
    await vi.waitFor(() => { expect(settle).toBeDefined() })
    svc.startAutoApply(300000)
    try {
      reconnect(new FakeSidecar().describe!)
      settle!()
      expect(await onDemand).toMatchObject({ generated_by: 'llm', summary_sections: [{ title: "What you'll notice", items: ['Chats open faster.'] }] })
      expect(pendingSummary(stateDir)).toMatchObject({ summarized_through: 'v2.0.0' })
      expect(prompts).toHaveLength(3)
    } finally { svc.stopAutoApply() }
  })

  it.each([
    ['a generic model error', new Error('model unavailable')],
    ['another sidecar condition', new SidecarError('sidecar call aux.complete timed out', { condition: 'sidecar_timeout' })],
  ])('keeps logging %s once per range without a deferred retry (TAL-1591)', async (_name, error) => {
    const { svc, prompts, logs, reconnect } = deferredSummaryService({ llm: () => Promise.reject(error) })
    await svc.check(true)
    await vi.waitFor(() => { expect(logs.filter((line) => line.includes('summary'))).toHaveLength(1) })
    expect(await svc.summarize('agent')).toMatchObject({ generated_by: 'fallback', summary_sections: [{ title: 'About this update', items: ['Hermes Agent v2.0.0 is available.'] }] })
    expect(prompts).toHaveLength(2)
    svc.startAutoApply(300000)
    try {
      reconnect(new FakeSidecar().describe!)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(prompts).toHaveLength(2)
      expect(logs.filter((line) => line.includes('summary'))).toHaveLength(1)
    } finally { svc.stopAutoApply() }
  })

  function agentService(agent: string, git: GitRun, events: string[], agentSync?: UpdateServiceDeps['agentSync'], stateDir = join(agent, '../web-state'), agentHomes?: UpdateServiceDeps['agentHomes']): UpdateService {
    return updateService({
      webRoot: join(tmp(), 'web'), git, getJson: noReleases, identity: { release: () => DEV, stamped: () => DEV, runningSourceRevision: () => null }, webuiVersion: 'x',
      agentDir: () => agent, channel: () => 'stable', includeAgent: () => true, blockers: () => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false }),
      ...(agentSync ? { agentSync } : {}),
      ...(agentHomes ? { agentHomes } : {}),
      stateDir,
      scheduleRestart: () => events.push('restart'), log: () => undefined,
    })
  }
  const stashes = (agent: string): string[] => git(agent, 'stash', 'list').split('\n').filter(Boolean)

  it.each([['apply', 'failure'], ['force', 'failure'], ['apply', 'unavailable'], ['apply', 'skipped']] as const)('Agent dependency sync runs after %s and handles %s failure before either restart', async (action, failure) => {
    const a = agentInstall(true)
    const revision = a.v2
    let fail = true
    const events: string[] = []
    const sync: NonNullable<UpdateServiceDeps['agentSync']> = (agentDir) => {
      expect(agentDir).toBe(a.agent)
      expect(git(agentDir, 'rev-parse', 'HEAD')).toBe(revision)
      events.push('sync')
      if (fail && failure === 'unavailable') return Promise.reject(new Error('sidecar unavailable'))
      return Promise.resolve({ ok: !fail || failure === 'skipped', skipped: fail && failure === 'skipped', detail: fail ? 'synthetic sync failure' : '' })
    }
    const svc = agentService(a.agent, runGit, events, sync)
    const attempt = () => action === 'apply' ? svc.apply('agent', null, () => true, { confirmedRevision: revision }) : svc.force('agent', null, { confirmedRevision: revision })
    const failed = await attempt()
    expect(failed.ok).toBe(false)
    expect(String(failed.message)).toContain('dependency sync')
    expect(events).toEqual(['sync'])
    const check = await svc.check(true)
    expect(updateTargetView('agent', check.agent as Dict, false)).toMatchObject({ behind: 0, state: 'finish', can_apply: true })
    // Settings refetches after failure; a new server must retain that repair action too.
    const resumed = agentService(a.agent, runGit, events, sync)
    const afterRestart = await resumed.check(true)
    expect(updateTargetView('agent', afterRestart.agent as Dict, false)).toMatchObject({ state: 'finish', can_apply: true })
    // Git already advanced: retry must still repair dependencies before declaring success.
    fail = false
    const retried = await resumed.apply('agent', null, () => true, { confirmedRevision: revision })
    expect(retried).toMatchObject({ ok: true, up_to_date: false, restart_scheduled: true })
    expect(events).toEqual(['sync', 'sync', 'restart'])
    const completed = await agentService(a.agent, runGit, []).check(true)
    expect(updateTargetView('agent', completed.agent as Dict, false)).toMatchObject({ state: 'up_to_date', can_apply: false })
  })

  it.each(['apply', 'force'] as const)('Agent sync intent must be durable before %s changes source', async (action) => {
    const a = agentInstall(true)
    const state = join(a.agent, '../web-state')
    writeFileSync(state, 'not a writable directory')
    const events: string[] = []
    const svc = agentService(a.agent, runGit, events)
    const result = action === 'apply' ? await svc.apply('agent', null, () => true, { confirmedRevision: a.v2 }) : await svc.force('agent', null, { confirmedRevision: a.v2 })
    expect(result.ok).toBe(false)
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v1)
    expect(events).toEqual([])
  })

  it.each(['apply', 'force'] as const)('Agent sync intent survives interruption immediately after %s advances HEAD', async (action) => {
    const a = agentInstall(true)
    const interrupted: GitRun = async (args, cwd, timeout) => {
      const result = await runGit(args, cwd, timeout)
      if (result.ok && (args[0] === 'merge' || args[0] === 'reset')) throw new Error('synthetic interruption after HEAD advanced')
      return result
    }
    const svc = agentService(a.agent, interrupted, [])
    const attempt = action === 'apply' ? svc.apply('agent', null, () => true, { confirmedRevision: a.v2 }) : svc.force('agent', null, { confirmedRevision: a.v2 })
    await expect(attempt).rejects.toThrow('synthetic interruption')
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v2)
    const restarted = await agentService(a.agent, runGit, []).check(true)
    expect(updateTargetView('agent', restarted.agent as Dict, false)).toMatchObject({ behind: 0, state: 'finish', can_apply: true })
  })

  it('finishes pending Agent recovery before attempting a newer available release', async () => {
    const a = agentInstall(true)
    let fail = true
    const svc = agentService(a.agent, runGit, [], () => Promise.resolve({ ok: !fail, skipped: false, detail: fail ? 'repair interrupted' : '' }))
    expect((await svc.apply('agent', null, () => true, { confirmedRevision: a.v2 })).ok).toBe(false)
    git(a.origin, 'commit', '--allow-empty', '-m', 'another release')
    git(a.origin, 'tag', 'v3.0.0')
    const next = git(a.origin, 'rev-parse', 'HEAD')
    fail = false
    const result = await svc.apply('agent', null, () => true, { confirmedRevision: next })
    expect(result).toMatchObject({ ok: true, verified_revision: a.v2, restart_scheduled: true })
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v2)
  })

  it('does not report orphan repair as installation of a newly selected update', async () => {
    const a = agentInstall(true)
    let fail = true
    const svc = agentService(a.agent, runGit, [], () => Promise.resolve({ ok: !fail, skipped: false, detail: fail ? 'repair interrupted' : '' }))
    expect((await svc.apply('agent', null, () => true, { confirmedRevision: a.v2 })).ok).toBe(false)
    git(a.origin, 'commit', '--allow-empty', '-m', 'new selected release')
    git(a.origin, 'tag', 'v3.0.0')
    const next = git(a.origin, 'rev-parse', 'HEAD')
    fail = false
    const server = await bootTestServer()
    server.deps.updates = svc
    try {
      const response = await server.get('/api/updates/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'agent', confirmed_agent_revision: next, tab_id: 'tab-orphanrepair' }) })
      const result = await response.json() as Dict
      expect(result).toMatchObject({ ok: false, recovery_only: true, verified_revision: a.v2 })
      const list = await (await server.get('/api/update-notifications?tab_id=tab-orphanrepair')).json() as { tab_update: Dict }
      expect(list.tab_update).toMatchObject({ phase: 'unknown', active: false, dialog_close: 'close', verified_revision: a.v2 })
      expect(list.tab_update.detail).toContain('requested update outcome is unverified')
      expect(list.tab_update.recovery).toBeUndefined()
      expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v2)
    } finally { await server.close() }
  })

  it.each([false, true])('refuses sync intent inside the Agent checkout before force-clean (symlink=%s)', async (symlink) => {
    const a = agentInstall(true)
    const state = join(a.agent, 'web-state')
    mkdirSync(state)
    writeFileSync(join(state, 'settings.json'), '{}')
    const alias = join(a.agent, '../state-alias')
    if (symlink) symlinkSync(state, alias, 'dir')
    const svc = agentService(a.agent, runGit, [], () => Promise.resolve({ ok: false, skipped: false, detail: 'sync failed' }), symlink ? alias : state)
    const result = await svc.force('agent', null, { confirmedRevision: a.v2 })
    expect(result.ok).toBe(false)
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v1)
    expect(readFileSync(join(state, 'settings.json'), 'utf8')).toBe('{}')
  })

  it('keeps an already-current modern Agent without pending sync a no-op', async () => {
    const a = agentInstall(true)
    const events: string[] = []
    const svc = agentService(a.agent, runGit, events, () => { events.push('sync'); return Promise.resolve({ ok: true, skipped: false, detail: '' }) })
    expect((await svc.check(true)).agent).toMatchObject({ behind: 1 })
    // Another updater advances source after Settings cached the available update.
    git(a.agent, 'merge', '--ff-only', a.v2)
    expect(await svc.apply('agent')).toMatchObject({ ok: true, up_to_date: true })
    expect(events).toEqual([])
    expect(existsSync(join(a.agent, '../web-state/agent-dependency-sync'))).toBe(false)
    const refreshed = await svc.check()
    expect(updateTargetView('agent', refreshed.agent as Dict, false)).toMatchObject({ state: 'up_to_date', can_apply: false })
  })

  it('clears pending Agent sync only after confirming a legacy target', async () => {
    const a = agentInstall(true)
    const failed = agentService(a.agent, runGit, [], () => Promise.resolve({ ok: false, skipped: false, detail: 'sync failed' }))
    expect((await failed.apply('agent', null, () => true, { confirmedRevision: a.v2 })).ok).toBe(false)
    git(a.origin, 'rm', 'hermes_cli/venv_sync.py')
    git(a.origin, 'commit', '-m', 'release without dependency sync')
    git(a.origin, 'tag', 'v3.0.0')
    const revision = git(a.origin, 'rev-parse', 'HEAD')
    const events: string[] = []
    const resumed = agentService(a.agent, runGit, events)
    expect(await resumed.apply('agent', null, () => true, { confirmedRevision: revision })).toMatchObject({ ok: true, restart_scheduled: true })
    expect(events).toEqual(['restart'])
    const status = await agentService(a.agent, runGit, []).check(true)
    expect(updateTargetView('agent', status.agent as Dict, false)).toMatchObject({ state: 'up_to_date', can_apply: false })
  })

  it('TAL-953: an Agent update leaves the gateway restart to the idle wait and still schedules Web\'s restart', async () => {
    const a = agentInstall()
    const events: string[] = []
    const result = await agentService(a.agent, runGit, events).apply('agent', null, () => true, { confirmedRevision: a.v2 })
    expect(result).toMatchObject({ ok: true, target: 'agent', restart_scheduled: true, gateway_restart: 'waiting_for_idle' })
    expect(events).toEqual(['restart'])
  })

  it('TAL-1632: cleanup waits for the refresh check an update leaves running in the checkout', async () => {
    const a = agentInstall()
    const events: string[] = []
    let release: (() => void) | null = null
    const held = new Promise<void>((resolve) => { release = resolve })
    let holding = false
    // The owed refresh check's fetch runs after apply returns; hold it open in the checkout.
    const run: GitRun = async (args, cwd, timeout) => {
      if (!holding && events.includes('restart') && cwd === a.agent && args[0] === 'fetch') { holding = true; await held }
      return runGit(args, cwd, timeout)
    }
    expect(await agentService(a.agent, run, events).apply('agent', null, () => true, { confirmedRevision: a.v2 })).toMatchObject({ ok: true, restart_scheduled: true })
    await vi.waitFor(() => { expect(holding).toBe(true) })
    let cleaned = false
    const done = cleanup().then(() => { cleaned = true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    // Removing the checkout now would race the git process the refresh is about to run in it.
    expect(existsSync(a.agent)).toBe(true)
    expect(cleaned).toBe(false)
    release!()
    await done
    expect(existsSync(a.agent)).toBe(false)
  })

  it('TAL-953: refuses an Agent update while a gateway restart runs, without touching the checkout', async () => {
    const a = agentInstall()
    const base = agentService(a.agent, runGit, []) as unknown as { deps: UpdateServiceDeps }
    const svc = updateService({ ...base.deps, gatewayRestarting: () => true })
    for (const run of [() => svc.apply('agent', null, () => true, { confirmedRevision: a.v2 }), () => svc.force('agent', null, { confirmedRevision: a.v2 }), () => svc.clearLock('agent', { confirmedRevision: a.v2 })]) {
      expect(await run()).toMatchObject({ ok: false, status: 'already_in_progress', target: 'agent' })
    }
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v1)
  })

  it('a conflicting local edit leaves a clean checkout, keeps the stash, and restarts onto the update', async () => {
    const a = agentInstall()
    writeFileSync(join(a.agent, 'VERSION'), 'local edit\n')
    const commands: string[][] = []
    const recorded: GitRun = (args, cwd, timeout) => { commands.push(args); return runGit(args, cwd, timeout) }
    const events: string[] = []
    const result = await agentService(a.agent, recorded, events).apply('agent', null, () => true, { confirmedRevision: a.v2 })
    expect(result).toMatchObject({ ok: true, target: 'agent', stash_conflict: true, restart_scheduled: true })
    expect(String(result.message)).toContain('stash apply')
    expect(events).toEqual(['restart'])
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v2)
    expect(readFileSync(join(a.agent, 'VERSION'), 'utf8')).toBe('2.0.0\n') // no conflict markers
    expect(git(a.agent, 'status', '--porcelain')).toBe('')
    expect(stashes(a.agent)).toHaveLength(1)
    expect(git(a.agent, 'stash', 'show', '-p', 'stash@{0}')).toContain('+local edit')
    expect(commands.filter((args) => args[0] === 'reset' && args.includes('--hard'))).toEqual([]) // nothing is ever reset away
    // The private ref keeps owning the edits, whatever later happens to the shared stash list.
    const ref = git(a.agent, 'for-each-ref', '--format=%(refname)', 'refs/talaria')
    expect(ref).toMatch(/^refs\/talaria\/autostash\/[0-9a-f]{40}$/)
    expect(git(a.agent, 'stash', 'show', '-p', ref)).toContain('+local edit')
    expect(String(result.message)).toContain(`update-ref -d ${ref}`)
  })

  it('an edit made during the merge is never discarded', async () => {
    const a = agentInstall()
    writeFileSync(join(a.agent, 'VERSION'), 'local edit\n')
    const concurrent: GitRun = async (args, cwd, timeout) => {
      const out = await runGit(args, cwd, timeout)
      if (args[0] === 'merge') writeFileSync(join(a.agent, 'README'), 'edited during the update\n')
      return out
    }
    const result = await agentService(a.agent, concurrent, []).apply('agent', null, () => true, { confirmedRevision: a.v2 })
    expect(result).toMatchObject({ ok: true, stash_conflict: true })
    expect(readFileSync(join(a.agent, 'README'), 'utf8')).toBe('edited during the update\n')
    expect(readFileSync(join(a.agent, 'VERSION'), 'utf8')).toBe('2.0.0\n')
    expect(stashes(a.agent)).toHaveLength(1)
  })

  it.each([
    ['the stashed file', 'README', true],
    ['another file', 'VERSION', false],
  ])('an edit to %s just before the restore is never discarded', async (_, file, conflicts) => {
    const a = agentInstall()
    writeFileSync(join(a.agent, 'README'), 'local note\n')
    const racing: GitRun = async (args, cwd, timeout) => {
      if (args.includes('apply') && !args.includes('-R')) writeFileSync(join(a.agent, file), 'edited during the update\n')
      return runGit(args, cwd, timeout)
    }
    const result = await agentService(a.agent, racing, []).apply('agent', null, () => true, { confirmedRevision: a.v2 })
    expect(result).toMatchObject({ ok: true })
    expect(readFileSync(join(a.agent, file), 'utf8')).toBe('edited during the update\n')
    expect(result.stash_conflict).toBe(conflicts ? true : undefined)
    expect(stashes(a.agent)).toHaveLength(conflicts ? 1 : 0)
    if (!conflicts) expect(readFileSync(join(a.agent, 'README'), 'utf8')).toBe('local note\n')
  })

  it('never touches a stash another process creates after the restore', async () => {
    const a = agentInstall()
    writeFileSync(join(a.agent, 'README'), 'local note\n')
    let other = false
    const racing: GitRun = async (args, cwd, timeout) => {
      const out = await runGit(args, cwd, timeout)
      if (!other && args.includes('apply') && !args.includes('-R') && out.ok) {
        other = true
        writeFileSync(join(a.agent, 'VERSION'), 'another edit\n')
        git(a.agent, 'stash', 'push', '-m', 'another process')
      }
      return out
    }
    expect(await agentService(a.agent, racing, []).apply('agent', null, () => true, { confirmedRevision: a.v2 })).toMatchObject({ ok: true })
    expect(stashes(a.agent)).toHaveLength(1)
    expect(stashes(a.agent)[0]).toContain('another process')
  })

  it('restores its own changes and keeps another process\'s stash pushed while the update runs', async () => {
    const a = agentInstall()
    writeFileSync(join(a.agent, 'README'), 'local note\n')
    let other = false
    const racing: GitRun = async (args, cwd, timeout) => {
      const out = await runGit(args, cwd, timeout)
      // Right after this update has saved its changes and cleaned the tree, whichever way it does that.
      if (!other && out.ok && ((args[0] === 'stash' && args[1] === 'push') || args[0] === 'reset')) {
        other = true
        writeFileSync(join(a.agent, 'VERSION'), 'another edit\n')
        git(a.agent, 'stash', 'push', '-m', 'another process')
      }
      return out
    }
    expect(await agentService(a.agent, racing, []).apply('agent', null, () => true, { confirmedRevision: a.v2 })).toMatchObject({ ok: true })
    expect(readFileSync(join(a.agent, 'README'), 'utf8')).toBe('local note\n')
    expect(stashes(a.agent)).toHaveLength(1)
    expect(stashes(a.agent)[0]).toContain('another process')
    expect(git(a.agent, 'stash', 'show', '-p', 'stash@{0}')).toContain('+another edit')
  })

  it('an edit made while the update saves local changes aborts it with nothing lost', async () => {
    const a = agentInstall()
    writeFileSync(join(a.agent, 'README'), 'local note\n')
    const racing: GitRun = async (args, cwd, timeout) => {
      const out = await runGit(args, cwd, timeout)
      if (args[0] === 'stash' && args[1] === 'create') writeFileSync(join(a.agent, 'README'), 'edited during the update\n')
      return out
    }
    const events: string[] = []
    expect(await agentService(a.agent, racing, events).apply('agent', null, () => true, { confirmedRevision: a.v2 })).toMatchObject({ ok: false })
    expect(events).toEqual([])
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v1)
    expect(readFileSync(join(a.agent, 'README'), 'utf8')).toBe('edited during the update\n')
    expect(git(a.agent, 'for-each-ref', 'refs/talaria')).toBe('')
  })

  it('keeps conflicting changes under their private ref when the git stash cannot list them', async () => {
    const a = agentInstall()
    writeFileSync(join(a.agent, 'VERSION'), 'local edit\n')
    const locked: GitRun = (args, cwd, timeout) => args[0] === 'stash' && args[1] === 'store' ? Promise.resolve({ ok: false, out: 'fatal: Unable to create refs/stash.lock' }) : runGit(args, cwd, timeout)
    const result = await agentService(a.agent, locked, []).apply('agent', null, () => true, { confirmedRevision: a.v2 })
    expect(result).toMatchObject({ ok: true, stash_conflict: true })
    const ref = git(a.agent, 'for-each-ref', '--format=%(refname)', 'refs/talaria')
    expect(ref).toMatch(/^refs\/talaria\/autostash\/[0-9a-f]{40}$/)
    expect(String(result.message)).toContain(ref)
    expect(git(a.agent, 'stash', 'show', '-p', ref)).toContain('+local edit')
  })

  it.each([
    ['reverted them', true, null, 'local note\n', 0],
    ['reverted them, and the file changed again', true, 'edited again\n', 'edited again\n', 1],
    ['reverted nothing', false, null, 'local note\n', 0],
  ])('the next apply recovers the changes of an interrupted update that %s', async (_, reverted, later, expected, listed) => {
    const a = agentInstall()
    writeFileSync(join(a.agent, 'README'), 'local note\n')
    const sha = git(a.agent, 'stash', 'create', 'hermes-update-autostash')
    git(a.agent, 'update-ref', `refs/talaria/autostash/pending/${sha}`, sha) // the server stopped here or later
    if (reverted) git(a.agent, 'checkout', '--', 'README')
    if (later) writeFileSync(join(a.agent, 'README'), later)
    const before = readFileSync(join(a.agent, 'README'), 'utf8')
    await checkAgentUpdate(a.agent, runGit)
    expect(readFileSync(join(a.agent, 'README'), 'utf8')).toBe(before)
    expect(await applyAgentUpdate(a.agent, runGit, 'stable', { supportedRevisions: [a.v2], supportedRevision: a.v2, supportedVersion: '2.0.0' })).toMatchObject({ ok: true })
    expect(readFileSync(join(a.agent, 'README'), 'utf8')).toBe(expected)
    expect(git(a.agent, 'for-each-ref', '--format=%(refname)', 'refs/talaria/autostash/pending')).toBe('')
    expect(stashes(a.agent)).toHaveLength(listed)
    if (listed) expect(git(a.agent, 'stash', 'show', '-p', `refs/talaria/autostash/${sha}`)).toContain('+local note')
  })

  it('cleanly restored changes leave no stash behind and the update restarts', async () => {
    const a = agentInstall()
    writeFileSync(join(a.agent, 'README'), 'local note\n')
    const events: string[] = []
    const result = await agentService(a.agent, runGit, events).apply('agent', null, () => true, { confirmedRevision: a.v2 })
    expect(result).toMatchObject({ ok: true, restart_scheduled: true })
    expect(result.stash_conflict).toBeUndefined()
    expect(events).toEqual(['restart'])
    expect(readFileSync(join(a.agent, 'README'), 'utf8')).toBe('local note\n')
    expect(stashes(a.agent)).toEqual([])
    expect(git(a.agent, 'for-each-ref', 'refs/talaria')).toBe('') // the private save ref is gone too
  })

  it('a pull failure whose stash restore conflicts keeps a clean checkout and the stash', async () => {
    const a = agentInstall()
    writeFileSync(join(a.agent, 'VERSION'), 'local edit\n')
    // A failed merge that still moved the tree is the only way the restore can conflict; simulate it.
    const moved: GitRun = async (args, cwd, timeout) => {
      if (args[0] !== 'merge') return runGit(args, cwd, timeout)
      await runGit(['merge', '--ff-only', a.v2], cwd, timeout)
      return { ok: false, out: 'fatal: synthetic merge failure' }
    }
    const events: string[] = []
    const result = await agentService(a.agent, moved, events).apply('agent', null, () => true, { confirmedRevision: a.v2 })
    expect(result).toMatchObject({ ok: false, stash_conflict: true })
    expect(String(result.message)).toContain('synthetic merge failure')
    expect(events).toEqual([])
    expect(readFileSync(join(a.agent, 'VERSION'), 'utf8')).toBe('2.0.0\n')
    expect(git(a.agent, 'status', '--porcelain')).toBe('')
    expect(stashes(a.agent)).toHaveLength(1)
  })

  it('the force path resets hard but refuses a pure-ancestor rewind', async () => {
    const a = agentInstall()
    writeFileSync(join(a.agent, 'VERSION'), 'broken\n')
    const forced = await forceAgentUpdate(a.agent, runGit, () => undefined)
    expect(forced).toMatchObject({ ok: true, ref: 'v2.0.0' })
    expect(readFileSync(join(a.agent, 'VERSION'), 'utf8')).toBe('2.0.0\n')
    writeFileSync(join(a.agent, 'ahead.txt'), 'ahead\n')
    git(a.agent, 'add', '.')
    git(a.agent, 'commit', '-m', 'local ahead')
    const head = git(a.agent, 'rev-parse', 'HEAD')
    expect((await forceAgentUpdate(a.agent, runGit, () => undefined)).refused_rewind).toBe(true)
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(head)
    expect(await applyAgentUpdate(a.agent, runGit)).toMatchObject({ ok: false, manual_update: true }) // Stable never falls through to a branch.
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('clear_lock inventories locks and never deletes them', async () => {
    const a = agentInstall()
    writeFileSync(join(a.agent, '.git/index.lock'), '')
    mkdirSync(join(a.agent, '.git/refs/heads'), { recursive: true })
    writeFileSync(join(a.agent, '.git/refs/heads/master.lock'), '')
    const svc = updateService({
      webRoot: join(tmp(), 'web'), getJson: noReleases, identity: { release: () => DEV, stamped: () => DEV, runningSourceRevision: () => null }, webuiVersion: 'x',
      agentDir: () => a.agent, channel: () => 'stable', includeAgent: () => true, blockers: () => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false }),
      scheduleRestart: () => undefined, log: () => undefined,
    })
    const held = await svc.clearLock('agent')
    expect(held).toMatchObject({ ok: false, lock_held: true, manual_command: `rm -f ${join(a.agent, '.git/index.lock')}`, other_locks: ['refs/heads/master.lock'] })
    expect(existsSync(join(a.agent, '.git/index.lock'))).toBe(true)
    rmSync(join(a.agent, '.git/index.lock'))
    rmSync(join(a.agent, '.git/refs/heads/master.lock'))
    expect(inventoryLocks(a.agent)).toEqual({ well_known_lock_present: false, well_known_lock_path: join(a.agent, '.git/index.lock'), other_locks: [] })
    expect(await svc.clearLock('agent')).toMatchObject({ ok: false, confirmation_required: true })
    const retried = await svc.clearLock('agent', { confirmedRevision: a.v2 })
    expect(retried).toMatchObject({ ok: true, lock_recovery: { action: 'no-lock-found', other_locks: [] } })
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v2)
  })

  /** TAL-946: an Agent installed at v2026.9.24 with v0.21.6 and v0.21.7 published after it. */
  function agentReleases(): { agent: string; origin: string; v5: string; v6: string; v7: string } {
    const a = agentInstall()
    for (const repo of [a.origin, a.agent]) git(repo, 'tag', '-d', 'v1.0.0')
    git(a.origin, 'tag', '-d', 'v2.0.0')
    git(a.origin, 'tag', 'v2026.9.24', a.v1)
    git(a.agent, 'tag', 'v2026.9.24', a.v1)
    git(a.origin, 'tag', 'v0.21.6', a.v2)
    git(a.origin, 'commit', '--allow-empty', '-m', 'agent v0.21.7')
    git(a.origin, 'tag', 'v0.21.7')
    return { agent: a.agent, origin: a.origin, v5: a.v1, v6: a.v2, v7: git(a.origin, 'rev-parse', 'HEAD') }
  }
  const NOT_TESTED = 'Not tested with this Talaria'

  it('lists every newer Stable Agent release, newest first, each with its own support (TAL-946)', async () => {
    const r = agentReleases()
    const svc = windowService(r, verified(r.v5, r.v6))
    const agent = updatesCheckView(await svc.check(true)).agent as Dict
    expect(agent).toMatchObject({ current_version: 'v2026.9.24', target_version: 'v0.21.7', support: 'unchecked', support_label: NOT_TESTED, folded_count: 1 })
    expect(agent.versions).toEqual([
      { version: 'v0.21.7', ref: 'v0.21.7', sha: r.v7, release_url: null, latest: true, folded: false, support: 'unchecked', support_label: NOT_TESTED },
      { version: 'v0.21.6', ref: 'v0.21.6', sha: r.v6, release_url: null, latest: false, folded: true, support: 'supported', support_label: 'Supported' },
    ])
    const github: GitRun = (args, cwd, t) => (args[0] === 'remote' && args[1] === 'get-url' ? Promise.resolve({ ok: true, out: 'git@github.com:Synthetic/agent.git' }) : runGit(args, cwd, t))
    expect(((await checkAgentUpdate(r.agent, github)).versions as Dict[]).map((v) => v.release_url)).toEqual(['https://github.com/Synthetic/agent/releases/tag/v0.21.7', 'https://github.com/Synthetic/agent/releases/tag/v0.21.6'])
    expect(updatesCheckView(await windowService(r, verified(r.v5, r.v6), { agentChannel: 'experimental' }).check(true)).agent).toMatchObject({ state: 'commits_behind', versions: [], folded_count: 0 })
    expect(await svc.apply('agent', null, () => true, { confirmedRevision: r.v7 })).toMatchObject({ ok: true, verified_revision: r.v7 })
    expect(updatesCheckView(await svc.check(true)).agent).toMatchObject({ state: 'up_to_date', versions: [], folded_count: 0 })
  })

  it('installs an intermediate Agent release by fast-forwarding to its exact commit (TAL-946)', async () => {
    const r = agentReleases()
    const commands: string[][] = []
    const recording: GitRun = (args, cwd, t) => { commands.push(args); return runGit(args, cwd, t) }
    const policy = { supportedRevisions: [r.v5, r.v6], supportedRevision: r.v6, supportedVersion: '0.21.6' }
    expect(await applyAgentUpdate(r.agent, recording, 'stable', policy, 'v0.21.6')).toMatchObject({ ok: true, ref: 'v0.21.6', verified_revision: r.v6, verified_version: 'v0.21.6' })
    expect(commands).toContainEqual(['merge', '--ff-only', r.v6])
    expect(git(r.agent, 'rev-parse', 'HEAD')).toBe(r.v6)
    expect(await checkAgentUpdate(r.agent, runGit)).toMatchObject({ current_version: 'v0.21.6', latest_version: 'v0.21.7', versions: [{ ref: 'v0.21.7', sha: r.v7 }] })
    const svc = windowService(r, verified(r.v5, r.v6))
    expect(await svc.apply('agent', null, () => true, { version: 'v0.21.7', confirmedRevision: r.v7 })).toMatchObject({ ok: true, verified_revision: r.v7 })
  })

  it('an unchecked intermediate release needs confirmation of its own commit on apply and force (TAL-946)', async () => {
    const r = agentReleases()
    const policy = { supportedRevisions: [r.v5], supportedRevision: r.v5, supportedVersion: '0.21.5' }
    expect(await applyAgentUpdate(r.agent, runGit, 'stable', policy, 'v0.21.6')).toMatchObject({ ok: false, confirmation_required: true, candidate_revision: r.v6, support: 'unchecked' })
    for (const result of [await applyAgentUpdate(r.agent, runGit, 'stable', { ...policy, confirmedRevision: r.v7 }, 'v0.21.6'), await forceAgentUpdate(r.agent, runGit, () => undefined, 'stable', { ...policy, confirmedRevision: r.v7 }, 'v0.21.6')]) {
      expect(result).toMatchObject({ ok: false, confirmation_required: true, candidate_revision: r.v6 })
    }
    expect(git(r.agent, 'rev-parse', 'HEAD')).toBe(r.v5)
    expect(await applyAgentUpdate(r.agent, runGit, 'stable', { ...policy, confirmedRevision: r.v6 }, 'v0.21.6')).toMatchObject({ ok: true, verified_revision: r.v6 })
    expect(git(r.agent, 'rev-parse', 'HEAD')).toBe(r.v6)
  })

  it('rejects an absent, installed, older, or Experimental Agent version without touching the checkout (TAL-946)', async () => {
    const r = agentReleases()
    git(r.origin, 'tag', 'v2026.9.21', r.v5)
    const policy = { supportedRevisions: [r.v5, r.v6, r.v7], supportedRevision: r.v7, supportedVersion: '0.21.7' }
    for (const version of ['v9.9.9', 'v2026.9.24', 'v2026.9.21', 'main']) {
      const expected = { ok: false, message: `Hermes Agent ${version} is not a newer Stable release for this installation. Check for updates and try again.` }
      expect(await applyAgentUpdate(r.agent, runGit, 'stable', policy, version)).toMatchObject(expected)
      expect(await forceAgentUpdate(r.agent, runGit, () => undefined, 'stable', policy, version)).toMatchObject(expected)
    }
    const experimental = { ok: false, message: 'Choosing a version is available only on the Stable channel.' }
    expect(await applyAgentUpdate(r.agent, runGit, 'experimental', policy, 'v0.21.6')).toMatchObject(experimental)
    expect(await forceAgentUpdate(r.agent, runGit, () => undefined, 'experimental', policy, 'v0.21.6')).toMatchObject(experimental)
    expect(git(r.agent, 'rev-parse', 'HEAD')).toBe(r.v5)
  })

  /** TAL-1525: `a`'s service counting Agent fetches; `failFetch` answers them like an unreachable remote. */
  function refreshService(a: { agent: string; v1: string; v2: string }, deps: Partial<UpdateServiceDeps> = {}, support: unknown = verified(a.v1, a.v2)) {
    const counters = { fetches: 0, failFetch: false }
    const svc = windowService(a, support, { deps, onGit: (args) => {
      if (args[0] !== 'fetch') return undefined
      counters.fetches += 1
      return counters.failFetch ? { ok: false, out: 'synthetic: remote unreachable' } : undefined
    } })
    return { svc, counters, inFlight: () => (svc as unknown as { checking: Promise<Dict> | null }).checking }
  }
  const agentView = (svc: UpdateService): Dict => updatesCheckView(svc.cachedStatus()).agent as Dict
  const installedV2 = (a: { v2: string }) => ({ current_sha: a.v2, current_version: 'v2.0.0', behind: 0, state: 'up_to_date', can_apply: false })

  it.each(['finishAgent', 'agentMutation'] as const)('reports the installed Agent as soon as a %s update settles and refreshes once in the background (TAL-1525)', async (path) => {
    const a = agentInstall()
    const restarts: string[] = []
    const { svc, counters, inFlight } = refreshService(a, {
      scheduleRestart: () => restarts.push('restart'),
      // The sidecar path records its dependency-sync intent in Web's state directory.
      ...(path === 'agentMutation' ? { stateDir: tmp(), agentMutation: (_path: string, _revision: string, mutate: (git: GitRun, sync: UpdateServiceDeps['agentSync']) => Promise<Dict>) => mutate(runGit, undefined).then((result) => ({ ...result, restart_scheduled: true })) } : {}),
    })
    expect(agentView(svc)).toBeNull()
    await svc.check(true)
    expect(agentView(svc)).toMatchObject({ current_sha: a.v1, behind: 1, can_apply: true })
    svc.stopAutoApply()
    expect(await svc.apply('agent')).toMatchObject({ ok: true, verified_revision: a.v2, restart_scheduled: true })
    counters.fetches = 0
    expect(restarts).toEqual(['restart'])
    // The poll answers the installed release before any check runs.
    expect(agentView(svc)).toMatchObject(installedV2(a))
    const refresh = inFlight()
    expect(refresh).not.toBeNull()
    await refresh
    expect(counters.fetches).toBe(1)
    expect(agentView(svc)).toMatchObject(installedV2(a))
    expect(inFlight()).toBeNull()
  })

  it('reports the installed Agent after retained recovery completes (TAL-1525)', async () => {
    const a = agentInstall()
    let owed = true
    const recover = vi.fn((probe = false) => {
      // The retained transaction finishes the interrupted update: the checkout reaches the selected release.
      if (!probe) { git(a.agent, 'merge', '--ff-only', '--quiet', 'v2.0.0'); owed = false }
      return Promise.resolve({ ok: !probe, owed, fingerprint: owed ? 'receipt' : '', detail: '', revision: a.v2 })
    })
    const { svc, counters, inFlight } = refreshService(a, { recoverAgent: recover, hasPendingRecovery: () => owed, checkEnabled: () => true })
    await svc.check(true)
    counters.fetches = 0
    vi.useFakeTimers()
    try {
      svc.startAutoApply(60 * 60 * 1000)
      await vi.waitFor(() => { expect(svc.cachedStatus().agent_recovery).toMatchObject({ phase: 'complete' }) })
    } finally { svc.stopAutoApply(); vi.useRealTimers() }
    expect(agentView(svc)).toMatchObject(installedV2(a))
    await inFlight()
    expect(agentView(svc)).toMatchObject(installedV2(a))
  })

  it('keeps the installed Agent when the refresh after an update cannot reach the remote (TAL-1525)', async () => {
    const a = agentInstall()
    const { svc, counters, inFlight } = refreshService(a, { scheduleRestart: () => { counters.failFetch = true } })
    await svc.check(true)
    expect(await svc.apply('agent')).toMatchObject({ ok: true })
    await inFlight()
    expect(counters.failFetch).toBe(true)
    expect(agentView(svc)).toMatchObject({ ...installedV2(a), stale_check: true })
  })

  it('keeps retained local-edit recovery when a later check cannot reach the remote (TAL-1525)', async () => {
    const a = agentInstall()
    git(a.agent, 'fetch', '--quiet', '--tags', 'origin')
    git(a.agent, 'merge', '--ff-only', '--quiet', 'v2.0.0')
    git(a.agent, 'update-ref', `refs/talaria/autostash/pending/${a.v1}`, a.v1)
    const { svc, counters } = refreshService(a)
    await svc.check(true)
    const finish = { current_sha: a.v2, behind: 0, metadata_repair: true, state: 'finish', can_apply: true }
    expect(agentView(svc)).toMatchObject(finish)
    counters.failFetch = true
    await svc.check(true)
    expect(agentView(svc)).toMatchObject({ ...finish, stale_check: true })
  })

  it('refreshes only the local Agent identity while update checks are off (TAL-1525)', async () => {
    const a = agentInstall()
    const { svc, counters, inFlight } = refreshService(a, { checkEnabled: () => false })
    await svc.check(true)
    counters.fetches = 0
    expect(await svc.apply('agent')).toMatchObject({ ok: true })
    const applyFetches = counters.fetches
    expect(agentView(svc)).toMatchObject(installedV2(a))
    expect(inFlight()).toBeNull()
    expect(counters.fetches).toBe(applyFetches)
  })

  it('leaves the cached Agent unchanged after a refused update (TAL-1525)', async () => {
    const a = agentInstall()
    const { svc, inFlight } = refreshService(a, {}, verified(a.v1))
    await svc.check(true)
    const before = agentView(svc)
    expect(await svc.apply('agent')).toMatchObject({ ok: false, confirmation_required: true })
    expect(agentView(svc)).toEqual(before)
    expect(inFlight()).toBeNull()
  })

  it('concurrent invalidations share one background check (TAL-1525)', async () => {
    const a = agentInstall()
    const { svc, counters, inFlight } = refreshService(a)
    await svc.check(true)
    counters.fetches = 0
    git(a.agent, 'merge', '--ff-only', '--quiet', 'v2.0.0')
    const invalidate = (svc as unknown as { invalidate: (target: 'agent') => Promise<void> }).invalidate.bind(svc)
    await Promise.all([invalidate('agent'), invalidate('agent')])
    expect(agentView(svc)).toMatchObject(installedV2(a))
    await inFlight()
    expect(counters.fetches).toBe(1)
  })
})

describe('Web update summary fallback (TAL-1589)', () => {
  const current = 'a'.repeat(40)
  const latest = 'b'.repeat(40)
  const commit = (n: number) => ({ sha: String(n).repeat(40), commit: { message: `web change ${String(n)}\nbody`, committer: { date: '2026-10-29T00:00:00Z' } } })
  function webSummary(behind: number, getJson: GetJson, llm: () => Promise<string>): { svc: UpdateService; calls: () => number } {
    let calls = 0
    const svc = updateService({
      stateDir: tmp(), webRoot: join(tmp(), 'web'), git: runGit, getJson, identity: { release: () => DEV, stamped: () => DEV, runningSourceRevision: () => null }, webuiVersion: 'x',
      agentDir: () => null, channel: () => 'experimental', includeAgent: () => false,
      blockers: () => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false }),
      scheduleRestart: () => undefined, llm: () => { calls += 1; return llm() }, log: () => undefined, summarizeAutomatically: () => false,
    })
    // Seed a checked Experimental status; the commit range is read from `getJson` on demand.
    Object.assign((svc as unknown as { cache: Dict }).cache, { ...svc.cachedStatus(), webui: { name: 'webui', behind, release_based: false, current_sha: current, latest_sha: latest, current_version: 'web-exp-v1.0.0', latest_version: 'web-exp-v1.0.1' } })
    return { svc, calls: () => calls }
  }
  const range = (commits: Dict[], touched: Dict[]): GetJson => (path) => Promise.resolve(path.startsWith('/compare/') ? { status: 'ahead', total_commits: commits.length, commits } : touched)

  it('says the build has no Web changes when the resolved range touches no Web files, without calling the model', async () => {
    const { svc, calls } = webSummary(1, range([commit(1)], []), () => Promise.resolve('- Notice: unused'))
    expect(await svc.summarize('webui')).toMatchObject({ generated_by: 'fallback', source: 'commits', summary_sections: [{ title: 'About this update', items: ['This build has no Talaria Web changes.'] }] })
    expect(calls()).toBe(0)
  })

  it('says the summary could not be generated when the range lookup fails', async () => {
    const { svc } = webSummary(1, () => Promise.reject(new Error('GitHub answered 502')), () => Promise.resolve('- Notice: unused'))
    expect(await svc.summarize('webui')).toMatchObject({ generated_by: 'fallback', summary_sections: [{ title: 'About this update', items: ['Talaria Web has 1 update available. The summary could not be generated; try again later.'] }] })
  })

  it('lists the commit subjects when the model fails', async () => {
    const commits = [commit(1), commit(2), commit(3)]
    const { svc, calls } = webSummary(3, range(commits, commits), () => Promise.reject(new Error('model unavailable')))
    const result = await svc.summarize('webui')
    expect(calls()).toBe(1)
    expect(result).toMatchObject({ generated_by: 'fallback', source: 'commits', summary_sections: [{ title: 'About this update', items: ['Talaria Web has 3 updates, including: web change 1; web change 2; web change 3.'] }] })
    expect(result.summary).not.toContain('update(s)')
  })
})

describe('restart when safe', () => {
  it('waits for active work and gives up after the bound', async () => {
    let calls = 0
    const blockers = (): RestartBlockers => { calls += 1; return { active_streams: calls < 3 ? 1 : 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: calls < 3 } }
    let clock = 0
    const sleep = (ms: number): Promise<void> => { clock += ms; return Promise.resolve() }
    expect((await waitUntilRestartSafe(blockers, { sleep, now: () => clock, pollMs: 2000 })).restart_blocked).toBe(false)
    expect(calls).toBe(3)
    const stuck = await waitUntilRestartSafe(() => ({ active_streams: 0, active_runs: 1, blocking_stream_ids: [], blocking_run_ids: ['r'], restart_blocked: true }), { sleep, now: () => clock, pollMs: 2000, maxWaitMs: 10_000 })
    expect(stuck.wait_timed_out).toBe(true)
  })

  it('the serve supervisor respawns the worker only on the restart exit code', async () => {
    const marker = join(tmp(), 'restarted')
    const script = `const fs=require('node:fs');if(process.env.TALARIA_WEB_WORKER!=='1')process.exit(9);if(fs.existsSync(${JSON.stringify(marker)}))process.exit(3);fs.writeFileSync(${JSON.stringify(marker)},'');process.exit(${String(RESTART_EXIT_CODE)})`
    const lines: string[] = []
    expect(await supervise({ command: [process.execPath, '-e', script], env: process.env, log: (l) => lines.push(l), restartDelayMs: 0 })).toBe(3)
    expect(lines).toEqual(['[serve] restarting the server with the updated source'])
  })
})

describe('update status view (TAL-559)', () => {
  const view = (name: 'webui' | 'agent', info: Dict, off = false): Dict => {
    const v = updateTargetView(name, info, off)
    return { state: v.state, can_apply: v.can_apply, installed_unverified: v.installed_unverified, manual_link: v.manual_link, target_version: v.target_version, summary_available: v.summary_available }
  }
  const row = (state: string, can_apply = false, extra: Dict = {}): Dict => ({ state, can_apply, installed_unverified: false, manual_link: false, target_version: null, summary_available: state === 'release_ready' || state === 'commits_behind', ...extra })
  it.each<[string, 'webui' | 'agent', Dict, boolean, Dict]>([
    ['up to date', 'webui', { behind: 0 }, false, row('up_to_date')],
    ['Stable release ready', 'webui', { behind: 1, release_based: true, current_version: 'web-v1.2.3', latest_version: 'web-v1.3.0', install_kind: 'npm', no_git: true, manual_update: false }, false, row('release_ready', true, { target_version: 'web-v1.3.0' })],
    ['Stable Agent off a release tag', 'agent', { behind: 3, release_based: true, current_version: 'abcdef012345', latest_version: 'v2026.9.30' }, false, row('release_ready', true, { installed_unverified: true, target_version: 'v2026.9.30' })],
    ['Stable Agent with no version', 'agent', { behind: 3, release_based: true, latest_version: 'v2026.9.30' }, false, row('release_ready', true, { installed_unverified: true, target_version: 'v2026.9.30' })],
    ['Experimental commits behind', 'agent', { behind: 14, release_based: false, latest_version: 'main' }, false, row('commits_behind', true)],
    ['dirty Web checkout', 'webui', { behind: 1, manual_update: true, dirty: true }, false, row('local_changes', false, { manual_link: true })],
    ['dirty Agent checkout still applies', 'agent', { behind: 2, dirty: true }, false, row('commits_behind', true)],
    ['current npm package needs its finish step', 'webui', { behind: 0, metadata_repair: true, latest_version: 'web-v1.3.0', no_git: true, install_kind: 'npm' }, false, row('finish', true, { target_version: 'web-v1.3.0' })],
    ['finish step on a manual install', 'webui', { behind: 0, metadata_repair: true, manual_update: true }, false, row('finish')],
    ['contributor checkout', 'webui', { behind: null, manual_update: true, no_git: false }, false, row('manual', false, { manual_link: true })],
    ['npm install ahead of Stable', 'webui', { behind: 0, manual_update: true, no_git: true, install_kind: 'npm' }, false, row('manual')],
    ['manual Stable release behind', 'webui', { behind: 2, release_based: true, manual_update: true, latest_version: 'web-v1.3.0' }, false, row('manual', false, { manual_link: true, target_version: 'web-v1.3.0' })],
    ['divergent Agent checkout', 'agent', { behind: 0, manual_update: true }, false, row('manual')],
    ['Agent without a checkout', 'agent', { behind: null, no_git: true }, false, row('manual')],
    ['failed check', 'webui', { behind: null, manual_update: true, error: 'release metadata unavailable' }, false, row('check_failed', false, { manual_link: true })],
    ['failed Agent fetch', 'agent', { behind: null, error: 'fetch failed', dirty: true }, false, row('check_failed')],
    ['ignored Agent', 'agent', { name: 'agent', behind: 0, ignored: true }, false, row('off')],
    ['disabled checks', 'webui', { behind: 3, manual_update: true }, true, row('off')],
    ['unknown count', 'webui', { behind: null }, false, row('unknown')],
  ])('%s', (_label, name, info, off, expected) => { expect(view(name, info, off)).toEqual(expected) })

  it('keeps every target field and leaves a missing target null unless checks are off', () => {
    const status = updatesCheckView({ cached: true, webui: { name: 'webui', behind: 1, current_version: 'web-v1' }, agent: null })
    expect(status).toMatchObject({ cached: true, webui: { name: 'webui', behind: 1, current_version: 'web-v1', state: 'commits_behind', can_apply: true }, agent: null })
    expect(updatesCheckView({ disabled: true })).toMatchObject({ disabled: true, webui: { state: 'off', can_apply: false }, agent: { state: 'off', can_apply: false } })
  })

  it('lists versions only while a release is installable and folds all but the newest (TAL-946)', () => {
    const versions = [{ version: 'v0.21.7', ref: 'v0.21.7' }, { version: 'v0.21.6', ref: 'v0.21.6' }]
    expect(updateTargetView('agent', { behind: 2, release_based: true, latest_version: 'v0.21.7', versions }, false)).toMatchObject({
      folded_count: 1, versions: [{ ref: 'v0.21.7', latest: true, folded: false }, { ref: 'v0.21.6', latest: false, folded: true }],
    })
    for (const [info, off] of [[{ behind: 0, versions }, false], [{ behind: 2, release_based: true, manual_update: true, versions }, false], [{ behind: 2, versions }, false], [{ behind: 2, release_based: true, versions }, true]] as const) {
      expect(updateTargetView('agent', info, off)).toMatchObject({ versions: [], folded_count: 0 })
    }
  })

  it('the shared updates-check fixture is this server\'s view (TAL-946)', () => {
    const fixture = JSON.parse(readFileSync(join(WEB_ROOT, '../contracts/fixtures/updates-check.json'), 'utf8')) as Dict
    expect(updatesCheckView(fixture)).toEqual(fixture)
    expect(fixture).toMatchObject({ webui: { folded_count: 2 }, agent: { folded_count: 1 } })
  })
})
