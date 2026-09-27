/**
 * Self-update (Python `api/updates.py` + `api/talaria_releases.py`, ticket §13).
 *
 * Web: a recognized clean Talaria checkout fast-forwards to the newest completed
 * release set (stable) or `origin/main` (experimental) and stamps `web/_release.json`
 * from immutable git blobs. Direct global npm installs can replace themselves
 * with an exact completed Stable package or the verified GHCR Experimental artifact, switching
 * channels in either direction; other packaged installs stay manual.
 * Agent: the external checkout follows its own `v*` tags with a
 * stash/pull or force reset, then the gateway restarts through the sidecar.
 * Nothing here deletes git locks; `clearLock` only inventories them.
 */
import { readCapped } from '../http/capped.js'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Dict } from '../config/agent-config.js'
import { dict } from '../config/agent-config.js'
import { validateReleaseInfo } from '../release.js'
import { str } from '../util.js'

export const REPOSITORY = 'MaudeCode/talaria'
export const REPOSITORY_URL = `https://github.com/${REPOSITORY}`
export const API_ROOT = `https://api.github.com/repos/${REPOSITORY}`
/** Anchored paths work from both the git root and Web's nested working directory. */
export const WEB_UPDATE_PATHS = [':(top)web/', ':(top)contracts/']
/** Relative to the git root: the release stamp and the blobs it is verified against. */
export const RELEASE_STAMP = 'web/_release.json'
const RELEASE_BLOBS = ['sidecar/agent_dependency.json', 'contract_versions.json']
export const CACHE_TTL_S = 1800
export const AUTO_UPDATE_INTERVAL_MS = 5 * 60_000
export const RESTART_MAX_WAIT_S = 300
export const DEFAULT_CHANNEL = 'stable'
export type Channel = 'stable' | 'experimental'

const SHA = /^[a-f0-9]{40}$/
const VERSION = '(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)'
const AGENT_TAG_GLOB = 'v*'
const WEB_NPM_PACKAGE = '@maudecode/talaria-web'
const GIT_LOCK_SIGNATURES = ["index.lock': file exists", ".lock': file exists", 'another git process seems to be running', 'unable to create .git/index.lock']
const NETWORK_FAILURES = ['could not resolve host', 'failed to connect', 'network is unreachable', 'no route to host', 'connection timed out', 'timed out after', 'connection reset by peer', 'remote end hung up unexpectedly', 'tls connection was non-properly terminated', 'ssl certificate problem']

export const normalizeChannel = (channel: unknown): Channel => (channel === 'experimental' ? 'experimental' : 'stable')

// ── git ──────────────────────────────────────────────────────────────────────

export interface GitOutcome { out: string; ok: boolean }
export type GitRun = (args: string[], cwd: string, timeoutMs?: number) => Promise<GitOutcome>

/** Python `_run_git`: stdout on success, else stderr/stdout/a status line, never a throw. */
export const runGit: GitRun = (args, cwd, timeoutMs = 10_000) =>
  new Promise((done) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
      const out = stdout.trim()
      const err = stderr.trim()
      if (!error) { done({ out, ok: true }); return }
      const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string }
      if (e.code === 'ENOENT') { done({ out: 'git executable not found', ok: false }); return }
      if (e.killed) { done({ out: err || `git ${args.join(' ')} timed out after ${String(timeoutMs / 1000)}s`, ok: false }); return }
      done({ out: err || out || `git exited with status ${String(e.code)}`, ok: false })
    })
  })

/** Runs one `npm` command in `cwd`; same outcome shape as `GitRun`. */
export type BuildRun = (args: string[], cwd: string, timeoutMs: number) => Promise<GitOutcome>

/** The steps a source checkout needs after its files change (README "From a source checkout"), run from `<root>/web`. */
export const WEB_BUILD_STEPS: readonly string[][] = [
  ['ci', '--workspace', 'packages/contracts', '--workspace', 'packages/server', '--include=dev'],
  ['run', 'build', '--workspace', 'packages/contracts'],
  ['run', 'build', '--workspace', 'packages/server'],
]
export const WEB_BUILD_TIMEOUT_MS = 10 * 60_000
/** The artifact the supervisor re-executes; a build that does not leave it behind did not succeed. */
export const WEB_SERVER_ENTRY = 'packages/server/dist/bin/talaria-web.js'

const runNpmCommand = (args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<GitOutcome> =>
  new Promise((done) => {
    // Prefer the npm beside the running node so a supervisor started with an absolute node path still finds it.
    const beside = join(dirname(process.execPath), 'npm')
    const cli = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')
    execFile(existsSync(cli) ? process.execPath : existsSync(beside) ? beside : 'npm', existsSync(cli) ? [cli, ...args] : args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...env, PATH: `${dirname(process.execPath)}${delimiter}${env.PATH ?? ''}` } }, (error, stdout, stderr) => {
      if (!error) { done({ out: stdout.trim(), ok: true }); return }
      const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string }
      if (e.code === 'ENOENT') { done({ out: 'npm executable not found', ok: false }); return }
      if (e.killed) { done({ out: `npm ${args.join(' ')} timed out after ${String(timeoutMs / 1000)}s`, ok: false }); return }
      done({ out: (stderr.trim() || stdout.trim() || `npm exited with status ${String(e.code)}`).slice(-4000), ok: false })
    })
  })

export const runNpm: BuildRun = (args, cwd, timeoutMs) => runNpmCommand(args, cwd, timeoutMs, { ...process.env, NODE_ENV: 'development' })
export const runPackageNpm: BuildRun = (args, cwd, timeoutMs) => runNpmCommand(args, cwd, timeoutMs, process.env)

/** Install and build the checkout's Web packages; null on success, else the message for the caller. */
async function buildWeb(root: string, build: BuildRun): Promise<string | null> {
  const cwd = join(root, 'web')
  for (const step of WEB_BUILD_STEPS) {
    const result = await build(step, cwd, WEB_BUILD_TIMEOUT_MS)
    if (!result.ok) return `\`npm ${step.join(' ')}\` failed: ${result.out || 'unknown error'}`
  }
  if (!existsSync(join(cwd, WEB_SERVER_ENTRY))) return `build finished without producing ${WEB_SERVER_ENTRY}`
  return null
}

export const isGitLockError = (output: string): boolean => { const l = output.toLowerCase(); return GIT_LOCK_SIGNATURES.some((s) => l.includes(s)) }

/** Python `_sanitize_git_diagnostic`: strip URL userinfo, GitHub token shapes, and secret query values. */
export function sanitizeGitDiagnostic(output: string, limit = 300): string {
  let s = output.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@\s'"]+)@/g, '$1<redacted>@')
  s = s.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '<redacted>')
  s = s.replace(/([?&](?:access_token|oauth_token|private_token|client_secret|app_secret|api[_-]?key|token|password|secret|auth|key)=)[^&\s'"]+/gi, '$1<redacted>').trim()
  return s.length > limit ? `${s.slice(0, limit).trimEnd()}…` : s
}

function fetchFailureMessage(out: string, network: string): string {
  const detail = sanitizeGitDiagnostic(out)
  if (!detail) return network
  const lower = detail.toLowerCase()
  return NETWORK_FAILURES.some((s) => lower.includes(s)) ? network : `fetch failed: ${detail}`
}

/** One delayed retry absorbs a transient network blip; a lock conflict is not transient. */
export const FETCH_RETRY_MS = 1000
async function fetchWithRetry(git: GitRun, args: string[], cwd: string, timeoutMs: number): Promise<GitOutcome> {
  const first = await git(args, cwd, timeoutMs)
  if (first.ok || isGitLockError(first.out)) return first
  await new Promise((r) => setTimeout(r, FETCH_RETRY_MS))
  return git(args, cwd, timeoutMs)
}

function gitFailure(out: string, message: string): Dict {
  if (isGitLockError(out)) return { ok: false, lock_conflict: true, message: 'Web update is blocked by a repository lock. Wait for the other Git operation or inspect the checkout manually.' }
  return { ok: false, message }
}

function normalizeRemoteUrl(remote: string): string {
  let url = remote.trim()
  if (!url) return url
  if (url.startsWith('git@')) url = url.replace(':', '/').replace('git@', 'https://')
  url = url.replace(/\/+$/, '')
  if (url.endsWith('.git')) url = url.slice(0, -4)
  return url.replace(/\/+$/, '')
}

function compareUrl(repoUrl: string, current: string | null, latest: string | null): string | null {
  if (!repoUrl || !current || !latest) return null
  try { const u = new URL(repoUrl); if (u.protocol !== 'http:' && u.protocol !== 'https:') return null } catch { return null }
  return `${repoUrl}/compare/${current}...${latest}`
}

const canon = (value: unknown): string => JSON.stringify(sortKeys(value))
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as Dict).sort().map((k) => [k, sortKeys((value as Dict)[k])]))
  return value
}
const same = (a: unknown, b: unknown): boolean => canon(a) === canon(b)

// ── published release sets ───────────────────────────────────────────────────

/** `transient`: GitHub was unreachable, slow, or overloaded, so a retry can succeed; the rest describe published state. */
export class ReleaseUnavailable extends Error {
  constructor(message: string, readonly transient = false) { super(message) }
}

export type GetJson = (path: string, opts: { asset: boolean }) => Promise<unknown>

/** GitHub API client: opt-in `TALARIA_RELEASE_TOKEN`, 2 MB cap, and asset redirects only to GitHub's release host with the token stripped. */
export function githubJson(fetchImpl: typeof fetch, env: Record<string, string | undefined>): GetJson {
  return async (path, { asset }) => {
    const headers: Record<string, string> = { Accept: asset ? 'application/octet-stream' : 'application/vnd.github+json', 'User-Agent': 'Talaria-Web', 'X-GitHub-Api-Version': '2026-03-10' }
    const token = (env.TALARIA_RELEASE_TOKEN ?? '').trim()
    if (token) headers.Authorization = `Bearer ${token}`
    const send = async (url: string, init: RequestInit): Promise<Response> => {
      try { return await fetchImpl(url, init) } catch (error) { throw new ReleaseUnavailable(`GitHub is unreachable: ${(error as Error).message}`, true) }
    }
    let res = await send(API_ROOT + path, { headers, redirect: 'manual', signal: AbortSignal.timeout(5000) })
    if (res.status >= 300 && res.status < 400) {
      const target = new URL(res.headers.get('location') ?? '', API_ROOT + path)
      if (target.protocol !== 'https:' || target.hostname !== 'release-assets.githubusercontent.com') throw new ReleaseUnavailable('Unexpected release download redirect')
      const anonymous = { ...headers }
      delete anonymous.Authorization
      res = await send(target.toString(), { headers: anonymous, signal: AbortSignal.timeout(5000) })
    }
    if (!res.ok) throw new ReleaseUnavailable(`GitHub answered ${String(res.status)}`, res.status >= 500 || res.status === 429)
    const body = await readCapped(res, 2_000_000)
    if (!body) throw new ReleaseUnavailable('Release metadata exceeds the download limit')
    return JSON.parse(body.toString('utf8')) as unknown
  }
}

export interface PublishedRelease { tag: string; version: string; sourceRevision: string; releaseSet: string; image: string; npm: string | null; manifestReleaseSet: string; runtime: Dict; release_url: string }

