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
  write(join(root, 'dist/bin/talaria-web.js'), '// fixture')
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

interface Ghcr { artifactType?: string; redirect?: string; served?: Buffer; version?: string; source?: string }
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
    if (url === `https://ghcr.io/v2/maudecode/talaria-web-experimental/blobs/${digest}`) return Promise.resolve(new Response(null, { status: 307, headers: { location: opts.redirect ?? `https://pkg-containers.githubusercontent.com/ghcr1/blobs/${digest}?sig=x` } }))
    if (url.startsWith('https://pkg-containers.githubusercontent.com/') || (opts.redirect && url.startsWith(opts.redirect))) return Promise.resolve(new Response(new Uint8Array(opts.served ?? tarball)))
    return Promise.resolve(new Response('not found', { status: 404 }))
  }) as typeof fetch
  return { registry: ghcrExperimental(fetchImpl), requests, digest }
}

const TARBALL = Buffer.from('synthetic experimental tarball')
const tgzKey = `tgz:${createHash('sha256').update(TARBALL).digest('hex')}`
const unusedRegistry: ExperimentalRegistry = { release: () => { throw new Error('Stable must not query GHCR') }, download: () => { throw new Error('Stable must not download from GHCR') } }

describe('Experimental npm updates (TAL-378)', () => {
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
      scheduleRestart: () => undefined, gatewayRestart: () => Promise.resolve({ status: 'completed' }), log: () => undefined,
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
