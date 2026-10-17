/**
 * npm installs following the GHCR Experimental artifact and switching channels (TAL-343, TAL-378),
 * against a fake GHCR `fetch`, a fake npm, and synthetic global prefixes and state dirs.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// These tests own a synthetic host prefix even when CI itself runs in a container.
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, existsSync: (path: import('node:fs').PathLike) => ['/run/.containerenv', '/.dockerenv', '/.within_container'].includes(String(path)) ? false : fs.existsSync(path) }
})
import type { Dict } from '../config/agent-config.js'
import {
  applyWebUpdate, backupPersistedStores, checkWebUpdate, ghcrExperimental, runGit, UpdateService, type BuildRun, type ExperimentalRegistry, type GetJson, type ReleaseIdentity,
} from './updates.js'

const PIN = { 'x-talaria': { version: '0.0.1', sourceRevision: 'd'.repeat(40) }, services: { 'hermes-agent': { image: `docker.io/nousresearch/hermes-agent@sha256:${'e'.repeat(64)}` } } }
const VERSIONS = { appWeb: { fixtureVersion: 1 }, webRelay: { protocolVersion: 2 } }
const COMPAT = { contracts: { appWeb: [1], webRelay: [2] }, compatibleAgent: { ...PIN['x-talaria'], image: PIN.services['hermes-agent'].image } }
const release = (tag: string, version: string, source: string): Dict => ({ tag, version, sourceRevision: source, releaseSet: source, ...COMPAT })

const STABLE_SOURCE = 'a'.repeat(40)
const OLD_EXP = '1'.repeat(40)
const NEW_EXP = 'b'.repeat(40)
const expVersion = (base: string, source: string): string => `${base}-exp.${source.slice(0, 12)}`
const STABLE = release('web-v2.0.0', '2.0.0', STABLE_SOURCE)
const EXPERIMENTAL = release(`web-exp-v${expVersion('2.0.0', NEW_EXP)}`, expVersion('2.0.0', NEW_EXP), NEW_EXP)

const dirs: string[] = []
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'talaria-exp-updates-')); dirs.push(d); return d }
const write = (path: string, text: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function writePackage(root: string, version: string, stamp: Dict | null): void {
  write(join(root, 'package.json'), JSON.stringify({ name: '@maudecode/talaria-web', version, bin: { 'talaria-web': 'dist/bin/talaria-web.js', 'talaria-web-mcp': 'dist/bin/talaria-web-mcp.js' } }))
  write(join(root, 'sidecar/agent_dependency.json'), JSON.stringify(PIN))
  write(join(root, 'contract_versions.json'), JSON.stringify(VERSIONS))
  write(join(root, 'dist/bin/talaria-web.js'), "process.exit(process.argv[2] === 'self-check' ? 0 : 2)")
  write(join(root, 'dist/bin/talaria-web-mcp.js'), '// fixture')
  if (stamp) write(join(root, '_release.json'), JSON.stringify(stamp))
}

/** A global npm install of `installed`, with a fake npm that installs `candidates[spec]` into the staging prefix. */
function npmInstall(installed: Dict, candidates: Record<string, Dict>) {
  const globalRoot = join(tmp(), 'lib/node_modules')
  const packageRoot = join(globalRoot, '@maudecode/talaria-web')
  writePackage(packageRoot, String(installed.version), installed)
  const installs: string[] = []
  const npm: BuildRun = (args) => {
    if (args[0] === 'root') return Promise.resolve({ ok: true, out: globalRoot })
    if (args[0] !== 'install') return Promise.resolve({ ok: false, out: 'unexpected npm command' })
    const spec = args.at(-1)!
    installs.push(spec)
    const key = spec.endsWith('.tgz') ? `tgz:${createHash('sha256').update(readFileSync(spec)).digest('hex')}` : spec
    const candidate = candidates[key]
    if (!candidate) return Promise.resolve({ ok: false, out: `no fixture for ${spec}` })
    writePackage(join(args[args.indexOf('--prefix') + 1]!, 'lib/node_modules/@maudecode/talaria-web'), String(candidate.version), candidate)
    return Promise.resolve({ ok: true, out: '' })
  }
  const version = (): string => (JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string }).version
  return { packageRoot, npm, installs, version }
}

const identity = (running: Dict): ReleaseIdentity => ({ release: () => running, stamped: () => running, runningSourceRevision: () => null })