/** Python `published_web_release`: the newest completed `release-set-<sha>` whose Web component matches the channel's tag family. */
export async function publishedWebRelease(channel: Channel, getJson: GetJson, now: () => number = () => performance.now()): Promise<PublishedRelease> {
  const tagPattern = new RegExp(`^${channel === 'experimental' ? 'web-exp-v' : 'web-v'}${VERSION}$`)
  const deadline = now() + 15_000
  const fetchJson = (path: string, asset = false): Promise<unknown> => {
    if (now() >= deadline) throw new ReleaseUnavailable('Release lookup exceeded its deadline; retry or update manually', true)
    return getJson(path, { asset })
  }
  const published: Dict[] = []
  let exhausted = true
  for (let page = 1; page <= 5; page += 1) {
    const releases = await fetchJson(`/releases?per_page=100&page=${String(page)}`)
    if (!Array.isArray(releases)) throw new ReleaseUnavailable('Invalid published release list')
    for (const item of releases) if (item && typeof item === 'object' && !(item as Dict).draft && typeof (item as Dict).published_at === 'string') published.push(item as Dict)
    if (releases.length < 100) { exhausted = false; break }
  }
  if (exhausted) throw new ReleaseUnavailable('Release history exceeds automatic lookup; update manually')
  published.sort((a, b) => (str(a.published_at) < str(b.published_at) ? 1 : str(a.published_at) > str(b.published_at) ? -1 : 0))
  for (const release of published) {
    const tag = release.tag_name
    if (typeof tag !== 'string' || !/^release-set-[a-f0-9]{40}$/.test(tag)) continue
    if (!Array.isArray(release.assets)) throw new ReleaseUnavailable('Published release set has invalid assets')
    const assets = release.assets.filter((a): a is Dict => Boolean(a) && typeof a === 'object' && (a as Dict).name === 'release-set.json')
    const id = assets[0]?.id
    if (assets.length !== 1 || typeof id !== 'number' || !Number.isInteger(id) || id < 1) throw new ReleaseUnavailable('Published release set lacks its immutable manifest')
    const manifest = await fetchJson(`/releases/assets/${String(id)}`, true)
    const m = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? (manifest as Dict) : null
    if (m?.schemaVersion !== 1 || m.status !== 'complete' || m.releaseSet !== tag.slice('release-set-'.length)) throw new ReleaseUnavailable('Release set is incomplete or has inconsistent provenance')
    if (!m.components || typeof m.components !== 'object' || Array.isArray(m.components)) throw new ReleaseUnavailable('Release set lacks component metadata')
    const componentRaw = (m.components as Dict).web ?? {}
    if (!componentRaw || typeof componentRaw !== 'object' || Array.isArray(componentRaw)) throw new ReleaseUnavailable('Release set lacks Web metadata')
    const component = componentRaw as Dict
    const componentTag = component.tag
    if (typeof componentTag !== 'string' || !tagPattern.test(componentTag)) continue
    const source = component.sourceRevision
    if (typeof source !== 'string' || !SHA.test(source) || component.releaseSet !== source || component.version !== componentTag.split('-v').pop() || typeof component.image !== 'string' || !/^ghcr\.io\/maudecode\/talaria-web@sha256:[a-f0-9]{64}$/.test(component.image)) {
      throw new ReleaseUnavailable('Web release references are mutable or inconsistent')
    }
    const npm = component.npm
    if (npm !== undefined && npm !== `${WEB_NPM_PACKAGE}@${String(component.version)}`) throw new ReleaseUnavailable('Web npm release identity is inconsistent')
    const contracts = dict(m.contracts)
    const supported: Dict = {}
    for (const name of ['appWeb', 'webRelay']) {
      const items = dict(contracts[name]).web
      if (!Array.isArray(items) || !items.length || !items.every((v) => Number.isInteger(v) && (v as number) > 0)) throw new ReleaseUnavailable('Release set lacks Web compatibility provenance')
      supported[name] = items
    }
    const agent = m.agent
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) throw new ReleaseUnavailable('Release set lacks Web compatibility provenance')
    return {
      ...(component as unknown as PublishedRelease),
      tag: componentTag,
      version: str(component.version),
      sourceRevision: source,
      releaseSet: source,
      image: component.image,
      npm: typeof npm === 'string' ? npm : null,
      manifestReleaseSet: str(m.releaseSet),
      runtime: { tag: componentTag, version: component.version, sourceRevision: source, releaseSet: source, contracts: supported, compatibleAgent: agent },
      release_url: `${REPOSITORY_URL}/releases/tag/${tag}`,
    }
  }
  throw new ReleaseUnavailable('No completed Talaria Web release is available on this channel')
}

// ── Experimental artifacts (TAL-343) ─────────────────────────────────────────

const GHCR = 'https://ghcr.io'
const EXPERIMENTAL_REPOSITORY = 'maudecode/talaria-web-experimental'
const EXPERIMENTAL_ARTIFACT_TYPE = 'application/vnd.maudecode.talaria-web.experimental.v1'
const EXPERIMENTAL_LAYER_TYPE = 'application/vnd.maudecode.talaria-web.npm.tgz'
/** GHCR serves blobs by redirecting here; the pull token never follows. */
const EXPERIMENTAL_BLOB_HOST = 'pkg-containers.githubusercontent.com'
export const EXPERIMENTAL_TARBALL_CAP = 200_000_000
const EXPERIMENTAL_VERSION = new RegExp(`^${VERSION}-exp\\.([a-f0-9]{12})$`)

/** The `experimental` tag of the public GHCR artifact: identity from its annotations, content by digest. */
export interface ExperimentalRelease { tag: string; version: string; sourceRevision: string; digest: string; size: number }

export interface ExperimentalRegistry {
  release: () => Promise<ExperimentalRelease>
  /** The layer bytes, verified against the release digest and size. */
  download: (release: ExperimentalRelease) => Promise<Buffer>
}

