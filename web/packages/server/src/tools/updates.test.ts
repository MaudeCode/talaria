/*
 * Regression ports (TAL-245): behaviour previously guarded by the Python cases in
 *   web/tests/test_issue4356_no_git_update_check.py
 *   web/tests/test_issue5175_macos_launchd_git.py
 * (issues #4356, #5175) is covered here; see docs/architecture/regression-port-ledger.md.
 */
/**
 * Port of `tests/test_tal203_source_update.py`, `tests/test_tal203_published_releases.py`,
 * and the Agent branches of `tests/test_updates*.py` onto synthetic repositories and manifests.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Dict } from '../config/agent-config.js'
import { detectWebuiVersion, developmentInfo } from '../release.js'
import { WEB_ROOT } from '../test/harness.js'
import { RESTART_EXIT_CODE, supervise } from '../cli/supervise.js'
import {
  applyAgentUpdate, applyWebUpdate, checkAgentUpdate, checkWebUpdate, forceAgentUpdate, githubJson, inventoryLocks, publishedWebRelease, ReleaseUnavailable,
  REPOSITORY_URL, runGit, sanitizeGitDiagnostic, UpdateService, waitUntilRestartSafe, WEB_BUILD_STEPS, WEB_SERVER_ENTRY, type BuildRun, type GetJson, type GitRun, type PublishedRelease, type ReleaseIdentity, type RestartBlockers,
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

interface Install { client: string; upstream: string; old: string; latest: string; release: PublishedRelease; identity: ReleaseIdentity; id: { release: Dict; stamped: Dict; running: string | null }; run: GitRun; commands: string[][]; getJson: GetJson; requests: string[]; build: BuildRun; builds: string[][]; failBuild: { step: number | null } }

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
  const release: PublishedRelease = { tag: 'web-v2.0.0', version: '2.0.0', sourceRevision: latest, releaseSet: latest, image: `ghcr.io/maudecode/talaria-web@sha256:${'f'.repeat(64)}`, manifestReleaseSet: latest, runtime, release_url: `${REPOSITORY_URL}/releases/tag/release-set-${latest}` }
  const id = { release: DEV as Dict, stamped: DEV as Dict, running: null as string | null }
  const identity: ReleaseIdentity = { release: () => id.release, stamped: () => id.stamped, runningSourceRevision: () => id.running }
  const commands: string[][] = []
  const run: GitRun = (args, cwd, t) => { commands.push(args); return runGit(args[0] === 'fetch' ? args.map((a) => (a === 'origin' ? upstream : a)) : args, cwd, t) }
  const requests: string[] = []
  const getJson: GetJson = (path, { asset }) => {
    requests.push(path)
    const set = `release-set-${release.sourceRevision}`
    if (asset) return Promise.resolve({ schemaVersion: 1, releaseSet: release.sourceRevision, status: 'complete', contracts: { appWeb: { web: [1] }, webRelay: { web: [2] } }, agent: release.runtime.compatibleAgent, components: { web: { tag: release.tag, version: release.version, sourceRevision: release.sourceRevision, releaseSet: release.sourceRevision, image: release.image } } })
    return Promise.resolve([{ tag_name: set, published_at: '2026-09-19T00:00:00Z', assets: [{ name: 'release-set.json', id: 123 }] }])
  }
  const builds: string[][] = []
  const failBuild = { step: null as number | null }
  // The synthetic checkout has no real packages: the build runner records each step and materialises the entry point.
  const build: BuildRun = (args, cwd) => {
    builds.push(args)
    if (failBuild.step === builds.length - 1) return Promise.resolve({ ok: false, out: 'synthetic build failure' })
    if (args[1] === 'build' && args.includes('packages/server')) write(join(cwd, WEB_SERVER_ENTRY), '// built\n')
    return Promise.resolve({ ok: true, out: '' })
  }
  return { client, upstream, old, latest, release, identity, id, run, commands, getJson, requests, build, builds, failBuild }
}

const noReleases: GetJson = () => { throw new Error('Main must not query releases') }
const web = (client: string): string => join(client, 'web')

describe('Web source updates (test_tal203_source_update.py)', () => {
  it.each([false, true])('fast-forwards the published source and stamps the runtime (worktree=%s)', async (worktree) => {
    const s = sourceInstall()
    let client = s.client
    if (worktree) {
      client = join(s.client, '..', 'worktree')
      git(s.client, 'worktree', 'add', '--detach', client, 'HEAD')
      expect(readFileSync(join(client, '.git'), 'utf8')).toContain('gitdir')
    }
    const result = await applyWebUpdate(web(client), 'stable', s.run, s.getJson, s.identity, s.build)
    expect(result.ok).toBe(true)
    expect(git(client, 'rev-parse', 'HEAD')).toBe(s.latest)
    expect(readFileSync(join(client, 'web/package.json'), 'utf8')).toBe('{"version":"2.0.0"}\n')
    expect(readStamp(client)).toEqual(s.release.runtime)
    s.id.release = s.release.runtime
    expect((await applyWebUpdate(web(client), 'stable', s.run, s.getJson, s.identity, s.build)).up_to_date).toBe(true)
  })

  it('installs and builds the checkout before stamping, and a failed build leaves the stamp and restart untouched', async () => {
    const s = sourceInstall()
    const result = await applyWebUpdate(web(s.client), 'stable', s.run, s.getJson, s.identity, s.build)
    expect(result.ok).toBe(true)
    expect(s.builds).toEqual(WEB_BUILD_STEPS)
    expect(existsSync(join(s.client, 'web', WEB_SERVER_ENTRY))).toBe(true)
    const failing = sourceInstall()
    failing.failBuild.step = 0
    const { svc, restarts } = service(failing)
    const failed = await svc.apply('webui')
    expect(failed).toMatchObject({ ok: false, build_failed: true })
    expect(String(failed.message)).toContain('npm ci')
    expect(git(failing.client, 'rev-parse', 'HEAD')).toBe(failing.latest)
    expect(existsSync(join(failing.client, 'web/_release.json'))).toBe(false)
    expect(restarts).toEqual([])
    // Once the build succeeds the same source is stamped and the restart is scheduled.
    failing.failBuild.step = null
    expect(await svc.apply('webui')).toMatchObject({ ok: true, restart_scheduled: true })
    expect(readStamp(failing.client)).toEqual(failing.release.runtime)
    expect(restarts).toEqual([1])
  })

  it.each(['web/package.json', 'untracked.txt', 'web/cache.txt'])('never discards local files (%s)', async (file) => {
    const s = sourceInstall()
    writeFileSync(join(s.client, file), 'local work must survive\n')
    const result = await applyWebUpdate(web(s.client), 'stable', s.run, s.getJson, s.identity, s.build)
    expect(result.ok).toBe(false)
    expect(readFileSync(join(s.client, file), 'utf8')).toBe('local work must survive\n')
    expect(git(s.client, 'rev-parse', 'HEAD')).toBe(s.old)
    if (file !== 'web/cache.txt') expect(s.commands.some((c) => c[0] === 'fetch')).toBe(false)
  })

  it('refuses divergence and a manifest/tag mismatch', async () => {
    const s = sourceInstall()
    writeFileSync(join(s.client, 'local.txt'), 'committed local work')
    git(s.client, 'add', '.')
    git(s.client, 'commit', '-m', 'synthetic divergent work')
    const head = git(s.client, 'rev-parse', 'HEAD')
    const status = await checkWebUpdate(web(s.client), 'web-v1.0.0', 'stable', s.run, s.getJson, s.identity)
    expect(status.installed_sha).toBe(head)
    expect(status.current_sha).toBe(s.old)
    expect(String(status.compare_url)).not.toContain(head)
    expect(status.manual_update).toBe(true)
    expect((await applyWebUpdate(web(s.client), 'stable', s.run, s.getJson, s.identity, s.build)).ok).toBe(false)
    expect(git(s.client, 'rev-parse', 'HEAD')).toBe(head)
    git(s.client, 'reset', '--hard', s.old)
    s.release.sourceRevision = 'b'.repeat(40)
    expect((await applyWebUpdate(web(s.client), 'stable', s.run, s.getJson, s.identity, s.build)).ok).toBe(false)
    expect(git(s.client, 'rev-parse', 'HEAD')).toBe(s.old)
  })

  it('legacy or unrelated checkouts require manual migration', async () => {
    const s = sourceInstall()
    expect((await applyWebUpdate(s.client, 'stable', s.run, s.getJson, s.identity, s.build)).manual_update).toBe(true)
    git(s.client, 'remote', 'set-url', 'origin', 'https://github.com/other/project.git')
    expect((await applyWebUpdate(web(s.client), 'stable', s.run, s.getJson, s.identity, s.build)).manual_update).toBe(true)
    expect(git(s.client, 'rev-parse', 'HEAD')).toBe(s.old)
    expect(s.commands.some((c) => c[0] === 'fetch')).toBe(false)
  })

  function service(s: Install, opts: { channel?: 'stable' | 'experimental'; getJson?: GetJson; agentDir?: string | null; blockers?: () => RestartBlockers; gateway?: () => Promise<Dict>; llm?: (system: string, user: string) => Promise<string> } = {}): { svc: UpdateService; restarts: number[] } {
    const restarts: number[] = []
    const svc = new UpdateService({
      webRoot: web(s.client), git: s.run, build: s.build, getJson: opts.getJson ?? s.getJson, identity: s.identity, webuiVersion: 'development',
      agentDir: () => opts.agentDir ?? null, channel: () => opts.channel ?? 'stable', includeAgent: () => true,
      blockers: opts.blockers ?? (() => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false })),
      scheduleRestart: () => restarts.push(1), gatewayRestart: opts.gateway ?? (() => Promise.resolve({ status: 'completed' })), llm: opts.llm ?? null, sleep: () => Promise.resolve(), log: () => undefined,
    })
    return { svc, restarts }
  }

  it('main tracks the branch without a release lookup and waits for the restart', async () => {
    const s = sourceInstall()
    writeFileSync(join(s.upstream, 'web/package.json'), '{"version":"unreleased main"}\n')
    git(s.upstream, 'add', '.')
    git(s.upstream, 'commit', '-m', 'synthetic unreleased main')
    const latest = git(s.upstream, 'rev-parse', 'HEAD')
    s.id.running = s.old
    const { svc, restarts } = service(s, { channel: 'experimental', getJson: noReleases })
    const status = (await svc.check(true)).webui as Dict
    expect(status.channel).toBe('experimental')
    expect(status.branch).toBe('origin/main')
    expect(status.latest_sha).toBe(latest)
    expect(status.behind).toBe(2)
    expect(status.release_based).toBe(false)
    const summary = await svc.summarize({ webui: status }, null)
    expect(((summary.targets as Dict[])[0]?.commits as string[])).toContain('synthetic unreleased main')
    expect((await svc.apply('webui')).restart_scheduled).toBe(true)
    expect(git(s.client, 'rev-parse', 'HEAD')).toBe(latest)
    expect(readFileSync(join(s.client, 'web/package.json'), 'utf8')).toBe('{"version":"unreleased main"}\n')
    expect(readStamp(s.client)).toBeNull()
    expect(((await svc.check(true)).webui as Dict).metadata_repair).toBe(true)
    expect((await svc.clearLock('webui')).restart_scheduled).toBe(true)
    s.id.running = latest
    expect((await svc.apply('webui')).up_to_date).toBe(true)
    expect(restarts).toHaveLength(2)
    expect(s.commands.some((c) => c[0] === 'fetch' && c.includes('--tags'))).toBe(false)
  })

  it.each(['dirty', 'untracked', 'diverged', 'ahead', 'operation', 'fetch_failed'])('main preserves unsafe checkout states (%s)', async (state) => {
    const s = sourceInstall()
    if (state === 'dirty') writeFileSync(join(s.client, 'web/package.json'), 'keep edits')
    else if (state === 'untracked') writeFileSync(join(s.client, 'personal.txt'), 'keep untracked')
    else if (state === 'diverged' || state === 'ahead') {
      if (state === 'ahead') git(s.client, 'reset', '--hard', 'origin/main')
      writeFileSync(join(s.client, 'web/package.json'), 'keep local commit')
      git(s.client, 'add', '.')
      git(s.client, 'commit', '-m', 'synthetic local work')
    } else if (state === 'operation') writeFileSync(join(s.client, '.git/MERGE_HEAD'), 'a'.repeat(40))
    const head = git(s.client, 'rev-parse', 'HEAD')
    const before = readFileSync(join(s.client, 'web/package.json'))
    const runner: GitRun = state === 'fetch_failed' ? (args, cwd, t) => (args[0] === 'fetch' ? Promise.resolve({ out: 'fetch unavailable', ok: false }) : s.run(args, cwd, t)) : s.run
    expect((await applyWebUpdate(web(s.client), 'experimental', runner, noReleases, s.identity, s.build)).ok).toBe(false)
    expect(git(s.client, 'rev-parse', 'HEAD')).toBe(head)
    expect(readFileSync(join(s.client, 'web/package.json'))).toEqual(before)
    if (state === 'untracked') expect(readFileSync(join(s.client, 'personal.txt'), 'utf8')).toBe('keep untracked')
  })

  it('main removes only its unchanged release stamp', async () => {
    const s = sourceInstall()
    expect((await applyWebUpdate(web(s.client), 'stable', s.run, s.getJson, s.identity, s.build)).ok).toBe(true)
    const stamp = join(s.client, 'web/_release.json')
    s.id.stamped = s.release.runtime
    s.id.release = s.release.runtime
    s.id.running = s.latest
    writeFileSync(join(s.upstream, 'web/package.json'), '{"version":"next main"}\n')
    git(s.upstream, 'add', '.')
    git(s.upstream, 'commit', '-m', 'synthetic main')
    const original = readFileSync(stamp)
    writeFileSync(stamp, '{"custom":"preserve"}')
    expect((await applyWebUpdate(web(s.client), 'experimental', s.run, noReleases, s.identity, s.build)).ok).toBe(false)
    expect(git(s.client, 'rev-parse', 'HEAD')).toBe(s.latest)
    expect(readFileSync(stamp, 'utf8')).toBe('{"custom":"preserve"}')
    writeFileSync(stamp, original)
    expect((await applyWebUpdate(web(s.client), 'experimental', s.run, noReleases, s.identity, s.build)).ok).toBe(true)
    expect(existsSync(stamp)).toBe(false)
  })

  it('the main setting round-trips and keeps the Agent channel independent', async () => {
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
    expect((status.webui as Dict).branch).toBe('origin/main')
    // The Agent checkout is inspected with its own `v*` tags regardless of the Web channel.
    expect(agentCalls.some((c) => c[0] === 'tag' && c.includes('v*'))).toBe(true)
    expect(svc.cachedStatus(false).agent).toEqual({ name: 'agent', behind: 0, ignored: true })
  })

  it.each(['app/client.swift', 'relay/backend.ts', 'README.md', 'changelog.d/example.json', '.github/workflows/example.yml'])('main ignores unrelated changes without updating or restarting (%s)', async (path) => {
    const s = sourceInstall()
    git(s.client, 'reset', '--hard', s.latest)
    write(join(s.upstream, path), 'synthetic unrelated change\n')
    git(s.upstream, 'add', '.')
    git(s.upstream, 'commit', '-m', 'synthetic unrelated update')
    s.id.running = s.latest
    const { svc, restarts } = service(s, { channel: 'experimental', getJson: noReleases })
    const status = (await svc.check(true)).webui as Dict
    expect(status.behind).toBe(0)
    expect(status.metadata_repair).toBe(false)
    expect((await svc.summarize({ webui: status }, null)).targets).toEqual([])
    expect((await svc.apply('webui', 'experimental')).up_to_date).toBe(true)
    expect(git(s.client, 'rev-parse', 'HEAD')).toBe(s.latest)
    expect(restarts).toEqual([])
  })

  it('main counts Web and contract changes and excludes unrelated commits from the summary', async () => {
    const s = sourceInstall()
    git(s.client, 'reset', '--hard', s.latest)
    write(join(s.upstream, 'README.md'), 'unrelated root documentation')
    git(s.upstream, 'add', '.')
    git(s.upstream, 'commit', '-m', 'synthetic unrelated update')
    write(join(s.upstream, 'contracts/versions.json'), '{"synthetic":"updated"}')
    git(s.upstream, 'add', '.')
    git(s.upstream, 'commit', '-m', 'synthetic shared contract update')
    const latest = git(s.upstream, 'rev-parse', 'HEAD')
    s.id.running = s.latest
    const { svc } = service(s, { channel: 'experimental', getJson: noReleases })
    let status = await checkWebUpdate(web(s.client), 'development', 'experimental', s.run, noReleases, s.identity)
    expect(status.behind).toBe(1)
    expect(((await svc.summarize({ webui: status }, null)).targets as Dict[])[0]?.commits).toEqual(['synthetic shared contract update'])
    expect((await applyWebUpdate(web(s.client), 'experimental', s.run, noReleases, s.identity, s.build)).ok).toBe(true)
    expect(git(s.client, 'rev-parse', 'HEAD')).toBe(latest)
    // A later excluded commit cannot hide the pending restart for changed contracts.
    write(join(s.upstream, 'README.md'), 'next unrelated change')
    git(s.upstream, 'commit', '-am', 'synthetic next unrelated update')
    status = await checkWebUpdate(web(s.client), 'development', 'experimental', s.run, noReleases, s.identity)
    expect(status.behind).toBe(0)
    expect(status.metadata_repair).toBe(true)
    const result = await applyWebUpdate(web(s.client), 'experimental', s.run, noReleases, s.identity, s.build)
    expect(result.ok).toBe(true)
    expect(result.up_to_date).toBeUndefined()
    expect(git(s.client, 'rev-parse', 'HEAD')).toBe(latest)
    s.id.running = latest
    expect((await checkWebUpdate(web(s.client), 'development', 'experimental', s.run, noReleases, s.identity)).metadata_repair).toBe(false)
  })

  it('main does not offer reverted Web changes', async () => {
    const s = sourceInstall()
    git(s.client, 'reset', '--hard', s.latest)
    const original = readFileSync(join(s.upstream, 'web/package.json'))
    writeFileSync(join(s.upstream, 'web/package.json'), 'temporary change')
    git(s.upstream, 'commit', '-am', 'synthetic temporary change')
    writeFileSync(join(s.upstream, 'web/package.json'), original)
    git(s.upstream, 'commit', '-am', 'synthetic revert')
    s.id.running = s.latest
    expect((await checkWebUpdate(web(s.client), 'development', 'experimental', s.run, noReleases, s.identity)).behind).toBe(0)
    expect((await applyWebUpdate(web(s.client), 'experimental', s.run, noReleases, s.identity, s.build)).up_to_date).toBe(true)
    expect(git(s.client, 'rev-parse', 'HEAD')).toBe(s.latest)
  })

  it('public update entrypoints use the safe monorepo path (force never discards work)', async () => {
    const s = sourceInstall()
    const { svc, restarts } = service(s)
    const status = (await svc.check(true)).webui as Dict
    expect(status.behind).toBe(1)
    expect(status.repo_url).toBe(REPOSITORY_URL)
    expect(String(status.compare_url).endsWith(`${s.old}...${s.latest}`)).toBe(true)
    const local = join(s.client, 'unrelated-app-work.txt')
    writeFileSync(local, 'preserve this')
    expect((await svc.force('webui', 'stable')).ok).toBe(false)
    expect(readFileSync(local, 'utf8')).toBe('preserve this')
    expect(restarts).toEqual([])
    rmSync(local)
    const result = await svc.apply('webui', 'stable')
    expect(result.ok).toBe(true)
    expect(result.restart_scheduled).toBe(true)
    expect(git(s.client, 'rev-parse', 'HEAD')).toBe(s.latest)
    expect(restarts).toEqual([1])
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
    expect(result.behind).toBe(1)
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

  it('[py:test_issue4356_no_git_update_check.py::test_check_repo_returns_no_git_sentinel_when_dot_git_absent] a web root without .git reports the no_git sentinel', async () => {
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

  it('the Web lock retry preserves the git lock and then updates', async () => {
    const s = sourceInstall()
    const { svc } = service(s)
    const lock = join(s.client, '.git/index.lock')
    writeFileSync(lock, 'synthetic active Git operation')
    const blocked = await svc.clearLock('webui')
    expect(blocked.ok).toBe(false)
    expect(blocked.lock_conflict).toBe(true)
    expect(blocked.lock_recovery).toEqual({ action: 'retry-only' })
    expect(readFileSync(lock, 'utf8')).toBe('synthetic active Git operation')
    expect(git(s.client, 'rev-parse', 'HEAD')).toBe(s.old)
    rmSync(lock) // The fixture owns the lock, exactly as a completed Git process does.
    expect((await svc.clearLock('webui')).ok).toBe(true)
    expect(git(s.client, 'rev-parse', 'HEAD')).toBe(s.latest)
  })

  it.each([[false, false], [false, true], [true, false], [true, true]])('a retry repairs the stamp after the source advanced and schedules a restart (existing stamp=%s, restarted=%s)', async (existingStamp, restarted) => {
    const s = sourceInstall()
    const stamp = join(s.client, 'web/_release.json')
    const oldRuntime = { sourceRevision: s.old, version: '1.0.0' }
    if (existingStamp) writeFileSync(stamp, JSON.stringify(oldRuntime))
    s.id.release = oldRuntime
    const { svc, restarts } = service(s)
    // Python monkeypatched NamedTemporaryFile; here the stamp directory turns read-only right after the build lands.
    const unwritableAfterBuild: BuildRun = async (args, cwd, t) => { const r = await s.build(args, cwd, t); if (args[1] === 'build' && args.includes('packages/server')) chmodSync(join(s.client, 'web'), 0o555); return r }
    try {
      expect((await applyWebUpdate(web(s.client), 'stable', s.run, s.getJson, s.identity, unwritableAfterBuild)).ok).toBe(false)
    } finally {
      chmodSync(join(s.client, 'web'), 0o755)
    }
    expect(git(s.client, 'rev-parse', 'HEAD')).toBe(s.latest)
    expect(readStamp(s.client)).toEqual(existingStamp ? oldRuntime : null)
    if (restarted) { s.id.stamped = oldRuntime; s.id.release = { sourceRevision: null, version: 'development' } }
    let refreshed = (await svc.check(true)).webui as Dict
    expect(refreshed.behind).toBe(0)
    expect(refreshed.metadata_repair).toBe(true)
    expect(refreshed.manual_update).toBeUndefined()
    expect(refreshed.error).toBeUndefined()
    const repaired = await svc.apply('webui', 'stable')
    expect(repaired.ok).toBe(true)
    expect(repaired.restart_scheduled).toBe(true)
    expect(readStamp(s.client)).toEqual(s.release.runtime)
    expect(restarts).toEqual([1])
    s.id.release = s.release.runtime
    expect((await applyWebUpdate(web(s.client), 'stable', s.run, s.getJson, s.identity, s.build)).up_to_date).toBe(true)
    refreshed = (await svc.check(true)).webui as Dict
    expect(refreshed.behind).toBe(0)
    expect(refreshed.metadata_repair).toBe(false)
  })

  it('a current source does not hide a modified stamp', async () => {
    const s = sourceInstall()
    git(s.client, 'reset', '--hard', s.latest)
    const stamp = join(s.client, 'web/_release.json')
    writeFileSync(stamp, '{"version":"unreviewed local metadata"}')
    expect((await applyWebUpdate(web(s.client), 'stable', s.run, s.getJson, s.identity, s.build)).ok).toBe(false)
    const status = await checkWebUpdate(web(s.client), 'web-v2.0.0', 'stable', s.run, s.getJson, s.identity)
    expect(status.behind).toBeNull()
    expect(status.manual_update).toBe(true)
    expect(status.error).toBeTruthy()
    expect(readFileSync(stamp, 'utf8')).toBe('{"version":"unreviewed local metadata"}')
  })

  it('an ahead checkout is manual, not a successful update', async () => {
    const s = sourceInstall()
    git(s.client, 'reset', '--hard', s.latest)
    const stamp = join(s.client, 'web/_release.json')
    const original = JSON.stringify(s.release.runtime)
    writeFileSync(stamp, original)
    s.id.release = s.release.runtime
    writeFileSync(join(s.client, 'web/package.json'), '{"version":"unpublished local change"}\n')
    git(s.client, 'add', '.')
    git(s.client, 'commit', '-m', 'synthetic ahead checkout')
    const head = git(s.client, 'rev-parse', 'HEAD')
    const status = await checkWebUpdate(web(s.client), s.release.tag, 'stable', s.run, s.getJson, s.identity)
    expect(status.manual_update).toBe(true)
    expect(status.behind).toBeNull()
    const result = await applyWebUpdate(web(s.client), 'stable', s.run, s.getJson, s.identity, s.build)
    expect(result.ok).toBe(false)
    expect(result.manual_update).toBe(true)
    expect(result.up_to_date).toBeUndefined()
    expect(git(s.client, 'rev-parse', 'HEAD')).toBe(head)
    expect(readFileSync(stamp, 'utf8')).toBe(original)
  })

  it('the summary cache separates filtered experimental commits and reuses exact ranges', async () => {
    const s = sourceInstall()
    write(join(s.upstream, 'app/client.swift'), '// unrelated App change\n')
    git(s.upstream, 'add', '.')
    git(s.upstream, 'commit', '-m', 'synthetic unrelated App update')
    git(s.client, 'fetch', s.upstream, 'main')
    const latest = git(s.upstream, 'rev-parse', 'HEAD')
    const { svc } = service(s)
    const info = { behind: 1, current_sha: s.old, latest_sha: latest }
    const stable = await svc.summarize({ webui: { ...info, channel: 'stable' } }, null)
    const experimental = await svc.summarize({ webui: { ...info, channel: 'experimental' } }, null)
    expect((stable.targets as Dict[])[0]?.commits).toContain('synthetic unrelated App update')
    expect((experimental.targets as Dict[])[0]?.commits).toEqual(['synthetic published release'])
    expect(stable.cache_key).not.toBe(experimental.cache_key)
    expect(stable.generated_by).toBe('fallback')
    expect(String(stable.summary)).toContain("What you'll notice")
    expect((await svc.summarize({ webui: { ...info, channel: 'stable' } }, null)).cached).toBe(true)
    expect((await svc.summarize({}, null)).summary_sections).toEqual([{ title: "What you'll notice", items: ['Updates are available.'] }])
  })

  it('an LLM summary is split into Notice and Worth knowing sections', async () => {
    const s = sourceInstall()
    const { svc } = service(s, { llm: () => Promise.resolve('- Notice: Sessions load faster\n- Worth knowing: the sidebar was rebuilt\n- Notice: sessions load faster') })
    const result = await svc.summarize({ webui: { behind: 1, current_sha: s.old, latest_sha: s.latest } }, 'webui')
    expect(result.generated_by).toBe('llm')
    expect(result.summary_sections).toEqual([{ title: "What you'll notice", items: ['Sessions load faster.'] }, { title: 'Worth knowing', items: ['The sidebar was rebuilt.'.replace('The', 'the')] }])
  })

  it('refuses to apply while chat work is active and reports the blockers', async () => {
    const s = sourceInstall()
    const { svc, restarts } = service(s, { blockers: () => ({ active_streams: 1, active_runs: 2, blocking_stream_ids: ['st_1'], blocking_run_ids: ['r1', 'r2'], restart_blocked: true }) })
    const blocked = await svc.apply('webui')
    expect(blocked).toMatchObject({ ok: false, restart_blocked: true, active_streams: 1, active_runs: 2, blocking_stream_ids: ['st_1'] })
    expect(String(blocked.message)).toContain('1 active chat stream and 2 active agent runs')
    expect(restarts).toEqual([])
    expect(git(s.client, 'rev-parse', 'HEAD')).toBe(s.old)
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
  function agentInstall(): { agent: string; origin: string; v1: string; v2: string } {
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
    git(origin, 'commit', '-am', 'agent v2')
    git(origin, 'tag', 'v2.0.0')
    const v2 = git(origin, 'rev-parse', 'HEAD')
    return { agent, origin, v1, v2 }
  }

  it('reports the tag gap, fast-forwards with a stash, and restarts the gateway through the sidecar [py:test_issue4356_no_git_update_check.py::test_check_repo_returns_no_git_sentinel_when_path_is_none] [py:test_issue4356_no_git_update_check.py::test_check_repo_still_returns_dict_when_dot_git_exists]', async () => {
    const a = agentInstall()
    expect(await checkAgentUpdate(null, runGit)).toEqual({ name: 'agent', behind: null, no_git: true })
    const status = await checkAgentUpdate(a.agent, runGit)
    expect(status).toMatchObject({ name: 'agent', behind: 1, current_sha: 'v1.0.0', latest_sha: 'v2.0.0', release_based: true, dirty: false, channel: 'stable' })
    writeFileSync(join(a.agent, 'notes.txt'), 'untracked survives\n')
    writeFileSync(join(a.agent, 'README'), 'local note\n')
    const gateway: string[] = []
    const svc = new UpdateService({
      webRoot: join(tmp(), 'web'), getJson: noReleases, identity: { release: () => DEV, stamped: () => DEV, runningSourceRevision: () => null }, webuiVersion: 'x',
      agentDir: () => a.agent, channel: () => 'stable', includeAgent: () => true, blockers: () => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false }),
      scheduleRestart: () => gateway.push('restart'), gatewayRestart: () => { gateway.push('gateway'); return Promise.resolve(gateway.length === 1 ? { status: 'failed', message: 'launchd rotating' } : { status: 'completed' }) }, sleep: () => Promise.resolve(), log: () => undefined,
    })
    const result = await svc.apply('agent')
    expect(result).toMatchObject({ ok: true, target: 'agent', ref: 'v2.0.0', restart_scheduled: true, gateway_restart: 'completed' })
    expect(gateway).toEqual(['gateway', 'gateway', 'restart'])
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v2)
    expect(readFileSync(join(a.agent, 'notes.txt'), 'utf8')).toBe('untracked survives\n')
    expect(readFileSync(join(a.agent, 'README'), 'utf8')).toBe('local note\n') // stash popped back over the update
    expect(readFileSync(join(a.agent, 'VERSION'), 'utf8')).toBe('2.0.0\n')
    expect((await checkAgentUpdate(a.agent, runGit)).behind).toBe(0)
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
    expect((await applyAgentUpdate(a.agent, runGit)).ok).toBe(true) // branch fallthrough: nothing to pull, HEAD keeps its local commit
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
      scheduleRestart: () => undefined, gatewayRestart: () => Promise.resolve({ status: 'completed' }), sleep: () => Promise.resolve(), log: () => undefined,
    })
    const held = await svc.clearLock('agent')
    expect(held).toMatchObject({ ok: false, lock_held: true, manual_command: `rm -f ${join(a.agent, '.git/index.lock')}`, other_locks: ['refs/heads/master.lock'] })
    expect(existsSync(join(a.agent, '.git/index.lock'))).toBe(true)
    rmSync(join(a.agent, '.git/index.lock'))
    rmSync(join(a.agent, '.git/refs/heads/master.lock'))
    expect(inventoryLocks(a.agent)).toEqual({ well_known_lock_present: false, well_known_lock_path: join(a.agent, '.git/index.lock'), other_locks: [] })
    const retried = await svc.clearLock('agent')
    expect(retried).toMatchObject({ ok: true, lock_recovery: { action: 'no-lock-found', other_locks: [] } })
    expect(git(a.agent, 'rev-parse', 'HEAD')).toBe(a.v2)
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