const stableGetJson: GetJson = (_path, { asset }) => Promise.resolve(asset ? {
  schemaVersion: 1, status: 'complete', releaseSet: STABLE_SOURCE,
  components: { web: { ...STABLE, npm: '@maudecode/talaria-web@2.0.0', image: `ghcr.io/maudecode/talaria-web@sha256:${'f'.repeat(64)}` } },
  contracts: { appWeb: { web: [1] }, webRelay: { web: [2] } }, agent: COMPAT.compatibleAgent,
} : [{ tag_name: `release-set-${STABLE_SOURCE}`, published_at: '2026-01-01', assets: [{ name: 'release-set.json', id: 1 }] }])

interface HistoryCommit { sha: string; message: string; date: string; web?: boolean }
const commitJson = (c: HistoryCommit): Dict => ({ sha: c.sha, commit: { message: c.message, author: { date: c.date }, committer: { date: c.date } } })
/**
 * GitHub over one synthetic main, newest ancestor first. Compare follows ancestry; `/commits?path=web`
 * filters `since` by each commit's own date and orders by date, so a commit can sit above another in
 * history while being dated before it. Other paths fall through to `fallback`.
 */
function githubHistory(main: HistoryCommit[], fallback: GetJson = stableGetJson): GetJson {
  const at = (sha: string | null): number => main.findIndex((c) => c.sha === sha)
  return (path, opts) => {
    const url = new URL(path, 'https://api.invalid')
    const page = Number(url.searchParams.get('page'))
    const per = Number(url.searchParams.get('per_page'))
    const compare = /^\/compare\/(\w{40})\.\.\.(\w{40})$/.exec(url.pathname)
    if (compare && !url.search) return Promise.resolve({ status: at(compare[2]!) <= at(compare[1]!) ? 'ahead' : 'diverged' })
    if (compare) {
      const range = main.slice(at(compare[2]!), at(compare[1]!)).reverse()
      return Promise.resolve({ status: 'ahead', total_commits: range.length, commits: range.slice((page - 1) * per, page * per).map(commitJson) })
    }
    if (url.pathname === '/commits' && url.searchParams.get('path') === 'web') {
      const since = url.searchParams.get('since') ?? ''
      const listed = main.slice(at(url.searchParams.get('sha'))).filter((c) => c.web !== false && c.date >= since).sort((a, b) => b.date.localeCompare(a.date))
      return Promise.resolve(listed.slice((page - 1) * per, page * per).map(commitJson))
    }
    const commit = /^\/commits\/(\w{40})$/.exec(url.pathname)
    if (commit && at(commit[1]!) >= 0) return Promise.resolve(commitJson(main[at(commit[1]!)]!))
    return fallback(path, opts)
  }
}

interface Ghcr { artifactType?: string; redirect?: string; served?: Buffer; version?: string; source?: string; tags?: string[] }
/** A fake GHCR speaking the token, manifest, and redirected-blob protocol for one `experimental` artifact. */
function fakeGhcr(tarball: Buffer, opts: Ghcr = {}) {
  const digest = `sha256:${createHash('sha256').update(tarball).digest('hex')}`
  const requests: { url: string; auth: string | null }[] = []
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const auth = new Headers(init?.headers).get('authorization')
    requests.push({ url, auth })
    if (url === 'https://ghcr.io/token?scope=repository:maudecode/talaria-web-experimental:pull') return Promise.resolve(Response.json({ token: 'anonymous-pull' }))
    if (url === 'https://ghcr.io/v2/maudecode/talaria-web-experimental/manifests/experimental') {
      return Promise.resolve(Response.json({
        schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', artifactType: opts.artifactType ?? 'application/vnd.maudecode.talaria-web.experimental.v1',
        config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: `sha256:${'4'.repeat(64)}`, size: 2 },
        layers: [{ mediaType: 'application/vnd.maudecode.talaria-web.npm.tgz', digest, size: tarball.length }],
        annotations: { 'org.opencontainers.image.revision': opts.source ?? NEW_EXP, 'org.opencontainers.image.version': opts.version ?? EXPERIMENTAL.version },
      }))
    }
    if (url === 'https://ghcr.io/v2/maudecode/talaria-web-experimental/tags/list?n=1000') return Promise.resolve(Response.json({ name: 'maudecode/talaria-web-experimental', tags: opts.tags ?? ['experimental', `sha-${NEW_EXP}`] }))
    if (url === `https://ghcr.io/v2/maudecode/talaria-web-experimental/blobs/${digest}`) return Promise.resolve(new Response(null, { status: 307, headers: { location: opts.redirect ?? `https://pkg-containers.githubusercontent.com/ghcr1/blobs/${digest}?sig=x` } }))
    if (url.startsWith('https://pkg-containers.githubusercontent.com/') || (opts.redirect && url.startsWith(opts.redirect))) return Promise.resolve(new Response(new Uint8Array(opts.served ?? tarball)))
    return Promise.resolve(new Response('not found', { status: 404 }))
  }) as typeof fetch
  return { registry: ghcrExperimental(fetchImpl), requests, digest }
}