/** Anonymous GHCR client with `githubJson`'s timeouts, caps, and transient classification. */
export function ghcrExperimental(fetchImpl: typeof fetch): ExperimentalRegistry {
  const send = async (url: string, init: RequestInit): Promise<Response> => {
    try { return await fetchImpl(url, { redirect: 'manual', ...init }) } catch (error) { throw new ReleaseUnavailable(`GHCR is unreachable: ${(error as Error).message}`, true) }
  }
  const check = (res: Response, what: string): void => {
    if (!res.ok) throw new ReleaseUnavailable(`GHCR answered ${String(res.status)} for the Experimental ${what}`, res.status >= 500 || res.status === 429)
  }
  const json = async (res: Response, what: string): Promise<Dict> => {
    check(res, what)
    const body = await readCapped(res, 2_000_000)
    if (!body) throw new ReleaseUnavailable(`Experimental ${what} exceeds the download limit`)
    try { return dict(JSON.parse(body.toString('utf8'))) } catch { throw new ReleaseUnavailable(`Invalid Experimental ${what}`) }
  }
  const token = async (): Promise<string> => {
    const body = await json(await send(`${GHCR}/token?scope=repository:${EXPERIMENTAL_REPOSITORY}:pull`, { signal: AbortSignal.timeout(5000) }), 'pull token')
    if (typeof body.token !== 'string' || !body.token) throw new ReleaseUnavailable('GHCR did not issue an anonymous pull token')
    return body.token
  }
  return {
    release: async () => {
      const auth = { Authorization: `Bearer ${await token()}` }
      const m = await json(await send(`${GHCR}/v2/${EXPERIMENTAL_REPOSITORY}/manifests/experimental`, { headers: { ...auth, Accept: 'application/vnd.oci.image.manifest.v1+json' }, signal: AbortSignal.timeout(5000) }), 'manifest')
      const layers = Array.isArray(m.layers) ? m.layers.map(dict) : []
      const layer = layers[0]
      if (m.artifactType !== EXPERIMENTAL_ARTIFACT_TYPE || layers.length !== 1 || layer?.mediaType !== EXPERIMENTAL_LAYER_TYPE) throw new ReleaseUnavailable('The Experimental artifact has an unexpected format')
      const annotations = dict(m.annotations)
      const sourceRevision = annotations['org.opencontainers.image.revision']
      const version = annotations['org.opencontainers.image.version']
      const size = layer.size
      if (typeof sourceRevision !== 'string' || !SHA.test(sourceRevision) || typeof version !== 'string' || EXPERIMENTAL_VERSION.exec(version)?.[4] !== sourceRevision.slice(0, 12)
        || typeof layer.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(layer.digest) || typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > EXPERIMENTAL_TARBALL_CAP) {
        throw new ReleaseUnavailable('The Experimental artifact has malformed provenance')
      }
      return { tag: `web-exp-v${version}`, version, sourceRevision, digest: layer.digest, size }
    },
    download: async (release) => {
      let res = await send(`${GHCR}/v2/${EXPERIMENTAL_REPOSITORY}/blobs/${release.digest}`, { headers: { Authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(120_000) })
      if (res.status >= 300 && res.status < 400) {
        const target = new URL(res.headers.get('location') ?? '', GHCR)
        if (target.protocol !== 'https:' || target.hostname !== EXPERIMENTAL_BLOB_HOST) throw new ReleaseUnavailable('Unexpected Experimental download redirect')
        res = await send(target.toString(), { redirect: 'error', signal: AbortSignal.timeout(120_000) })
      }
      check(res, 'download')
      const body = await readCapped(res, release.size)
      if (body?.length !== release.size || `sha256:${createHash('sha256').update(body).digest('hex')}` !== release.digest) throw new ReleaseUnavailable('The Experimental download does not match its digest')
      return body
    },
  }
}

// ── Web checkout ─────────────────────────────────────────────────────────────

/** The git root when `webRoot` is `<root>/web` of a Talaria checkout with a GitHub `maudecode/talaria` origin; else null. */
export async function checkoutRoot(webRoot: string | null, git: GitRun): Promise<string | null> {
  if (!webRoot || !existsSync(webRoot)) return null
  const web = realpathSync(webRoot)
  const top = await git(['rev-parse', '--show-toplevel'], web)
  if (!top.ok || !top.out || resolve(realpathSync(top.out), 'web') !== web) return null
  const root = realpathSync(top.out)
  if (!existsSync(join(root, 'contracts', 'versions.json')) || !existsSync(join(web, 'package.json'))) return null
  const remote = await git(['remote', 'get-url', 'origin'], root)
  if (!remote.ok) return null
  const normalized = remote.out.trim().replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase()
  if (normalized === 'git@github.com:maudecode/talaria') return root
  try {
    const u = new URL(normalized)
    const port = u.port === '' ? null : u.port
    if ((u.protocol !== 'https:' && u.protocol !== 'ssh:') || u.hostname !== 'github.com' || u.pathname !== '/maudecode/talaria' || u.search || u.hash) return null
    if (port !== null && port !== (u.protocol === 'https:' ? '443' : '22')) return null
    return root
  } catch {
    return null
  }
}

export interface NpmInstallInfo { packageRoot: string; version: string }

/** A real global npm install of this package; local, npx, linked and container trees fail closed. */
export async function npmInstallInfo(webRoot: string | null, npm: BuildRun = runPackageNpm, container = existsSync('/.within_container') || existsSync('/.dockerenv') || existsSync('/run/.containerenv')): Promise<NpmInstallInfo | null> {
  if (container || !webRoot || !existsSync(webRoot)) return null
  let metadata: Dict
  try { metadata = dict(JSON.parse(readFileSync(join(webRoot, 'package.json'), 'utf8'))) } catch { return null }
  if (metadata.name !== WEB_NPM_PACKAGE || typeof metadata.version !== 'string' || !(new RegExp(`^${VERSION}$`).test(metadata.version) || EXPERIMENTAL_VERSION.test(metadata.version))) return null
  const global = await npm(['root', '--global'], webRoot, 10_000)
  if (!global.ok || !isAbsolute(global.out)) return null
  const expected = join(resolve(global.out), '@maudecode', 'talaria-web')
  try {
    if (lstatSync(expected).isSymbolicLink() || realpathSync(expected) !== realpathSync(webRoot)) return null
  } catch { return null }
  return { packageRoot: realpathSync(webRoot), version: metadata.version }
}

function compareVersions(installed: string, latest: string): number {
  const a = installed.split('.').map(Number)
  const b = latest.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return Math.sign((a[i] ?? 0) - (b[i] ?? 0))
  return 0
}

function diskRelease(webRoot: string): Dict | null {
  try { return validateReleaseInfo(JSON.parse(readFileSync(join(webRoot, '_release.json'), 'utf8')), webRoot) } catch { return null }
}

/** The channel an npm install came from: its release tag prefix (`web-exp-v` or `web-v`). */
function npmInstallChannel(installed: NpmInstallInfo, id: ReleaseIdentity): Channel {
  return str(diskRelease(installed.packageRoot)?.tag ?? id.release().tag).startsWith('web-exp-v') ? 'experimental' : 'stable'
}

/** An npm install on Experimental: behind when its source differs from the `experimental` tag, or when switching channels. */
async function checkNpmExperimental(result: Dict, installed: NpmInstallInfo, id: ReleaseIdentity, registry: ExperimentalRegistry): Promise<Dict> {
  let release: ExperimentalRelease
  try {
    release = await registry.release()
  } catch (error) {
    const unavailable = error instanceof ReleaseUnavailable ? error : new ReleaseUnavailable('The Experimental artifact is unavailable')
    return { ...result, install_kind: 'npm', manual_update: true, error: unavailable.message, ...(unavailable.transient ? { stale_check: true } : {}) }
  }
  Object.assign(result, { latest_version: release.tag, latest_sha: release.sourceRevision, branch: 'experimental', release_based: true, no_git: true, install_kind: 'npm', manual_update: false })
  const disk = diskRelease(installed.packageRoot)
  const current = str(disk?.sourceRevision ?? id.release().sourceRevision) || null
  if (npmInstallChannel(installed, id) !== 'experimental') return { ...result, current_sha: current, behind: 1, channel_switch: true, message: `Switching to Experimental installs ${release.version}.` }
  if (disk?.sourceRevision !== release.sourceRevision) return { ...result, current_sha: current, behind: 1, message: `Experimental update ${release.version} is available.` }
  const metadataRepair = !same(id.release(), disk)
  return { ...result, current_sha: release.sourceRevision, behind: 0, metadata_repair: metadataRepair, ...(metadataRepair ? { message: 'The npm package is current; finish the update to restart with that version.' } : {}) }
}

/** Python `verify_release_source`: the stamp Web expects for `release`, computed from immutable blobs at its source revision. */
export async function verifyReleaseSource(root: string, release: PublishedRelease, git: GitRun): Promise<Dict> {
  const files: Dict = {}
  for (const name of RELEASE_BLOBS) {
    const shown = await git(['show', `${release.sourceRevision}:web/${name}`], root)
    if (!shown.ok) throw new Error('missing release metadata')
    files[name] = JSON.parse(shown.out) as unknown
  }
  const pin = dict(files['sidecar/agent_dependency.json'])
  const versions = dict(files['contract_versions.json'])
  const expected = {
    tag: release.tag,
    version: release.version,
    sourceRevision: release.sourceRevision,
    releaseSet: release.sourceRevision,
    contracts: { appWeb: [dict(versions.appWeb).fixtureVersion], webRelay: [dict(versions.webRelay).protocolVersion] },
    compatibleAgent: { ...dict(pin['x-talaria']), image: dict(dict(pin.services)['hermes-agent']).image },
  }
  if (!same(expected, release.runtime)) throw new Error('release metadata differs from source')
  return expected
}

export interface ReleaseIdentity {
  /** `RELEASE_INFO`: the stamp when it matches the checkout, else development info. */
  release: () => Dict
  /** `STAMPED_RELEASE_INFO`: the validated stamp regardless of checkout identity. */
  stamped: () => Dict
  /** `RUNNING_SOURCE_REVISION`: HEAD when this process started. */
  runningSourceRevision: () => string | null
}

const stampPath = (root: string): string => join(root, RELEASE_STAMP)
const readStamp = (path: string): string | null => {
  if (!existsSync(path) && !isSymlink(path)) return null
  if (isSymlink(path)) throw new Error('local release stamp is a symbolic link')
  return readFileSync(path, 'utf8')
}
const isSymlink = (path: string): boolean => { try { return lstatSync(path).isSymbolicLink() } catch { return false } }

/** Python `_verified_release_stamp`: `[expected, installed]`; throws on a modified stamp. */
async function verifiedReleaseStamp(root: string, release: PublishedRelease, git: GitRun, id: ReleaseIdentity): Promise<[Dict, Dict | null]> {
  const expected = await verifyReleaseSource(root, release, git)
  const raw = readStamp(stampPath(root))
  const installed = raw === null ? null : (JSON.parse(raw) as Dict)
  if (installed !== null && ![id.release(), id.stamped(), expected].some((c) => same(c, installed))) throw new Error('local release stamp was modified')
  return [expected, installed]
}

/** Python `_main_stamp`: the unchanged generated stamp bytes (to discard when leaving a release), else null. */
function mainStamp(root: string, id: ReleaseIdentity): string | null {
  const data = readStamp(stampPath(root))
  if (data !== null && (!id.stamped().tag || !same(JSON.parse(data), id.stamped()))) throw new Error('local release stamp was modified')
  return data
}

async function mainRevision(root: string, git: GitRun): Promise<[string | null, string]> {
  const fetched = await fetchWithRetry(git, ['fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main'], root, 30_000)
  if (!fetched.ok) return [null, fetched.out]
  // Single-branch clones never receive tags, so `git describe` would name a stale Web release.
  // Best effort and unforced: a conflicting local tag is kept and never fails the main fetch.
  await git(['fetch', '--no-tags', 'origin', 'refs/tags/web-v*:refs/tags/web-v*', 'refs/tags/web-exp-v*:refs/tags/web-exp-v*'], root, 30_000)
  const source = await git(['rev-parse', 'refs/remotes/origin/main^{commit}'], root)
  return source.ok && SHA.test(source.out) ? [source.out, ''] : [null, '']
}

async function mainPathsDiffer(root: string, before: string, after: string, git: GitRun): Promise<boolean | null> {
  const files = await git(['diff', '--no-renames', '--name-only', before, after, '--', ...WEB_UPDATE_PATHS], root)
  return files.ok ? Boolean(files.out) : null
}

async function mainChangeCount(root: string, before: string, after: string, git: GitRun): Promise<number | null> {
  const changed = await mainPathsDiffer(root, before, after, git)
  if (changed === null) return null
  if (!changed) return 0
  const count = await git(['rev-list', '--count', '--full-history', `${before}..${after}`, '--', ...WEB_UPDATE_PATHS], root)
  const n = Number.parseInt(count.out, 10)
  return count.ok && /^\d+$/.test(count.out) && n > 0 ? n : null
}

async function mainRestartPending(root: string, head: string, git: GitRun, id: ReleaseIdentity): Promise<boolean> {
  const running = id.runningSourceRevision()
  if (running === head) return false
  if (!running) return true
  return (await mainPathsDiffer(root, running, head, git)) !== false
}

async function checkMainUpdate(root: string | null, result: Dict, git: GitRun, id: ReleaseIdentity): Promise<Dict> {
  Object.assign(result, { branch: 'origin/main', release_based: false })
  if (root === null) return { ...result, manual_update: true, message: 'Main updates require an authenticated Talaria source checkout with Web under web/.' }
  const [source, error] = await mainRevision(root, git)
  if (source === null) {
    const detail = sanitizeGitDiagnostic(error)
    return { ...result, stale_check: true, error: gitFailure(error, detail ? `Could not fetch origin/main: ${detail}` : 'Could not fetch origin/main; check Git read access.').message }
  }
  Object.assign(result, { latest_sha: source, latest_version: `main@${source.slice(0, 12)}` })
  const head = await git(['rev-parse', 'HEAD'], root)
  const status = await git(['status', '--porcelain', '--untracked-files=all'], root)
  if (!head.ok || !SHA.test(head.out) || !status.ok) return { ...result, manual_update: true, error: 'Could not verify the source checkout' }
  Object.assign(result, { installed_sha: head.out, dirty: Boolean(status.out) })
  const base = await git(['merge-base', head.out, source], root)
  result.current_sha = base.ok && SHA.test(base.out) ? base.out : null
  if (result.current_sha) result.compare_url = `${REPOSITORY_URL}/compare/${base.out}...${source}`
  if (!base.ok || base.out !== head.out) return { ...result, manual_update: true, message: 'This checkout is ahead of or diverged from origin/main; reconcile it manually.' }
  const count = await mainChangeCount(root, head.out, source, git)
  if (count === null) return { ...result, error: 'Could not compare the source checkout with origin/main' }
  try { mainStamp(root, id) } catch { return { ...result, manual_update: true, error: 'Inspect the modified release stamp before updating.' } }
  Object.assign(result, { behind: count, metadata_repair: count === 0 && (await mainRestartPending(root, head.out, git, id)) })
  if (status.out) Object.assign(result, { manual_update: true, message: 'Commit or remove local changes before updating; Web updates never discard them.' })
  else if (result.metadata_repair) result.message = 'Source is current; finish the update to restart with that revision.'
  return result
}

/** Python `check_web_update`. */
export async function checkWebUpdate(webRoot: string | null, currentVersion: string, channel: Channel, git: GitRun, getJson: GetJson, id: ReleaseIdentity, npmRun: BuildRun = runPackageNpm, registry?: ExperimentalRegistry): Promise<Dict> {
  const root = await checkoutRoot(webRoot, git)
  const npmInstall = root === null ? await npmInstallInfo(webRoot, npmRun) : null
  const result: Dict = { name: 'webui', channel, repo_url: REPOSITORY_URL, current_version: currentVersion, behind: null, no_git: root === null }
  if (channel === 'experimental' && root !== null) return checkMainUpdate(root, result, git, id)
  if (channel === 'experimental' && npmInstall && registry) return checkNpmExperimental(result, npmInstall, id, registry)
  let release: PublishedRelease
  try {
    release = await publishedWebRelease(channel, getJson)
  } catch (error) {
    if (error instanceof ReleaseUnavailable) return { ...result, manual_update: true, error: error.message, ...(error.transient ? { stale_check: true } : {}) }
    return { ...result, manual_update: true, error: 'Talaria release metadata is unavailable. Private repositories require TALARIA_RELEASE_TOKEN with Contents read access.' }
  }
  Object.assign(result, { latest_version: release.tag, latest_sha: release.sourceRevision, branch: release.tag, release_based: true, release_url: release.release_url, image: release.image })
  if (root === null) {
    if (npmInstall && channel === 'stable' && release.npm && npmInstallChannel(npmInstall, id) === 'experimental') {
      // A channel switch installs the newest Stable package regardless of version order (TAL-343).
      return { ...result, current_sha: id.release().sourceRevision ?? null, behind: 1, no_git: true, install_kind: 'npm', npm: release.npm, manual_update: false, channel_switch: true, message: `Switching to Stable installs npm release ${release.version}.` }
    }
    if (npmInstall && channel === 'stable' && release.npm && !str(id.release().tag).startsWith('web-exp-v')) {
      const comparison = compareVersions(npmInstall.version, release.version)
      if (comparison > 0) return { ...result, current_sha: id.release().sourceRevision ?? null, behind: 0, no_git: true, install_kind: 'npm', manual_update: true, message: 'This npm installation is ahead of the selected Stable release.' }
      if (comparison < 0) return { ...result, current_sha: id.release().sourceRevision ?? null, behind: 1, no_git: true, install_kind: 'npm', npm: release.npm, manual_update: false, message: `Stable npm update ${release.version} is available.` }
      const installed = diskRelease(npmInstall.packageRoot)
      if (!same(installed, release.runtime)) return { ...result, current_sha: id.release().sourceRevision ?? null, behind: null, no_git: true, install_kind: 'npm', manual_update: true, error: 'Installed npm release metadata does not match the completed release.' }
      const metadataRepair = !same(id.release(), release.runtime)
      return { ...result, current_sha: release.sourceRevision, behind: 0, no_git: true, install_kind: 'npm', npm: release.npm, manual_update: false, metadata_repair: metadataRepair, ...(metadataRepair ? { message: 'The npm package is current; finish the update to restart with that version.' } : {}) }
    }
    const current = id.release().sourceRevision ?? null
    const version = new RegExp(`^${channel === 'experimental' ? 'web-exp-v' : 'web-v'}${VERSION}$`).exec(currentVersion)
    let behind: number | null = version && current === release.sourceRevision ? 0 : null
    if (behind === null && version) {
      const installed = version.slice(1).map(Number)
      const latest = release.version.split('.').map(Number)
      const cmp = installed.map((v, i) => Math.sign(v - (latest[i] ?? 0))).find((s) => s !== 0) ?? 0
      if (cmp !== 0) behind = cmp < 0 ? 1 : 0
    }
    return { ...result, current_sha: current, behind, no_git: true, manual_update: true, message: 'Use the published Talaria Web image or authenticated monorepo installation; legacy checkouts require migration.' }
  }
  const head = await git(['rev-parse', 'HEAD'], root)
  const status = await git(['status', '--porcelain', '--untracked-files=all'], root)
  if (!head.ok || !SHA.test(head.out) || !status.ok) return { ...result, manual_update: true, error: 'Could not verify the source checkout' }
  const current = head.out
  Object.assign(result, { installed_sha: current, dirty: Boolean(status.out) })
  let base: string
  let knownBase: boolean
  if (current === release.sourceRevision) {
    try {
      const [expected, installed] = await verifiedReleaseStamp(root, release, git, id)
      result.behind = 0
      result.metadata_repair = !same(installed, expected) || !same(id.release(), expected)
      if (result.metadata_repair) result.message = 'Apply the selected release again to repair its metadata or restart with its recorded identity.'
    } catch {
      Object.assign(result, { behind: null, manual_update: true, error: 'Could not verify local release provenance; inspect the release stamp before updating.' })
    }
    base = current
    knownBase = true
  } else {
    const contains = await git(['merge-base', '--is-ancestor', release.sourceRevision, current], root)
    if (contains.ok) return { ...result, behind: null, manual_update: true, current_sha: null, message: 'This checkout is ahead of the selected release. Manage it manually or check out the published release and restart Web.' }
    result.behind = 1
    const mb = await git(['merge-base', current, release.sourceRevision], root)
    base = mb.out
    knownBase = mb.ok
    if (knownBase && base !== current) Object.assign(result, { manual_update: true, message: 'Reconcile divergent source history before updating Web.' })
  }
  // Local-only commits cannot appear in a GitHub comparison; omit unresolvable links.
  result.current_sha = knownBase && SHA.test(base) ? base : null
  if (result.current_sha) result.compare_url = `${REPOSITORY_URL}/compare/${base}...${release.sourceRevision}`
  if (status.out) Object.assign(result, { manual_update: true, message: 'Commit or remove local changes before updating; Web updates never discard them.' })
  return result
}

/** Packaged-install collaborators: the Experimental registry and Web's state dir for channel-switch backups. */
export interface PackagedUpdateOptions { registry?: ExperimentalRegistry | undefined; stateDir?: string | undefined }

export const CHANNEL_SWITCH_BACKUPS = 5
/** Web's persisted stores (`settings.json`, the project store, the workspace store) as seen from the state dir. */
const PERSISTED_STORES = ['settings.json', 'projects.json', 'workspaces.json', 'last_workspace.txt']

/** Copy the persisted stores to `<stateDir>/backups/channel-switch-<UTC timestamp>/`, keeping the newest few; throws on failure. */
export function backupPersistedStores(stateDir: string, now: Date = new Date(), keep = CHANNEL_SWITCH_BACKUPS): string {
  const root = join(stateDir, 'backups')
  mkdirSync(root, { recursive: true })
  const name = `channel-switch-${now.toISOString().replace(/[:.]/g, '-')}`
  const target = join(root, name)
  if (existsSync(target)) throw new Error(`${name} already exists`)
  // Only a complete copy is published under the name that counts toward the retained backups.
  const partial = mkdtempSync(join(root, `.${name}-`))
  try {
    for (const store of PERSISTED_STORES) if (existsSync(join(stateDir, store))) copyFileSync(join(stateDir, store), join(partial, store))
    renameSync(partial, target)
  } catch (error) {
    rmSync(partial, { recursive: true, force: true })
    throw error
  }
  const backups = readdirSync(root).filter((name) => name.startsWith('channel-switch-')).sort()
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) rmSync(join(root, old), { recursive: true, force: true })
  return target
}

