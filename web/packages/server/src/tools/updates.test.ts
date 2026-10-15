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
import type { Dict } from '../config/agent-config.js'
import { detectWebuiVersion, developmentInfo } from '../release.js'
import { bootTestServer, WEB_ROOT } from '../test/harness.js'
import { RESTART_EXIT_CODE, supervise } from '../cli/supervise.js'
import {
  applyAgentUpdate, applyWebUpdate, CACHE_TTL_S, checkAgentUpdate, checkWebUpdate, forceAgentUpdate, githubJson, inventoryLocks, npmInstallInfo, publishedWebRelease, ReleaseUnavailable,
  REPOSITORY_URL, runGit, sanitizeGitDiagnostic, UpdateService, updatesCheckView, updateTargetView, waitUntilRestartSafe, type BuildRun, type GetJson, type GitRun, type PublishedRelease, type ReleaseIdentity, type RestartBlockers, type UpdateServiceDeps,
} from './updates.js'

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Synthetic', GIT_COMMITTER_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' }
const saved: Record<string, string | undefined> = {}
beforeAll(() => { for (const [k, v] of Object.entries(GIT_ENV)) { saved[k] = process.env[k]; process.env[k] = v } })
afterAll(() => { for (const k of Object.keys(GIT_ENV)) process.env[k] = saved[k] })

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
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
    const svc = new UpdateService({
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
      autoNotification: { begin: () => { notificationEvents.push('begin'); return `notice-${String(notificationEvents.length)}` }, transition: (_id, phase) => { notificationEvents.push(phase) } },
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
  function npmService(opts: { channel?: () => 'stable' | 'experimental'; agentDir?: string | null; blockers?: () => RestartBlockers; autoApply?: () => boolean; checkEnabled?: () => boolean; autoNotification?: UpdateServiceDeps['autoNotification']; npm?: (inner: BuildRun) => BuildRun } = {}) {
    const s = sourceInstall()
    const n = npmPackageInstall(s)
    const restarts: number[] = []
    const svc = new UpdateService({
      webRoot: n.packageRoot, git: s.run, npm: opts.npm ? opts.npm(n.npm) : n.npm, getJson: s.getJson, identity: s.identity, webuiVersion: 'web-v1.0.0',
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

  it('automatically installs the exact completed Stable npm release and schedules restart', async () => {
    const s = sourceInstall()
    const n = npmPackageInstall(s)
    const restarts: number[] = []
    const svc = new UpdateService({
      webRoot: n.packageRoot, git: s.run, npm: n.npm, getJson: s.getJson, identity: s.identity, webuiVersion: 'web-v1.0.0',
      agentDir: () => null, channel: () => 'stable', includeAgent: () => false, autoApply: () => true,
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

  it.each(['failure', 'bad-stamp', 'empty-dependency'] as const)('fails closed when the npm replacement is %s', async (outcome) => {
    const s = sourceInstall()
    const n = npmPackageInstall(s, outcome)
    const result = await applyWebUpdate(n.packageRoot, 'stable', s.run, s.getJson, s.identity, n.npm)
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
    const result = await applyWebUpdate(n.packageRoot, 'stable', s.run, s.getJson, s.identity, n.npm, () => true, { selfCheckTimeoutMs: 1000 })
    expect(result).toMatchObject({ ok: false, verification_failed: true })
    expect(result.message).toContain(detail)
    expect((JSON.parse(readFileSync(join(n.packageRoot, 'package.json'), 'utf8')) as { version: string }).version).toBe('1.0.0')
  })

  it('accepts a Stable candidate from before self-check once its node-pty binding loads (TAL-1012)', async () => {
    const s = sourceInstall()
    const n = npmPackageInstall(s, 'legacy-bin')
    expect(await applyWebUpdate(n.packageRoot, 'stable', s.run, s.getJson, s.identity, n.npm)).toMatchObject({ ok: true })
    expect((JSON.parse(readFileSync(join(n.packageRoot, 'package.json'), 'utf8')) as { version: string }).version).toBe('2.0.0')
    const t = sourceInstall()
    const broken = npmPackageInstall(t, 'legacy-bin-broken-pty')
    const result = await applyWebUpdate(broken.packageRoot, 'stable', t.run, t.getJson, t.identity, broken.npm)
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

  it('summarizes the published notes of the Stable Web releases an npm update installs (TAL-759)', async () => {
    const s = sourceInstall()
    const n = npmPackageInstall(s)
    const notes = { tag_name: 'web-v2.0.0', published_at: '2026-09-19T00:00:00Z', assets: [], body: 'Chats open faster.\n\n<!-- talaria-publication:{"tag":"web-v2.0.0"} -->' }
    const getJson: GetJson = async (path, opts) => (opts.asset ? s.getJson(path, opts) : [notes, ...(await s.getJson(path, opts) as Dict[])])
    const prompts: string[] = []
    const svc = new UpdateService({
      webRoot: n.packageRoot, git: s.run, npm: n.npm, getJson, identity: s.identity, webuiVersion: 'web-v1.0.0',
      agentDir: () => null, channel: () => 'stable', includeAgent: () => false,
      blockers: () => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false }),
      scheduleRestart: () => undefined, llm: (_system, user) => { prompts.push(user); return Promise.resolve('- Notice: Chats open faster') }, log: () => undefined,
    })
    const webui = updatesCheckView(await svc.check(true, false, 'stable')).webui as Dict
    expect(webui).toMatchObject({ state: 'release_ready', summary_available: true })
    expect(webui).not.toHaveProperty('release_notes')
    expect(await svc.summarize('webui')).toMatchObject({ target: 'webui', source: 'release_notes', generated_by: 'llm' })
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
    const svc = new UpdateService({
      webRoot: n.packageRoot, git: s.run, npm: n.npm, getJson, identity: s.identity, webuiVersion: 'web-v1.0.0', agentDir: () => null, channel: () => 'stable', includeAgent: () => false,
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
    expect(await applyWebUpdate(h.n.packageRoot, 'stable', h.s.run, h.getJson, h.s.identity, h.n.npm)).toMatchObject({ ok: true, npm: '@maudecode/talaria-web@2.0.0' })
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
    const svc = new UpdateService({
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
    const svc = new UpdateService({
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
  function windowService(a: { agent: string }, support: unknown, opts: { agentChannel?: 'stable' | 'experimental'; pin?: string } = {}): UpdateService {
    const s = sourceInstall()
    if (support !== undefined) write(join(web(s.client), 'sidecar/agent_support.json'), typeof support === 'string' ? support : JSON.stringify(support))
    if (opts.pin) s.id.release = { ...s.id.release, compatibleAgent: { ...(s.id.release.compatibleAgent as Dict), sourceRevision: opts.pin } }
    return new UpdateService({
      webRoot: web(s.client), git: (args, cwd, timeout) => cwd === a.agent ? runGit(args, cwd, timeout) : s.run(args, cwd, timeout), getJson: noReleases, identity: s.identity, webuiVersion: 'test',
      agentDir: () => a.agent, channel: () => 'experimental', agentChannel: () => opts.agentChannel ?? 'stable', includeAgent: () => true,
      blockers: () => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false }),
      scheduleRestart: () => undefined, log: () => undefined,
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

  function summaryService(a: { agent: string; origin: string }, opts: { channel?: 'stable' | 'experimental'; getPublicJson?: GetJson; llm?: (system: string, user: string) => Promise<string>; now?: () => number } = {}): { svc: UpdateService; prompts: string[] } {
    // The checkout fetches its local origin but reports a GitHub remote, whose releases `getPublicJson` stubs.
    const run: GitRun = (args, cwd, t) => (args[0] === 'remote' && args[1] === 'get-url' ? Promise.resolve({ ok: true, out: 'https://github.com/Synthetic/agent.git' }) : runGit(args, cwd, t))
    const prompts: string[] = []
    const svc = new UpdateService({
      webRoot: join(tmp(), 'web'), git: run, getJson: noReleases, ...(opts.getPublicJson ? { getPublicJson: opts.getPublicJson } : {}), identity: { release: () => DEV, stamped: () => DEV, runningSourceRevision: () => null }, webuiVersion: 'x',
      agentDir: () => a.agent, channel: () => 'stable', agentChannel: () => opts.channel ?? 'stable', includeAgent: () => true, blockers: () => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false }),
      scheduleRestart: () => undefined, llm: (system, user) => { prompts.push(user); return opts.llm ? opts.llm(system, user) : Promise.resolve('- Notice: Chats open faster') }, log: () => undefined,
      ...(opts.now ? { now: opts.now } : {}),
    })
    return { svc, prompts }
  }

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

  it('keeps the newest releases within the prompt caps and names what the summary covers', async () => {
    const a = agentInstall()
    for (let i = 1; i <= 10; i++) { git(a.origin, 'commit', '--allow-empty', '-m', `release ${String(i)}`); git(a.origin, 'tag', `v2.${String(i)}.0`) }
    const paths: string[] = []
    const { svc, prompts } = summaryService(a, { getPublicJson: notesFor(paths, (tag) => (tag === 'v2.10.0' ? 'x'.repeat(9000) : `Release notes for ${tag}`)) })
    await svc.check(true)
    const result = await svc.summarize('agent')
    expect(paths).toHaveLength(11)
    expect(paths.slice(0, 2)).toEqual(['/repos/Synthetic/agent/releases/latest', '/repos/Synthetic/agent/releases/tags/v2.1.0'])
    expect(prompts[0]).not.toContain('Release notes for v2.0.0')
    expect(prompts[0]).not.toContain('x'.repeat(8001))
    expect((result.summary_sections as Dict[])[1]).toEqual({ title: 'Worth knowing', items: [expect.stringMatching(/^Hermes Agent has 11 releases to install; this summary covers the release notes for v2\.1\.0, .*v2\.10\.0\.$/)] })
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
    expect(await svc.summarize('agent')).toMatchObject({ generated_by: 'fallback', source: 'release_notes', summary_sections: [{ title: "What you'll notice", items: ['Hermes Agent v2.0.0, v2.1.0 are available.'] }] })
    expect(calls).toBe(1)
    // A fallback is not cached, so the next request asks the model again.
    await svc.summarize('agent')
    expect(calls).toBe(2)
  })

  function agentService(agent: string, git: GitRun, events: string[], agentSync?: UpdateServiceDeps['agentSync'], stateDir = join(agent, '../web-state'), agentHomes?: UpdateServiceDeps['agentHomes']): UpdateService {
    return new UpdateService({
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

  it('TAL-953: refuses an Agent update while a gateway restart runs, without touching the checkout', async () => {
    const a = agentInstall()
    const base = agentService(a.agent, runGit, []) as unknown as { deps: UpdateServiceDeps }
    const svc = new UpdateService({ ...base.deps, gatewayRestarting: () => true })
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
  ])('the next check recovers the changes of an interrupted update that %s', async (_, reverted, later, expected, listed) => {
    const a = agentInstall()
    writeFileSync(join(a.agent, 'README'), 'local note\n')
    const sha = git(a.agent, 'stash', 'create', 'hermes-update-autostash')
    git(a.agent, 'update-ref', `refs/talaria/autostash/pending/${sha}`, sha) // the server stopped here or later
    if (reverted) git(a.agent, 'checkout', '--', 'README')
    if (later) writeFileSync(join(a.agent, 'README'), later)
    await checkAgentUpdate(a.agent, runGit)
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
    const svc = new UpdateService({
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