const TARBALL = Buffer.from('synthetic experimental tarball')
const tgzKey = `tgz:${createHash('sha256').update(TARBALL).digest('hex')}`
const unusedRegistry: ExperimentalRegistry = { release: () => { throw new Error('Stable must not query GHCR') }, download: () => { throw new Error('Stable must not download from GHCR') }, builds: () => { throw new Error('Stable must not query GHCR') } }

describe('Experimental npm updates (TAL-378)', () => {
  it('counts the published Experimental builds an install is behind (TAL-626)', async () => {
    const [mid, early, untagged] = ['d', 'e', 'f'].map((c) => c.repeat(40))
    // main from the newest build back: two more builds and a commit that published no build sit between OLD_EXP and NEW_EXP.
    const history = [NEW_EXP, untagged, mid, early, OLD_EXP, 'c'.repeat(40)]
    const g = fakeGhcr(TARBALL, { tags: ['experimental', ...[NEW_EXP, mid, early, OLD_EXP].map((sha) => `sha-${sha}`)] })
    const getJson: GetJson = (path, opts) => path === `/commits?sha=${NEW_EXP}&per_page=100&page=1` ? Promise.resolve(history.map((sha) => ({ sha }))) : stableGetJson(path, opts)
    const running = release(`web-exp-v${expVersion('2.0.0', OLD_EXP)}`, expVersion('2.0.0', OLD_EXP), OLD_EXP)
    const behind = npmInstall(running, {})
    expect(await checkWebUpdate(behind.packageRoot, 'web-exp', 'experimental', runGit, getJson, identity(running), behind.npm, g.registry)).toMatchObject({ behind: 3, install_kind: 'npm' })
    const stable = release('web-v2.0.0', '2.0.0', 'c'.repeat(40))
    const switching = npmInstall(stable, {})
    expect(await checkWebUpdate(switching.packageRoot, 'web-v2.0.0', 'experimental', runGit, getJson, identity(stable), switching.npm, g.registry)).toMatchObject({ behind: 4, channel_switch: true })
  })

  it('summarizes an Experimental update from the Web commits it installs (TAL-759)', async () => {
    const running = release(`web-exp-v${expVersion('2.0.0', OLD_EXP)}`, expVersion('2.0.0', OLD_EXP), OLD_EXP)
    const n = npmInstall(running, {})
    const g = fakeGhcr(TARBALL)
    const paths: string[] = []
    const history = githubHistory([
      { sha: NEW_EXP, message: 'TAL-1: Chats open faster\n\nBody text', date: '2026-10-02T00:00:00Z' },
      { sha: OLD_EXP, message: 'installed', date: '2026-10-01T00:00:00Z' },
    ])
    const getJson: GetJson = (path, opts) => { paths.push(path); return history(path, opts) }
    const prompts: string[] = []
    const svc = new UpdateService({
      webRoot: n.packageRoot, git: runGit, npm: n.npm, getJson, experimental: g.registry, identity: identity(running), webuiVersion: 'web-exp',
      agentDir: () => null, channel: () => 'experimental', includeAgent: () => false,
      blockers: () => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false }),
      scheduleRestart: () => undefined, llm: (_system, user) => { prompts.push(user); return Promise.resolve('- Notice: Chats open faster') }, log: () => undefined,
    })
    await svc.check(true, false, 'experimental')
    expect(await svc.summarize('webui')).toMatchObject({ source: 'commits', generated_by: 'llm' })
    expect(prompts[0]).toContain('- TAL-1: Chats open faster')
    expect(prompts[0]).not.toContain('installed')
    expect(paths).toContain(`/compare/${OLD_EXP}...${NEW_EXP}?per_page=100&page=1`)
    expect(paths).toContain(`/commits?sha=${NEW_EXP}&path=web&since=${encodeURIComponent('2026-10-02T00:00:00.000Z')}&per_page=100&page=1`)
  })

  it('summarizes pending Web commits dated before the installed build, and only those (TAL-1105)', async () => {
    const running = release(`web-exp-v${expVersion('2.0.0', OLD_EXP)}`, expVersion('2.0.0', OLD_EXP), OLD_EXP)
    const n = npmInstall(running, {})
    // A PR branched before the installed build and merged after it: its commits are pending but dated earlier.
    const getJson = githubHistory([
      { sha: NEW_EXP, message: 'Merge pull request #2 from MaudeCode/fix/TAL-2-branch', date: '2026-10-17T15:00:00Z' },
      { sha: 'c'.repeat(40), message: 'TAL-3: Relay pairing retries', date: '2026-10-17T14:55:00Z', web: false },
      { sha: 'd'.repeat(40), message: 'TAL-2: Dashboards sign in with the owning profile', date: '2026-10-17T14:26:00Z' },
      { sha: OLD_EXP, message: 'Merge pull request #1 from MaudeCode/fix/TAL-1-branch', date: '2026-10-17T14:50:00Z' },
      { sha: 'e'.repeat(40), message: 'TAL-1: Already installed change', date: '2026-10-17T14:30:00Z' },
    ])
    const prompts: string[] = []
    const svc = new UpdateService({
      webRoot: n.packageRoot, git: runGit, npm: n.npm, getJson, experimental: fakeGhcr(TARBALL).registry, identity: identity(running), webuiVersion: 'web-exp',
      agentDir: () => null, channel: () => 'experimental', includeAgent: () => false,
      blockers: () => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false }),
      scheduleRestart: () => undefined, llm: (_system, user) => { prompts.push(user); return Promise.resolve('- Notice: Dashboards sign in') }, log: () => undefined,
    })
    await svc.check(true, false, 'experimental')
    expect(await svc.summarize('webui')).toMatchObject({ source: 'commits', generated_by: 'llm' })
    expect(prompts[0]).toContain('- TAL-2: Dashboards sign in with the owning profile\n- Merge pull request #2')
    expect(prompts[0]).not.toContain('Relay pairing')
    expect(prompts[0]).not.toContain('Already installed')
  })

  it('reads every compare and Web commit page, appends from the prior SHA, and keeps its list on a failed page (TAL-1009)', async () => {
    const running = release(`web-exp-v${expVersion('2.0.0', OLD_EXP)}`, expVersion('2.0.0', OLD_EXP), OLD_EXP)
    const n = npmInstall(running, {})
    const stateDir = tmp()
    let latest = NEW_EXP
    const next = 'c'.repeat(40)
    let fail = false
    const paths: string[] = []
    const prompts: string[] = []
    const old = Array.from({ length: 120 }, (_, i) => ({ sha: (i + 1).toString(16).padStart(40, '0'), message: `Web change ${String(i)}` }))
    const additions = [next, 'd'.repeat(40), 'e'.repeat(40)].map((sha, i) => ({ sha, message: `New Web change ${String(i)}` }))
    const main = [...additions, { sha: NEW_EXP, message: 'Web latest change' }, ...old, { sha: OLD_EXP, message: 'installed' }]
    const history = githubHistory(main.map((c, i) => ({ ...c, date: new Date(Date.UTC(2026, 9, 1) + (main.length - i) * 60_000).toISOString() })))
    const getJson: GetJson = (path, opts) => {
      paths.push(path)
      return fail && path.endsWith('page=2') ? Promise.reject(new Error('page unavailable')) : history(path, opts)
    }
    const experimental: ExperimentalRegistry = {
      release: () => Promise.resolve({ tag: `web-exp-v${expVersion('2.0.0', latest)}`, version: expVersion('2.0.0', latest), sourceRevision: latest, digest: `sha256:${'f'.repeat(64)}`, size: 1 }),
      builds: () => Promise.resolve(new Set([NEW_EXP, next])), download: () => Promise.reject(new Error('never install')),
    }
    const svc = new UpdateService({
      webRoot: n.packageRoot, git: runGit, npm: n.npm, getJson, experimental, identity: identity(running), webuiVersion: 'web-exp', stateDir, summarizeAutomatically: () => false,
      agentDir: () => null, channel: () => 'experimental', includeAgent: () => false,
      blockers: () => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false }),
      scheduleRestart: () => undefined, llm: (_system, user) => { prompts.push(user); return Promise.resolve('- Notice: Earlier Web changes') }, log: () => undefined,
    })
    fail = true
    await svc.check(true)
    expect(await svc.summarize('webui')).toMatchObject({ generated_by: 'fallback' })
    expect(existsSync(join(stateDir, 'update-summaries.json'))).toBe(false)
    fail = false
    await svc.check(true)
    expect(await svc.summarize('webui')).toMatchObject({ generated_by: 'llm' })
    for (const commit of old) expect(prompts.join('\n')).toContain(`- ${commit.message}\n`)
    expect(prompts).toHaveLength(2)
    expect(paths.some((path) => path.includes('path=web') && path.endsWith('page=2'))).toBe(true)
    const checkpoint = readFileSync(join(stateDir, 'update-summaries.json'), 'utf8')
    latest = next
    paths.length = 0
    await svc.check(true)
    await svc.summarize('webui')
    expect(prompts).toHaveLength(3)
    expect(prompts[2]).toContain('Earlier Web changes')
    expect(prompts[2]).not.toContain('- Web change')
    for (const commit of additions) expect(prompts[2]).toContain(`- ${commit.message}\n`)
    expect(paths.filter((path) => path.includes('path=web'))).toHaveLength(1)
    expect(paths).toContain(`/compare/${NEW_EXP}...${next}`)
    expect(readFileSync(join(stateDir, 'update-summaries.json'), 'utf8')).not.toBe(checkpoint)
  })

  it('reports an Experimental npm install current at the tag revision and behind otherwise', async () => {
    const running = release(`web-exp-v${expVersion('2.0.0', OLD_EXP)}`, expVersion('2.0.0', OLD_EXP), OLD_EXP)
    const behind = npmInstall(running, {})
    const g = fakeGhcr(TARBALL)
    expect(await checkWebUpdate(behind.packageRoot, 'web-exp', 'experimental', runGit, stableGetJson, identity(running), behind.npm, g.registry))
      .toMatchObject({ behind: 1, install_kind: 'npm', manual_update: false, current_sha: OLD_EXP, latest_sha: NEW_EXP, latest_version: EXPERIMENTAL.tag })
    const current = npmInstall(EXPERIMENTAL, {})
    const status = await checkWebUpdate(current.packageRoot, 'web-exp', 'experimental', runGit, stableGetJson, identity(EXPERIMENTAL), current.npm, g.registry)
    expect(status).toMatchObject({ behind: 0, metadata_repair: false, manual_update: false })
    expect(status.channel_switch).toBeUndefined()
    // The pull token goes to GHCR only, never to the blob host.
    expect(g.requests.every((r) => r.url.startsWith('https://ghcr.io/'))).toBe(true)
  })

  it('updates an Experimental npm install from the verified tarball without a backup', async () => {
    const running = release(`web-exp-v${expVersion('2.0.0', OLD_EXP)}`, expVersion('2.0.0', OLD_EXP), OLD_EXP)
    const n = npmInstall(running, { [tgzKey]: EXPERIMENTAL })
    const g = fakeGhcr(TARBALL)
    const state = tmp()
    const result = await applyWebUpdate(n.packageRoot, 'experimental', runGit, stableGetJson, identity(running), n.npm, () => true, { registry: g.registry, stateDir: state })
    expect(result).toMatchObject({ ok: true, sourceRevision: NEW_EXP })
    expect(result.channel_switch).toBeUndefined()
    expect(n.version()).toBe(EXPERIMENTAL.version)
    expect(existsSync(join(state, 'backups'))).toBe(false)
    const blob = g.requests.find((r) => r.url.startsWith('https://pkg-containers.githubusercontent.com/'))
    expect(blob?.auth).toBeNull()
  })

  it.each([
    ['a digest mismatch', { served: Buffer.from('synthetic experimental tarbalL') }, 'digest'],
    ['a wrong artifactType', { artifactType: 'application/vnd.example.other' }, 'unexpected format'],
    ['a redirect to another host', { redirect: 'https://attacker.example/blob' }, 'redirect'],
    ['a version that does not name its revision', { version: expVersion('2.0.0', OLD_EXP) }, 'provenance'],
  ] as const)('rejects %s and preserves the installed package', async (_label, opts, message) => {
    const running = release('web-v1.0.0', '1.0.0', 'c'.repeat(40))
    const n = npmInstall(running, { [tgzKey]: EXPERIMENTAL })
    const g = fakeGhcr(TARBALL, opts)
    const result = await applyWebUpdate(n.packageRoot, 'experimental', runGit, stableGetJson, identity(running), n.npm, () => true, { registry: g.registry, stateDir: tmp() })
    expect(result.ok).toBe(false)
    expect(String(result.message)).toContain(message)
    expect(n.installs).toEqual([])
    expect(n.version()).toBe('1.0.0')
    expect(g.requests.some((r) => r.url.startsWith('https://attacker.example') && r.auth !== null)).toBe(false)
  })

  it('rejects an installed package whose _release.json disagrees with the annotations', async () => {
    const running = release(`web-exp-v${expVersion('2.0.0', OLD_EXP)}`, expVersion('2.0.0', OLD_EXP), OLD_EXP)
    const n = npmInstall(running, { [tgzKey]: { ...EXPERIMENTAL, sourceRevision: 'c'.repeat(40), releaseSet: 'c'.repeat(40) } })
    const result = await applyWebUpdate(n.packageRoot, 'experimental', runGit, stableGetJson, identity(running), n.npm, () => true, { registry: fakeGhcr(TARBALL).registry, stateDir: tmp() })
    expect(result).toMatchObject({ ok: false, verification_failed: true })
    expect(n.installs).toHaveLength(1)
    expect(n.version()).toBe(running.version)
  })

  it('switches Stable to Experimental, backing up the persisted stores first', async () => {
    const running = release('web-v3.0.0', '3.0.0', 'c'.repeat(40))
    const n = npmInstall(running, { [tgzKey]: EXPERIMENTAL })
    const g = fakeGhcr(TARBALL)
    const state = tmp()
    write(join(state, 'settings.json'), '{"update_channel":"experimental"}')
    write(join(state, 'projects.json'), '{"projects":[]}')
    expect(await checkWebUpdate(n.packageRoot, 'web-v3.0.0', 'experimental', runGit, stableGetJson, identity(running), n.npm, g.registry))
      .toMatchObject({ behind: 1, channel_switch: true, manual_update: false, install_kind: 'npm' })
    const result = await applyWebUpdate(n.packageRoot, 'experimental', runGit, stableGetJson, identity(running), n.npm, () => true, { registry: g.registry, stateDir: state })
    // Experimental 2.0.0-exp replaces Stable 3.0.0: a switch ignores version order.
    expect(result).toMatchObject({ ok: true, channel_switch: true, sourceRevision: NEW_EXP })
    expect(n.version()).toBe(EXPERIMENTAL.version)
    const backup = String(result.backup_dir)
    expect(backup).toMatch(/backups\/channel-switch-\d{4}-\d{2}-\d{2}T/)
    expect(readFileSync(join(backup, 'settings.json'), 'utf8')).toBe('{"update_channel":"experimental"}')
    expect(readFileSync(join(backup, 'projects.json'), 'utf8')).toBe('{"projects":[]}')
  })

  it('summarizes a switch back to Stable from that Stable release\'s notes (TAL-759)', async () => {
    const running = release(`web-exp-v${expVersion('3.0.0', OLD_EXP)}`, expVersion('3.0.0', OLD_EXP), OLD_EXP)
    const n = npmInstall(running, {})
    const getJson: GetJson = async (path, opts) => (opts.asset ? stableGetJson(path, opts) : [{ tag_name: 'web-v2.0.0', published_at: '2026-01-01', assets: [], body: 'Stable 2.0.0 notes' }, ...(await stableGetJson(path, opts) as Dict[])])
    const prompts: string[] = []
    const svc = new UpdateService({
      webRoot: n.packageRoot, git: runGit, npm: n.npm, getJson, experimental: unusedRegistry, identity: identity(running), webuiVersion: 'web-exp',
      agentDir: () => null, channel: () => 'stable', includeAgent: () => false,
      blockers: () => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false }),
      scheduleRestart: () => undefined, llm: (_system, user) => { prompts.push(user); return Promise.resolve('- Notice: Stable again') }, log: () => undefined,
    })
    expect((await svc.check(true, false, 'stable')).webui).toMatchObject({ channel_switch: true, behind: 1 })
    expect(await svc.summarize('webui')).toMatchObject({ source: 'release_notes', target_version: 'web-v2.0.0' })
    expect(prompts[0]).toContain('<release tag="web-v2.0.0">\nStable 2.0.0 notes\n</release>')
  })

  it('switches Experimental to Stable even when Stable has an older version', async () => {
    const running = release(`web-exp-v${expVersion('3.0.0', OLD_EXP)}`, expVersion('3.0.0', OLD_EXP), OLD_EXP)
    const n = npmInstall(running, { '@maudecode/talaria-web@2.0.0': STABLE })
    const state = tmp()
    expect(await checkWebUpdate(n.packageRoot, 'web-exp', 'stable', runGit, stableGetJson, identity(running), n.npm, unusedRegistry))
      .toMatchObject({ behind: 1, channel_switch: true, manual_update: false, npm: '@maudecode/talaria-web@2.0.0' })
    const result = await applyWebUpdate(n.packageRoot, 'stable', runGit, stableGetJson, identity(running), n.npm, () => true, { registry: unusedRegistry, stateDir: state })
    expect(result).toMatchObject({ ok: true, channel_switch: true, npm: '@maudecode/talaria-web@2.0.0' })
    expect(n.installs).toEqual(['@maudecode/talaria-web@2.0.0'])
    expect(n.version()).toBe('2.0.0')
    expect(readdirSync(join(state, 'backups'))).toHaveLength(1)
  })

  it('aborts a channel switch when the backup fails, without touching the installed package', async () => {
    const running = release('web-v1.0.0', '1.0.0', 'c'.repeat(40))
    const n = npmInstall(running, { [tgzKey]: EXPERIMENTAL })
    const state = join(tmp(), 'state-is-a-file')
    write(state, 'not a directory')
    const result = await applyWebUpdate(n.packageRoot, 'experimental', runGit, stableGetJson, identity(running), n.npm, () => true, { registry: fakeGhcr(TARBALL).registry, stateDir: state })
    expect(result).toMatchObject({ ok: false, backup_failed: true })
    expect(n.version()).toBe('1.0.0')
  })

  it('keeps the newest five channel-switch backups', () => {
    const state = tmp()
    write(join(state, 'settings.json'), '{}')
    const made = [0, 1, 2, 3, 4, 5, 6].map((minute) => backupPersistedStores(state, new Date(Date.UTC(2026, 8, 27, 12, minute))))
    expect(readdirSync(join(state, 'backups')).sort()).toEqual(made.slice(2).map((path) => path.split('/').pop()))
    expect(existsSync(join(made[6]!, 'settings.json'))).toBe(true)
    expect(existsSync(join(made[6]!, 'workspaces.json'))).toBe(false)
    // A failed copy leaves no partial backup to count toward (or survive) the retention limit.
    mkdirSync(join(state, 'workspaces.json'))
    expect(() => backupPersistedStores(state, new Date(Date.UTC(2026, 8, 27, 13)))).toThrow()
    expect(readdirSync(join(state, 'backups')).sort()).toEqual(made.slice(2).map((path) => path.split('/').pop()))
  })

  it('leaves Stable-to-Stable npm updates on the release-set path', async () => {
    const running = release('web-v1.0.0', '1.0.0', 'c'.repeat(40))
    const n = npmInstall(running, { '@maudecode/talaria-web@2.0.0': STABLE })
    const state = tmp()
    const svc = new UpdateService({
      webRoot: n.packageRoot, npm: n.npm, getJson: stableGetJson, experimental: unusedRegistry, stateDir: state, identity: identity(running), webuiVersion: 'web-v1.0.0',
      agentDir: () => null, channel: () => 'stable', includeAgent: () => false,
      blockers: () => ({ active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false }),
      scheduleRestart: () => undefined, log: () => undefined,
    })
    const status = (await svc.check(true, false, 'stable')).webui as Dict
    expect(status).toMatchObject({ behind: 1, install_kind: 'npm', manual_update: false })
    expect(status.channel_switch).toBeUndefined()
    const result = await svc.apply('webui', 'stable')
    expect(result).toMatchObject({ ok: true, message: 'Updated Talaria Web to npm release 2.0.0.' })
    expect(result.channel_switch).toBeUndefined()
    expect(n.version()).toBe('2.0.0')
    expect(existsSync(join(state, 'backups'))).toBe(false)
  })
})