async function applyNpmWebUpdate(webRoot: string | null, channel: Channel, getJson: GetJson, id: ReleaseIdentity, npmRun: BuildRun, canApply: () => boolean, packaged: PackagedUpdateOptions): Promise<Dict> {
  const installed = await npmInstallInfo(webRoot, npmRun)
  if (!installed) return { ok: false, manual_update: true, message: 'Automatic npm updates require a direct global @maudecode/talaria-web installation.' }
  // Switching channels installs the selected channel's newest artifact regardless of version order (TAL-343).
  const switching = npmInstallChannel(installed, id) !== channel
  const onDisk = diskRelease(installed.packageRoot)
  let target: { version: string; sourceRevision: string; label: string; matches: (release: Dict | null) => boolean; npm?: string; experimental?: ExperimentalRelease }
  if (channel === 'stable') {
    let release: PublishedRelease
    try { release = await publishedWebRelease('stable', getJson) } catch { return { ok: false, message: 'Cannot resolve a completed Talaria release. Check private-repository read access.' } }
    if (!release.npm) return { ok: false, manual_update: true, message: 'The completed Stable release does not include an npm package identity.' }
    target = { version: release.version, sourceRevision: release.sourceRevision, label: `npm release ${release.version}`, matches: (r) => same(r, release.runtime), npm: release.npm }
    if (!switching) {
      if (!canApply()) return { ok: false, message: 'Web update deferred because its settings or lifecycle changed.' }
      const comparison = compareVersions(installed.version, release.version)
      if (comparison > 0) return { ok: false, manual_update: true, message: 'This npm installation is ahead of the selected Stable release.' }
      if (comparison === 0 && !target.matches(onDisk)) return { ok: false, manual_update: true, message: 'Installed npm release metadata does not match the completed release.' }
    }
  } else {
    if (!packaged.registry) return { ok: false, manual_update: true, message: 'Packaged Experimental updates are unavailable in this installation.' }
    let release: ExperimentalRelease
    try { release = await packaged.registry.release() } catch (error) { return { ok: false, message: error instanceof ReleaseUnavailable ? error.message : 'The Experimental artifact is unavailable.' } }
    const identity = { tag: release.tag, version: release.version, sourceRevision: release.sourceRevision, releaseSet: release.sourceRevision }
    // validateReleaseInfo (in diskRelease) already applies Stable's contract and Agent-pin checks to the packaged files.
    target = { version: release.version, sourceRevision: release.sourceRevision, label: `Experimental ${release.version}`, matches: (r) => r !== null && same({ tag: r.tag, version: r.version, sourceRevision: r.sourceRevision, releaseSet: r.releaseSet }, identity), experimental: release }
  }
  const current = !switching && target.matches(onDisk)
  if (current) {
    if (same(id.release(), onDisk)) return { ok: true, up_to_date: true, target: 'webui', channel, message: channel === 'stable' ? 'Talaria Web already contains the selected npm release.' : `Talaria Web already contains ${target.label}.` }
    return { ok: true, target: 'webui', channel, sourceRevision: target.sourceRevision, ...(target.npm ? { npm: target.npm } : {}), message: `Restarting Talaria Web with ${target.label}.` }
  }
  if (!canApply()) return { ok: false, message: 'Web update deferred because its settings or lifecycle changed.' }
  // Global npm installs keep dependencies inside the package. Build the replacement beside the old package so
  // install/verification failures cannot damage the running installation and the final rename stays on one volume.
  const staging = mkdtempSync(join(dirname(installed.packageRoot), '.talaria-update-'))
  const candidate = join(staging, 'lib/node_modules/@maudecode/talaria-web')
  const backup = join(staging, 'previous')
  let keepBackup = false
  let stores: string | null = null
  try {
    let spec = target.npm ?? ''
    if (target.experimental) {
      let tarball: Buffer
      try { tarball = await packaged.registry!.download(target.experimental) } catch (error) {
        return { ok: false, verification_failed: true, target: 'webui', channel, message: `${error instanceof ReleaseUnavailable ? error.message : 'The Experimental download failed'}. The installed package was preserved.` }
      }
      spec = join(staging, 'talaria-web-experimental.tgz')
      writeFileSync(spec, tarball)
    }
    const update = await npmRun(['install', '--global', '--prefix', staging, '--no-audit', '--no-fund', spec], staging, WEB_BUILD_TIMEOUT_MS)
    if (!update.ok) return { ok: false, install_failed: true, target: 'webui', channel, message: `npm update failed: ${sanitizeGitDiagnostic(update.out, 1000) || 'unknown error'}` }
    const metadata = dict(JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')))
    const bins = dict(metadata.bin)
    if (metadata.name !== WEB_NPM_PACKAGE || metadata.version !== target.version || !target.matches(diskRelease(candidate))
      || !['talaria-web', 'talaria-web-mcp'].every((name) => str(bins[name]).replace(/^\.\//, '') === `dist/bin/${name}.js` && existsSync(join(candidate, `dist/bin/${name}.js`)))) {
      return { ok: false, verification_failed: true, target: 'webui', channel, message: `The downloaded npm package does not match ${channel === 'stable' ? 'the completed release' : 'the Experimental artifact'}. The installed package was preserved.` }
    }
    const recheck = await npmInstallInfo(webRoot, npmRun)
    if (!canApply() || recheck?.packageRoot !== installed.packageRoot || recheck.version !== installed.version) return { ok: false, message: 'The npm installation or update settings changed; retry the update.' }
    if (switching) {
      try {
        if (!packaged.stateDir) throw new Error('the Web state directory is unknown')
        stores = backupPersistedStores(packaged.stateDir)
      } catch (error) {
        return { ok: false, backup_failed: true, target: 'webui', channel, message: `Channel switch aborted: Web settings could not be backed up (${sanitizeGitDiagnostic((error as Error).message, 300)}). The installed package was preserved.` }
      }
    }
    renameSync(installed.packageRoot, backup)
    try { renameSync(candidate, installed.packageRoot) } catch (error) {
      // Never delete the only surviving copy if a filesystem error also prevents restoration.
      keepBackup = true
      renameSync(backup, installed.packageRoot)
      keepBackup = false
      throw error
    }
  } catch (error) {
    return { ok: false, install_failed: true, message: `npm update failed: ${sanitizeGitDiagnostic((error as Error).message, 1000)}${keepBackup ? `; previous package retained at ${backup}` : ''}` }
  } finally {
    if (!keepBackup) { try { rmSync(staging, { recursive: true, force: true }) } catch { /* a leftover staging directory must not prevent restart after a verified switch */ } }
  }
  return { ok: true, target: 'webui', channel, sourceRevision: target.sourceRevision, ...(target.npm ? { npm: target.npm } : {}),
    ...(switching ? { channel_switch: true, backup_dir: stores } : {}), message: `Updated Talaria Web to ${target.label}.${stores ? ` Settings were backed up to ${stores}.` : ''}` }
}

/** Python `apply_web_update`: fast-forward a recognized clean checkout to main or a published Stable tag. */
export async function applyWebUpdate(webRoot: string | null, channel: Channel, git: GitRun, getJson: GetJson, id: ReleaseIdentity, build: BuildRun = runNpm, npmRun: BuildRun = runPackageNpm, canApply: () => boolean = () => true, packaged: PackagedUpdateOptions = {}): Promise<Dict> {
  const root = await checkoutRoot(webRoot, git)
  if (root === null) return applyNpmWebUpdate(webRoot, channel, getJson, id, npmRun, canApply, packaged)
  const status = await git(['status', '--porcelain', '--untracked-files=all'], root)
  if (!status.ok || status.out) return { ok: false, dirty: true, message: 'Web update refused: the checkout must be clean, including untracked files.' }
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG']) {
    const path = await git(['rev-parse', '--git-path', marker], root)
    if (!path.ok || existsSync(resolve(root, path.out))) return { ok: false, message: 'Finish or abort the repository operation before updating Web.' }
  }
  const headRes = await git(['rev-parse', 'HEAD'], root)
  if (!headRes.ok || !SHA.test(headRes.out)) return { ok: false, message: 'Could not verify the current source revision' }
  const head = headRes.out
  const main = channel === 'experimental'
  let source: string
  let tag: string
  let release: PublishedRelease | null = null
  if (main) {
    const [revision, error] = await mainRevision(root, git)
    if (revision === null) return gitFailure(error, 'Could not fetch origin/main; check Git read access.')
    source = revision
    tag = 'main'
  } else {
    try {
      release = await publishedWebRelease(channel, getJson)
    } catch {
      return { ok: false, message: 'Cannot resolve a completed Talaria release. Check private-repository read access.' }
    }
    source = release.sourceRevision
    tag = release.tag
  }
  if (head !== source && !main) {
    // Fetch only this immutable tag; never force-replace a local tag or pull an unrecorded tip.
    const fetched = await git(['fetch', '--no-tags', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], root, 30_000)
    if (!fetched.ok) return gitFailure(fetched.out, 'Could not fetch the published Web tag. Check Git credentials or a conflicting local tag.')
    const resolved = await git(['rev-parse', `refs/tags/${tag}^{commit}`], root)
    if (!resolved.ok || resolved.out !== source) return { ok: false, message: 'Published Web tag does not match the immutable release manifest' }
  }
  if (head !== source) {
    const forward = await git(['merge-base', '--is-ancestor', head, source], root)
    if (!forward.ok) {
      const contains = await git(['merge-base', '--is-ancestor', source, head], root)
      if (contains.ok) return { ok: false, manual_update: true, target: 'webui', channel, message: 'This checkout is ahead of the selected source. Manage it manually; updates never rewind local work.' }
      return { ok: false, message: 'Web update refused: source histories diverge; reconcile the checkout manually.' }
    }
  }
  if (main) {
    const count = await mainChangeCount(root, head, source, git)
    if (count === null) return { ok: false, message: 'Could not compare Web and contract changes against origin/main.' }
    if (count === 0) source = head // No checkout mutation for App/Relay-only changes.
  }
  // Compare provenance with the immutable incoming files before modifying the checkout.
  let expected: Dict | null = null
  let installed: Dict | string | null
  try {
    if (main) installed = mainStamp(root, id)
    else [expected, installed] = await verifiedReleaseStamp(root, release!, git, id)
  } catch {
    return { ok: false, message: 'Web update refused: source or local provenance does not match the release manifest.' }
  }
  const runtimeCurrent = main ? !(await mainRestartPending(root, head, git, id)) : same(installed, expected) && same(id.release(), expected)
  if (head === source && runtimeCurrent) return { ok: true, up_to_date: true, target: 'webui', channel, message: main ? 'Web and shared contracts are current on main.' : 'Talaria Web already contains the selected release.' }
  const again = await git(['rev-parse', 'HEAD'], root)
  const clean = await git(['status', '--porcelain', '--untracked-files=all'], root)
  if (!again.ok || again.out !== head || !clean.ok || clean.out) return { ok: false, message: 'The checkout changed during the update; retry after it is clean.' }
  if (!canApply()) return { ok: false, message: 'Web update deferred because its settings or lifecycle changed.' }
  if (head !== source) {
    const merged = await git(['merge', '--ff-only', '--no-stat', '--no-overwrite-ignore', source], root, 30_000)
    const actual = await git(['rev-parse', 'HEAD'], root)
    if (!merged.ok || !actual.ok || actual.out !== source) return gitFailure(merged.out, 'Web fast-forward failed; no local changes were discarded.')
  }
  // The supervisor re-executes the built artifact, so the checkout is installed and rebuilt before the stamp claims
  // the new release; a failed build leaves the old stamp (and the running server) truthful.
  const buildError = await buildWeb(root, build)
  if (buildError !== null) return { ok: false, build_failed: true, target: 'webui', channel, sourceRevision: source, message: `Source advanced to ${tag}, but the Web build failed: ${buildError}. Run \`npm ci\` and \`npm run build\` in web/ (see README), then restart Web.` }
  const stamp = stampPath(root)
  if (main && installed !== null) {
    try {
      if (isSymlink(stamp) || readFileSync(stamp, 'utf8') !== installed) throw new Error('release stamp changed during update')
      unlinkSync(stamp)
    } catch {
      return { ok: false, message: 'Source advanced but its release stamp could not be cleared; inspect it before restarting Web.' }
    }
  } else if (!main && !same(installed, expected)) {
    const temporary = join(dirname(stamp), `.release-${String(process.pid)}-${String(Date.now())}`)
    try {
      writeFileSync(temporary, `${JSON.stringify(expected, null, 2)}\n`)
      renameSync(temporary, stamp)
    } catch {
      rmSync(temporary, { force: true })
      return { ok: false, message: 'Source advanced, but release metadata could not be written. Repair file permissions before restarting Web.' }
    }
  }
  return { ok: true, target: 'webui', channel, sourceRevision: source, message: `Updated Talaria Web to ${tag}.` }
}

// ── Agent checkout: independent Stable releases or Experimental default branch ──

async function releaseTags(path: string, git: GitRun): Promise<string[]> {
  const out = await git(['tag', '--list', AGENT_TAG_GLOB, '--sort=-v:refname'], path)
  return out.ok ? out.out.split('\n').map((l) => l.trim()).filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag)) : []
}
async function currentReleaseTag(path: string, git: GitRun): Promise<string | null> {
  const out = await git(['describe', '--tags', '--exact-match', '--match', AGENT_TAG_GLOB, 'HEAD'], path)
  return out.ok && out.out ? out.out : null
}
async function verifiedAgentIdentity(path: string, expectedRevision: string, git: GitRun): Promise<{ verified_revision: string; verified_version: string | null } | null> {
  const head = await git(['rev-parse', 'HEAD'], path)
  if (!head.ok || head.out !== expectedRevision || !SHA.test(head.out)) return null
  return { verified_revision: head.out, verified_version: await currentReleaseTag(path, git) }
}
const headContainsRef = async (path: string, ref: string, git: GitRun): Promise<boolean> => (await git(['merge-base', '--is-ancestor', ref, 'HEAD'], path)).ok
const canFastForwardTo = async (path: string, ref: string, git: GitRun): Promise<boolean> => (await git(['merge-base', '--is-ancestor', 'HEAD', ref], path)).ok

async function detectDefaultBranch(path: string, git: GitRun): Promise<string> {
  const refreshed = await git(['remote', 'set-head', 'origin', '--auto'], path, 15_000)
  if (!refreshed.ok) throw new Error('Agent default branch could not be refreshed from origin')
  const out = await git(['symbolic-ref', 'refs/remotes/origin/HEAD'], path)
  const prefix = 'refs/remotes/origin/'
  if (out.ok && out.out.startsWith(prefix) && (await git(['rev-parse', '--verify', `${out.out}^{commit}`], path)).ok) return out.out.slice(prefix.length)
  throw new Error('Agent default branch is unavailable')
}

async function agentTarget(path: string, git: GitRun, channel: Channel): Promise<Dict> {
  const ref = channel === 'experimental' ? `origin/${await detectDefaultBranch(path, git)}` : (await releaseTags(path, git))[0]
  if (!ref) throw new Error('No stable Agent release is available')
  const current = await git(['rev-parse', 'HEAD'], path)
  const latest = await git(['rev-parse', `${ref}^{commit}`], path)
  if (!current.ok || !latest.ok || !SHA.test(current.out) || !SHA.test(latest.out)) throw new Error('Agent Git identity is unavailable')
  const count = await git(['rev-list', '--count', `${current.out}..${latest.out}`], path)
  const behind = count.ok && /^\d+$/.test(count.out) ? Number.parseInt(count.out, 10) : null
  const manual = current.out !== latest.out && !(await canFastForwardTo(path, latest.out, git))
  const remote = normalizeRemoteUrl((await git(['remote', 'get-url', 'origin'], path)).out)
  return {
    name: 'agent', channel, branch: ref, current_sha: current.out, latest_sha: latest.out,
    current_version: await currentReleaseTag(path, git) ?? current.out.slice(0, 12), latest_version: ref,
    behind, release_based: channel === 'stable', repo_url: remote, compare_url: compareUrl(remote, current.out, latest.out),
    ...(behind === null ? { error: 'Agent commit count is unavailable' } : {}),
    ...(manual ? { manual_update: true, message: 'Agent checkout is ahead of or divergent from this channel; refusing to rewind it.' } : {}),
  }
}

export interface AgentUpdatePolicy { supportedRevision: string; supportedVersion: string; confirmedRevision?: string }
export interface AgentUpdateOptions { agentChannel?: Channel | undefined; confirmedRevision?: string | undefined }
function agentWarning(info: Dict, policy: AgentUpdatePolicy): Dict {
  return { candidate_revision: info.latest_sha, supported_revision: policy.supportedRevision, supported_version: policy.supportedVersion,
    unsupported: info.latest_sha !== policy.supportedRevision }
}
function confirmAgent(info: Dict, policy?: AgentUpdatePolicy): Dict | null {
  // Ordinary apply handles its non-mutating no-op; force still cleans files at the same revision.
  if (!policy) return null
  if (info.latest_sha === policy.supportedRevision) return policy.confirmedRevision && policy.confirmedRevision !== info.latest_sha
    ? { ok: false, message: 'The Agent update target changed. Check for updates and try again.' } : null
  if (policy.confirmedRevision === info.latest_sha) return null
  return { ok: false, target: 'agent', agent_channel: info.channel, confirmation_required: true, ...agentWarning(info, policy),
    message: 'This Agent version is not officially supported by Talaria and may cause issues.' }
}

async function isDirty(path: string, git: GitRun): Promise<boolean> {
  const out = await git(['diff-index', '--quiet', 'HEAD', '--'], path, 1000)
  return !out.ok && (out.out === 'git exited with status 1' || !out.out || out.out.startsWith('git exited with status '))
}

/** Fetch and compare the independently selected Agent channel. */
export async function checkAgentUpdate(path: string | null, git: GitRun, channel: Channel = DEFAULT_CHANNEL): Promise<Dict> {
  if (!path || !existsSync(join(path, '.git'))) return { name: 'agent', behind: null, no_git: true }
  const fetched = await fetchWithRetry(git, ['fetch', 'origin', '--tags', '--force'], path, 15_000)
  if (!fetched.ok) {
    const message = fetched.out ? `fetch failed: ${sanitizeGitDiagnostic(fetched.out)}` : 'fetch failed'
    return { name: 'agent', channel, behind: null, error: message, stale_check: true, dirty: await isDirty(path, git) }
  }
  try { return { ...await agentTarget(path, git, channel), dirty: await isDirty(path, git) } }
  catch (error) { return { name: 'agent', channel, behind: null, error: (error as Error).message } }
}

/** Fetch, confirm the immutable Agent target, stash, fast-forward, and pop. */
export async function applyAgentUpdate(path: string | null, git: GitRun, channel: Channel = DEFAULT_CHANNEL, policy?: AgentUpdatePolicy): Promise<Dict> {
  if (!path || !existsSync(join(path, '.git'))) return { ok: false, message: 'Not a git repository' }
  const fetched = await git(['fetch', 'origin', '--quiet', '--tags', '--force'], path, 15_000)
  if (!fetched.ok) {
    if (isGitLockError(fetched.out)) return { ok: false, message: `Fetch failed due to a repository lock: ${fetched.out.trim()}`, lock_conflict: true }
    return { ok: false, message: fetchFailureMessage(fetched.out, 'Could not reach the remote repository. Check your internet connection and try again.') }
  }
  let info: Dict
  try { info = await agentTarget(path, git, channel) } catch (error) { return { ok: false, message: (error as Error).message } }
  if (info.current_sha === info.latest_sha) {
    const verified = await verifiedAgentIdentity(path, str(info.latest_sha), git)
    if (!verified) return { ok: false, message: 'The installed Agent revision could not be verified.' }
    return { ok: true, up_to_date: true, target: 'agent', message: 'Agent is up to date.', ...verified }
  }
  if (info.manual_update || info.error) return { ...info, ok: false, message: info.message ?? info.error }
  const warning = confirmAgent(info, policy)
  if (warning) return warning
  const ref = str(info.branch)
  const revision = str(info.latest_sha)
  const status = await git(['status', '--porcelain', '--untracked-files=no'], path)
  if (!status.ok) {
    if (isGitLockError(status.out)) return { ok: false, message: `Failed to inspect repo status due to a repository lock: ${status.out.trim()}`, lock_conflict: true }
    return { ok: false, message: `Failed to inspect repo status: ${status.out.slice(0, 200)}` }
  }
  if (status.out.split('\n').some((line) => ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(line.slice(0, 2)))) {
    return { ok: false, message: `The local agent repo has unresolved merge conflicts. To reset to the latest remote version run: git -C ${path} checkout . && git -C ${path} pull --ff-only`, conflict: true }
  }
  let stashed = false
  if (status.out) {
    if (!(await git(['stash', 'push', '-m', 'hermes-update-autostash'], path)).ok) return { ok: false, message: 'Failed to stash local changes' }
    stashed = true
  }
  // Merge the immutable commit that was checked/acknowledged, never re-fetch a moving ref here.
  const pulled = await git(['merge', '--ff-only', revision], path, 30_000)
  if (!pulled.ok) {
    let note = ''
    if (stashed) note = ` ${await restoreStash(path, git, pulled.out)}`
    if (isGitLockError(pulled.out)) return { ok: false, message: `Pull failed due to a repository lock: ${pulled.out.trim()}.${note}`, lock_conflict: true }
    return { ok: false, message: `Pull failed: ${sanitizeGitDiagnostic(pulled.out)}.${note}` }
  }
  let message = `agent updated to ${ref}`
  if (stashed) {
    const popped = await git(['stash', 'pop'], path)
    if (!popped.ok) message += '. Local changes remain in `git stash list`; resolve them manually.'
  }
  const verified = await verifiedAgentIdentity(path, revision, git)
  if (!verified) return { ok: false, message: 'The Agent update completed, but the installed revision could not be verified.', target: 'agent' }
  return { ok: true, message, target: 'agent', ref, ...verified }
}

async function restoreStash(path: string, git: GitRun, pullOut: string): Promise<string> {
  if ((await git(['stash', 'pop'], path)).ok) return 'Local modifications were restored from the temporary stash.'
  if ((await git(['stash', 'apply'], path)).ok) { await git(['stash', 'drop'], path); return 'Local modifications were restored from the temporary stash.' }
  return `Your local modifications could not be restored automatically (stash pop failed after pull error: ${pullOut.trim().slice(0, 200) || 'no detail'}). They remain safely in \`git stash list\`; run \`git -C ${path} stash pop\` once the lock is cleared.`
}

/** Python `apply_force_update` (agent branch): fetch, refuse a pure-ancestor rewind, `checkout . && clean -fd && reset --hard`. */
export async function forceAgentUpdate(path: string | null, git: GitRun, log: (line: string) => void, channel: Channel = DEFAULT_CHANNEL, policy?: AgentUpdatePolicy): Promise<Dict> {
  if (!path || !existsSync(join(path, '.git'))) return { ok: false, message: 'Not a git repository' }
  const fetched = await git(['fetch', 'origin', '--quiet', '--tags', '--force'], path, 15_000)
  if (!fetched.ok) return { ok: false, message: fetchFailureMessage(fetched.out, 'Could not reach the remote repository. Check your connection.') }
  let info: Dict
  try { info = await agentTarget(path, git, channel) } catch (error) { return { ok: false, message: (error as Error).message } }
  const ref = str(info.branch)
  const revision = str(info.latest_sha)
  if ((await headContainsRef(path, revision, git)) && !(await canFastForwardTo(path, revision, git))) {
    return { ok: false, message: `agent is already ahead of the ${channel} channel (${ref}); refusing to rewind the checkout. Switching to a slower channel keeps your current version until that channel catches up.`, target: 'agent', channel, refused_rewind: true }
  }
  const warning = confirmAgent(info, policy)
  if (warning) return warning
  await git(['checkout', '.'], path)
  const cleaned = await git(['clean', '-fd'], path)
  if (!cleaned.ok) log(`[updates] force update: git clean -fd failed (continuing to reset --hard): ${cleaned.out}`)
  if (!(await git(['reset', '--hard', revision], path)).ok) return { ok: false, message: `Force reset to ${ref} failed` }
  const verified = await verifiedAgentIdentity(path, revision, git)
  if (!verified) return { ok: false, message: 'The Agent force update completed, but the installed revision could not be verified.', target: 'agent' }
  return { ok: true, message: `agent force-updated to ${ref}`, target: 'agent', ref, ...verified }
}

/** Python `_inventory_locks`: report `.git/**\/*.lock` without touching any of them. */
export function inventoryLocks(path: string): { well_known_lock_present: boolean; well_known_lock_path: string | null; other_locks: string[] } {
  const gitDir = join(path, '.git')
  const out: { well_known_lock_present: boolean; well_known_lock_path: string | null; other_locks: string[] } = { well_known_lock_present: false, well_known_lock_path: null, other_locks: [] }
  if (!existsSync(gitDir)) return out
  const wellKnown = join(gitDir, 'index.lock')
  try { out.well_known_lock_present = existsSync(wellKnown) } catch { out.well_known_lock_present = true }
  out.well_known_lock_path = wellKnown
  try {
    for (const entry of readdirSync(gitDir, { recursive: true, encoding: 'utf8' }).sort()) {
      const rel = entry.split('\\').join('/')
      if (rel.endsWith('.lock') && rel !== 'index.lock') out.other_locks.push(rel)
    }
  } catch { /* unreadable subtrees are skipped */ }
  return out
}

/** Python `_purge_agent_pycache`: stale bytecode after a pull must not outlive the restart. */
export function purgePycache(root: string): void {
  if (!existsSync(root)) return
  const skip = new Set(['.git', 'venv', '.venv', 'node_modules'])
  const walk = (dir: string): void => {
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory() || skip.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.name === '__pycache__') rmSync(full, { recursive: true, force: true })
      else walk(full)
    }
  }
  walk(root)
}

// ── summary ──────────────────────────────────────────────────────────────────

const BULLET = /^\s*(?:[-*•]+|\d+[.)])\s*/
function cleanBullet(line: string): string {
  let s = line.replace(BULLET, '').trim().replace(/\s+/g, ' ')
  if (!s) return ''
  if (!'.!?'.includes(s[s.length - 1]!)) s += '.'
  return s.slice(0, 240)
}
function uniqueBullets(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) { const c = cleanBullet(item); if (c && !seen.has(c.toLowerCase())) { seen.add(c.toLowerCase()); out.push(c) } }
  return out
}
function splitCategory(line: string): [string | null, string] {
  const raw = line.trim()
  const m = /^\s*(?:[-*•]+|\d+[.)])?\s*(notice|what you(?:ll|'ll| will) notice|user(?:s)? will notice|worth knowing|worth|note)\s*:\s*(.+)$/i.exec(raw)
  if (!m) return [null, raw]
  const label = (m[1] ?? '').toLowerCase()
  return [['worth knowing', 'worth', 'note'].includes(label) ? 'worth' : 'notice', m[2] ?? '']
}
function fallbackBullets(details: Dict[]): string[] {
  const out = details.map((item) => {
    const label = str(item.label || item.name) || 'Hermes'
    const commits = item.commits as string[]
    if (commits.length) return `${label} has ${String(item.behind)} update(s), including ${item.commits_truncated ? 'recent updates' : 'updates'}: ${commits.slice(0, 3).join('; ')}.`
    return `${label} has ${String(item.behind)} update(s) available.`
  })
  return out.length ? out : ['Updates are available.']
}
function worthKnowingBullets(details: Dict[]): string[] {
  const truncated = details.filter((d) => d.commits_truncated && d.commits_limit)
  if (truncated.length) return truncated.slice(0, 2).map((d) => `${str(d.label || d.name) || 'Hermes'} has ${String(d.behind)} updates; this summary uses the latest ${String(d.commits_limit)} commit subjects, with the full comparison still available in the diff link.`)
  const targets = details.filter((d) => d.behind).map((d) => `${str(d.label || d.name) || 'Hermes'} (${String(d.behind)} update${d.behind === 1 ? '' : 's'})`)
  return targets.length > 1 ? [`This summary combines updates from ${targets.join(' and ')}.`] : []
}
function formatSections(text: string, details: Dict[]): [Dict[], string] {
  const noticeRaw: string[] = []
  const worthRaw: string[] = []
  for (const line of text.split('\n')) {
    const [category, body] = splitCategory(line)
    if (category === 'notice') noticeRaw.push(body)
    else if (category === 'worth') worthRaw.push(body)
    else if (/^\s*(?:[-*•]+|\d+[.)])?\s*[A-Za-z][A-Za-z ]{1,32}\s*:/.test(line)) noticeRaw.push(body)
  }
  let notice = uniqueBullets(noticeRaw)
  if (!notice.length) {
    const raw = text.trim()
    let candidates = raw.split('\n').map((l) => cleanBullet(splitCategory(l)[1])).filter(Boolean)
    if (candidates.length <= 1 && raw) candidates = raw.split(/(?<=[.!?])\s+/).map(cleanBullet).filter(Boolean)
    if (!candidates.length) candidates = fallbackBullets(details).map(cleanBullet)
    notice = uniqueBullets(candidates)
    if (!notice.length) notice = ['Updates are available.']
  }
  const keys = new Set(notice.map((n) => n.toLowerCase()))
  const worth = uniqueBullets(worthRaw).filter((w) => !keys.has(w.toLowerCase()))
  for (const item of worthKnowingBullets(details)) if (!keys.has(item.toLowerCase()) && !worth.some((w) => w.toLowerCase() === item.toLowerCase())) worth.push(item)
  const sections: Dict[] = [{ title: "What you'll notice", items: notice }]
  if (worth.length) sections.push({ title: 'Worth knowing', items: worth })
  const summary = sections.map((s) => [str(s.title), ...(s.items as string[]).map((i) => `- ${i}`), ''].join('\n')).join('\n').trim()
  return [sections, summary]
}
function summaryPrompt(details: Dict[]): [string, string] {
  const system = 'You write human-readable release summaries for Hermes users. Focus on what the user will notice in the product. Keep it simple, specific, and short. avoid technical jargon, implementation details, SHA names, branch names, and file paths unless necessary. Return only bullets. Do not include headings, markdown tables, intro paragraphs, or closing notes.'
  const lines = ['Summarize these available updates as concise bullets.', 'Prefix each bullet with `Notice:` for user-visible behavior changes or `Worth knowing:` for useful context.', 'Put user-visible Notice bullets first and include every meaningful user-facing change from the available commit subjects.', 'Use Worth knowing only for helpful context that is not a duplicate of a Notice bullet.', 'Use everyday language and explain visible behavior changes, not code mechanics.', 'Return only prefixed bullets; the WebUI will add the fixed section headings separately.', '']
  for (const item of details) {
    lines.push(`${str(item.label)}: ${String(item.behind)} commit(s) behind`)
    const commits = item.commits as string[]
    if (commits.length) {
      if (item.commits_truncated) lines.push(`- Showing latest ${String(commits.length)} of ${String(item.behind)} commit subjects; summarize trends, not every commit.`)
      lines.push(...commits.map((c) => `- ${c}`))
    } else lines.push('- No local commit subjects available; summarize only the update count.')
    lines.push('')
  }
  return [system, lines.join('\n')]
}

// ── service ──────────────────────────────────────────────────────────────────

export interface RestartBlockers { active_streams: number; active_runs: number; active_terminals?: number; active_cron_jobs?: number; blocking_stream_ids: string[]; blocking_run_ids: string[]; restart_blocked: boolean }

export interface UpdateServiceDeps {
  /** `web/` of this installation (a Talaria checkout has it at `<root>/web`). */
  webRoot: string
  git?: GitRun
  /** Runs the checkout's npm install/build steps after a source update (default: the npm beside this node). */
  build?: BuildRun
  /** Runs global npm discovery/install for packaged updates. */
  npm?: BuildRun
  getJson: GetJson
  /** The public GHCR Experimental artifact that npm installs follow on the Experimental channel. */
  experimental?: ExperimentalRegistry
  /** Web's state dir; channel switches back up its persisted stores here first. */
  stateDir?: string
  identity: ReleaseIdentity
  webuiVersion: string
  /** Re-derive the installed Web version after a check (tags can arrive after startup); returns the current label. */
  refreshWebuiVersion?: () => string
  agentDir: () => string | null
  channel: () => Channel
  agentChannel?: () => Channel
  includeAgent: () => boolean
  autoApply?: () => boolean
  checkEnabled?: () => boolean
  autoNotification?: {
    begin: () => string
    transition: (id: string, phase: 'restarting' | 'succeeded' | 'blocked' | 'failed', expectedIdentity?: string | null, verifiedIdentity?: { revision: string | null; version: string | null }) => void
  }
  blockers: () => RestartBlockers
  /** Re-exec the server once active work drains (`restartWhenSafe`). */
  scheduleRestart: () => void
  /** Sidecar `gateway.restart` for the active profile. */
  gatewayRestart: () => Promise<Dict>
  /** Optional What's New generator (sidecar `aux.complete`); null keeps the deterministic fallback. */
  llm?: ((system: string, user: string) => Promise<string>) | null
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log: (line: string) => void
}

export class UpdateService {
  private readonly cache: Dict = { webui: null, agent: null, checked_at: 0, include_agent: true, channel: DEFAULT_CHANNEL, agent_channel: DEFAULT_CHANNEL }
  private checking: Promise<Dict> | null = null
  private checkingKey: string | null = null
  private readonly lastGood = new Map<string, { at: number; result: Dict }>()
  private applying = false
  private autoTimer: NodeJS.Timeout | null = null
  private autoStarted = false
  private lifecycle = 0
  private autoRunning = false
  private autoRestartScheduled = false
  private readonly summaries = new Map<string, Dict>()
  private readonly git: GitRun
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: UpdateServiceDeps) {
    this.git = deps.git ?? runGit
    this.now = deps.now ?? (() => Date.now() / 1000)
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  private agentChannel(): Channel { return this.deps.agentChannel?.() ?? DEFAULT_CHANNEL }
  private agentPolicy(confirmedRevision?: string): AgentUpdatePolicy {
    const supported = dict(this.deps.identity.release().compatibleAgent)
    return { supportedRevision: str(supported.sourceRevision), supportedVersion: str(supported.version), ...(confirmedRevision ? { confirmedRevision } : {}) }
  }

  /** Python `cached_update_status`: no network, no git mutations. */
  cachedStatus(includeAgent = this.deps.includeAgent(), channel = this.deps.channel(), agentChannel = this.agentChannel()): Dict {
    const cached: Dict = { ...this.cache }
    if (cached.channel !== channel) { cached.channel = channel; cached.webui = null; cached.stale_channel = true }
    if (cached.agent_channel !== agentChannel) { cached.agent_channel = agentChannel; cached.agent = null; cached.stale_agent_channel = true }
    if (cached.include_agent !== includeAgent) {
      cached.include_agent = includeAgent
      if (!includeAgent) cached.agent = ignoredAgent()
    }
    cached.cached = true
    return cached
  }

  /** 30 min cache keyed on both channels + include_agent; one in-flight check per key. */
  async check(force = false, includeAgent = this.deps.includeAgent(), channel = this.deps.channel(), agentChannel = this.agentChannel()): Promise<Dict> {
    const key = `${channel}:${agentChannel}:${String(includeAgent)}`
    if (this.checking) {
      if (this.checkingKey === key) return this.checking
      await this.checking
      return this.check(force, includeAgent, channel, agentChannel)
    }
    if (this.applying) return this.cachedStatus(includeAgent, channel, agentChannel)
    const matches = this.cache.include_agent === includeAgent && this.cache.channel === channel && this.cache.agent_channel === agentChannel
    if (!force && matches && this.now() - Number(this.cache.checked_at) < CACHE_TTL_S) return { ...this.cache }
    this.checkingKey = key
    this.checking = (async () => {
      try {
        const webui = this.keepLastGood('webui', channel, await checkWebUpdate(this.deps.webRoot, this.deps.webuiVersion, channel, this.git, this.deps.getJson, this.deps.identity, this.deps.npm ?? runPackageNpm, this.deps.experimental))
        // The check may have fetched release tags the startup `git describe` never saw.
        if (this.deps.refreshWebuiVersion) webui.current_version = this.deps.refreshWebuiVersion()
        const agent = includeAgent ? this.keepLastGood('agent', agentChannel, await checkAgentUpdate(this.deps.agentDir(), this.git, agentChannel)) : ignoredAgent()
        if (agent.latest_sha) Object.assign(agent, agentWarning(agent, this.agentPolicy()))
        Object.assign(this.cache, { webui, agent, checked_at: this.now(), include_agent: includeAgent, channel, agent_channel: agentChannel })
        return { ...this.cache }
      } finally {
        this.checking = null
        this.checkingKey = null
      }
    })()
    return this.checking
  }

  /** A failed fetch (`stale_check`) keeps the channel's last good result until the cache TTL, so a network blip never flips the status; persistent failures surface. */
  private keepLastGood(target: 'webui' | 'agent', channel: Channel, result: Dict): Dict {
    const key = `${target}:${channel}`
    if (!result.stale_check) {
      if (!result.error) this.lastGood.set(key, { at: this.now(), result })
      return result
    }
    this.deps.log(`[updates] ${target} fetch failed: ${str(result.error)}`)
    const prior = this.lastGood.get(key)
    return prior && this.now() - prior.at < CACHE_TTL_S ? { ...prior.result, stale_check: true } : result
  }

  startAutoApply(intervalMs = AUTO_UPDATE_INTERVAL_MS): void {
    if (this.autoStarted || this.autoRestartScheduled) return
    this.autoStarted = true
    const lifecycle = this.lifecycle
    const schedule = (delay: number): void => {
      this.autoTimer = setTimeout(() => {
        this.autoTimer = null
        void this.autoApplyOnce().finally(() => { if (this.autoStarted && lifecycle === this.lifecycle && !this.autoRestartScheduled) schedule(intervalMs) })
      }, delay)
      this.autoTimer.unref()
    }
    schedule(0)
  }

  stopAutoApply(): void {
    this.autoStarted = false
    this.lifecycle += 1
    if (this.autoTimer) clearTimeout(this.autoTimer)
    this.autoTimer = null
  }

  /** Shared turn admission stays closed from update start through the supervisor restart. */
  blocksNewWork(): boolean { return this.applying || this.autoRestartScheduled }

  private pendingRestartResponse(target: string): Dict | null {
    if (!this.autoRestartScheduled) return null
    if (target === 'webui') return { ok: true, target, restart_scheduled: true, message: 'A Web restart is already scheduled.' }
    return { ok: false, status: 'already_in_progress', target, message: 'A Talaria Web restart is already scheduled. Wait for the server to restart before updating Hermes Agent.' }
  }

  async autoApplyOnce(): Promise<Dict | null> {
    if (this.autoRunning || this.applying || this.autoRestartScheduled || !(this.deps.checkEnabled?.() ?? this.deps.autoApply?.())) return null
    this.autoRunning = true
    const lifecycle = this.lifecycle
    let notificationId: string | null = null
    try {
      const channel = this.deps.channel()
      const stillEnabled = (): boolean => lifecycle === this.lifecycle && Boolean(this.deps.autoApply?.()) && (this.deps.checkEnabled?.() ?? true) && channel === this.deps.channel()
      const checked = await this.check(true, this.deps.includeAgent(), channel)
      const web = dict(checked.webui)
      if (!stillEnabled()) return web
      if (web.error || web.manual_update) { this.deps.log(`[updates] automatic Web update unavailable: ${str(web.error || web.message)}`); return web }
      if (!(Number(web.behind) > 0 || web.metadata_repair === true)) return web
      notificationId = this.deps.autoNotification?.begin() ?? null
      const result = await this.apply('webui', channel, stillEnabled)
      if (notificationId) {
        if (result.restart_blocked === true) this.deps.autoNotification?.transition(notificationId, 'blocked')
        else if (result.ok !== true) this.deps.autoNotification?.transition(notificationId, 'failed')
        else if (result.restart_scheduled === true) this.deps.autoNotification?.transition(notificationId, 'restarting', str(result.sourceRevision || result.candidate_revision))
        else this.deps.autoNotification?.transition(notificationId, 'succeeded')
      }
      this.deps.log(`[updates] automatic Web update: ${str(result.message || (result.ok ? 'applied' : 'failed'))}`)
      if (!result.ok) this.cache.webui = { ...web, message: result.message, error: result.restart_blocked ? undefined : result.message }
      return result
    } catch (error) {
      if (notificationId) this.deps.autoNotification?.transition(notificationId, 'failed')
      this.deps.log(`[updates] automatic Web update failed: ${(error as Error).message}`)
      return { ok: false, error: (error as Error).message }
    } finally { this.autoRunning = false }
  }

  blockedResponse(target: string): Dict | null {
    const b = this.deps.blockers()
    if (!b.restart_blocked) return null
    const parts: string[] = []
    if (b.active_streams) parts.push(`${String(b.active_streams)} active chat stream${b.active_streams === 1 ? '' : 's'}`)
    if (b.active_runs) parts.push(`${String(b.active_runs)} active agent run${b.active_runs === 1 ? '' : 's'}`)
    if (b.active_terminals) parts.push(`${String(b.active_terminals)} open terminal${b.active_terminals === 1 ? '' : 's'}`)
    if (b.active_cron_jobs) parts.push(`${String(b.active_cron_jobs)} active cron job${b.active_cron_jobs === 1 ? '' : 's'}`)
    return { ok: false, message: `Cannot update ${target} while ${parts.join(' and ') || 'active work'} is running. Wait for work to finish and close open terminals, then retry the update.`, target, ...b }
  }

  private async locked(fn: () => Promise<Dict>): Promise<Dict> {
    if (this.applying) return { ok: false, message: 'Update already in progress' }
    this.applying = true
    try { return await fn() } finally { this.applying = false }
  }

  /** Python `apply_update`. */
  async apply(target: string, channel?: Channel | null, canApply: () => boolean = () => true, agentOptions: AgentUpdateOptions = {}): Promise<Dict> {
    if (this.checking) await this.checking
    const pendingRestart = this.pendingRestartResponse(target)
    if (pendingRestart) return pendingRestart
    if (!canApply()) return { ok: false, message: 'Web update settings changed; update deferred.' }
    const blocked = this.blockedResponse(target)
    if (blocked) return blocked
    const lifecycle = this.lifecycle
    return this.locked(() => this.applyInner(target, channel ?? this.deps.channel(), () => lifecycle === this.lifecycle && canApply(), agentOptions))
  }

  private async applyInner(target: string, channel: Channel, canApply: () => boolean = () => true, agentOptions: AgentUpdateOptions = {}): Promise<Dict> {
    if (target === 'webui') {
      const lifecycle = this.lifecycle
      const result = await applyWebUpdate(this.deps.webRoot, channel, this.git, this.deps.getJson, this.deps.identity, this.deps.build ?? runNpm, this.deps.npm ?? runPackageNpm, canApply, { registry: this.deps.experimental, stateDir: this.deps.stateDir })
      // Settings can cancel before mutation, but a committed replacement must finish restarting unless shutting down.
      if (result.ok && !result.up_to_date && lifecycle === this.lifecycle) { this.cache.checked_at = 0; this.autoRestartScheduled = true; this.stopAutoApply(); this.deps.scheduleRestart(); result.restart_scheduled = true }
      return result
    }
    if (target !== 'agent') return { ok: false, message: `Unknown target: ${target}` }
    const result = await applyAgentUpdate(this.deps.agentDir(), this.git, agentOptions.agentChannel ?? this.agentChannel(), this.agentPolicy(agentOptions.confirmedRevision))
    if (!result.ok || result.up_to_date) return result
    return this.finishAgent(result)
  }

  private async finishAgent(result: Dict): Promise<Dict> {
    this.cache.checked_at = 0
    const [ok, gateway] = await this.restartGateway()
    if (!ok) return { ok: false, message: gateway.message ? `agent updated, but gateway restart did not complete: ${str(gateway.message)}. Run \`hermes gateway restart\` manually.` : 'agent updated, but gateway restart did not complete. Run `hermes gateway restart` manually.', target: 'agent', gateway_restart: gateway.status }
    this.deps.scheduleRestart()
    return { ...result, restart_scheduled: true, gateway_restart: gateway.status }
  }

  /** Python `_ensure_gateway_restart_for_agent_update`: retry once after a transient supervisor handoff failure. */
  private async restartGateway(): Promise<[boolean, Dict]> {
    const attempt = async (): Promise<Dict> => { try { return await this.deps.gatewayRestart() } catch (error) { return { status: 'failed', message: (error as Error).message } } }
    const first = await attempt()
    const status = str(first.status)
    if (status === 'completed' || status === 'in_progress') return [true, first]
    if (status !== 'failed') return [false, first]
    await this.sleep(1000)
    const retry = await attempt()
    const retryStatus = str(retry.status)
    const annotated = { ...retry, retry_attempted: true, initial_failure: first.message }
    if (retryStatus === 'completed' || retryStatus === 'in_progress') return [true, annotated]
    if (retryStatus !== 'failed') return [false, annotated]
    return [false, { ...annotated, message: `${str(first.message) || 'Restart failed'}; recovery retry did not complete: ${str(retry.message) || 'retry did not complete'}` }]
  }

  /** Python `apply_force_update`: Web keeps its clean-only policy; the Agent resets hard. */
  async force(target: string, channel?: Channel | null, agentOptions: AgentUpdateOptions = {}): Promise<Dict> {
    if (this.checking) await this.checking
    if (target === 'webui') return this.apply(target, channel)
    const pendingRestart = this.pendingRestartResponse(target)
    if (pendingRestart) return pendingRestart
    const blocked = this.blockedResponse(target)
    if (blocked) return Promise.resolve(blocked)
    return this.locked(async () => {
      if (target !== 'agent') return { ok: false, message: `Unknown target: ${target}` }
      const result = await forceAgentUpdate(this.deps.agentDir(), this.git, this.deps.log, agentOptions.agentChannel ?? this.agentChannel(), this.agentPolicy(agentOptions.confirmedRevision))
      return result.ok ? this.finishAgent(result) : result
    })
  }

  /** Python `apply_clear_lock`: never removes a lock; Web retries the clean path, the Agent gets the manual command. */
  clearLock(target: string, agentOptions: AgentUpdateOptions = {}): Promise<Dict> {
    if (target === 'webui') return this.apply(target).then((r) => ({ ...r, lock_recovery: { action: 'retry-only' } }))
    const pendingRestart = this.pendingRestartResponse(target)
    if (pendingRestart) return Promise.resolve(pendingRestart)
    const blocked = this.blockedResponse(target)
    if (blocked) return Promise.resolve(blocked)
    return this.locked(async () => {
      if (target !== 'agent') return { ok: false, message: `Unknown target: ${target}` }
      const path = this.deps.agentDir()
      if (!path || !existsSync(join(path, '.git'))) return { ok: false, message: 'Not a git repository' }
      const inv = inventoryLocks(path)
      const manual = `rm -f ${str(inv.well_known_lock_path)}`
      if (!inv.well_known_lock_present) {
        this.cache.checked_at = 0
        const retry = await this.applyInner(target, this.deps.channel(), () => true, agentOptions)
        return { ...retry, lock_recovery: { action: 'no-lock-found', manual_command: manual, other_locks: inv.other_locks } }
      }
      return { ok: false, message: `A git lock file (.git/index.lock) is present. The server does not delete locks automatically -- git uses O_CREAT|O_EXCL locking, which cannot be detected with advisory probes. To recover: confirm no other git process is running against this checkout, then run: ${manual}  Click "Retry update" once you have removed it.`, lock_held: true, target, manual_command: manual, well_known_lock_path: inv.well_known_lock_path, other_locks: inv.other_locks }
    })
  }

  /** Python `_commit_subjects_for_update_with_limit`. */
  private async commitSubjects(target: string, info: Dict, limit = 24): Promise<[string[], boolean]> {
    const path = target === 'webui' ? await checkoutRoot(this.deps.webRoot, this.git) : this.deps.agentDir()
    const current = str(info.current_sha).trim()
    const latest = str(info.latest_sha).trim()
    if (!path || !current || !latest) return [[], false]
    const args = ['log', '--format=%s', `${current}..${latest}`, `-n${String(limit + 1)}`]
    if (target === 'webui' && info.channel === 'experimental') args.push('--', ...WEB_UPDATE_PATHS)
    const out = await this.git(args, path, 5000)
    if (!out.ok || !out.out) return [[], false]
    const subjects = out.out.split('\n').map((l) => l.trim()).filter(Boolean)
    return [subjects.slice(0, limit), subjects.length > limit]
  }

  /** Python `summarize_update_payload`: What's New sections, LLM when available, cached per exact range. */
  async summarize(updates: Dict, targetRaw: unknown): Promise<Dict> {
    const target = targetRaw === 'webui' || targetRaw === 'agent' ? targetRaw : null
    const details: Dict[] = []
    for (const [key, label] of [['webui', 'WebUI'], ['agent', 'Agent']] as const) {
      if (target && key !== target) continue
      const info = updates[key]
      if (!info || typeof info !== 'object' || Array.isArray(info)) continue
      const behind = Number.parseInt(str((info as Dict).behind ?? 0), 10) || 0
      if (behind <= 0) continue
      const [commits, truncated] = await this.commitSubjects(key, info as Dict)
      details.push({ name: key, label, behind, current_sha: (info as Dict).current_sha ?? null, latest_sha: (info as Dict).latest_sha ?? null, compare_url: (info as Dict).compare_url ?? null, commits, commits_limit: 24, commits_truncated: truncated || (commits.length > 0 && behind > commits.length) })
    }
    const cacheKey = createHash('sha256').update(JSON.stringify(details.map((d) => sortKeys({ name: d.name, behind: d.behind, current_sha: d.current_sha, latest_sha: d.latest_sha, compare_url: d.compare_url, commits: d.commits })))).digest('hex')
    const cached = this.summaries.get(cacheKey)
    if (cached) { this.summaries.delete(cacheKey); this.summaries.set(cacheKey, cached); return { ...cached, cached: true } }
    let generatedBy = 'fallback'
    let candidate = ''
    if (details.length && this.deps.llm) {
      const [system, user] = summaryPrompt(details)
      try { candidate = (await this.deps.llm(system, user)).trim(); if (candidate) generatedBy = 'llm' } catch { candidate = '' }
    }
    const [sections, summary] = formatSections(candidate, details)
    const result: Dict = { ok: true, summary, summary_sections: sections, generated_by: generatedBy, cached: false, cache_key: cacheKey, target, targets: details }
    if (this.summaries.size >= 16) this.summaries.delete(this.summaries.keys().next().value!)
    this.summaries.set(cacheKey, result)
    return result
  }
}

const ignoredAgent = (): Dict => ({ name: 'agent', behind: 0, ignored: true })

/** Python `_wait_until_restart_safe`: poll until no chat work is active, bounded so a stuck run cannot jam the update forever. */
export async function waitUntilRestartSafe(blockers: () => RestartBlockers, opts: { pollMs?: number; maxWaitMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; log?: (line: string) => void } = {}): Promise<RestartBlockers & { wait_timed_out?: boolean }> {
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const deadline = now() + (opts.maxWaitMs ?? RESTART_MAX_WAIT_S * 1000)
  let snapshot = blockers()
  while (snapshot.restart_blocked) {
    if (now() >= deadline) { opts.log?.(`[updates] restart-safety wait exceeded ${String((opts.maxWaitMs ?? RESTART_MAX_WAIT_S * 1000) / 1000)}s with work still in flight; proceeding with restart`); return { ...snapshot, wait_timed_out: true } }
    await sleep(Math.max(100, opts.pollMs ?? 2000))
    snapshot = blockers()
  }
  return snapshot
}
