/**
 * Release identity: the stamped `<webRoot>/_release.json` (written by
 * `scripts/stamp-release.py`), the sidecar Agent pin, supported contract versions
 * (`<webRoot>/contract_versions.json`), the process-lifetime version string, and the
 * installed release's What's New announcement (`<webRoot>/_whats_new.json`, TAL-1616).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { ReleaseInfoSchema, WhatsNewAnnouncementSchema, type ReleaseInfo, type WhatsNewAnnouncement, type WhatsNewState } from '@maudecode/talaria-web-contracts'

const SHA_RE = /^[a-f0-9]{40}$/

export interface ReleaseSources {
  /** `web/` root (or the installed package root): owns `sidecar/agent_dependency.json` and `contract_versions.json`. */
  webRoot: string
  releaseFile?: string
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

export function compatibleAgent(webRoot: string): ReleaseInfo['compatibleAgent'] {
  const agent = readJson(resolve(webRoot, 'sidecar', 'agent_dependency.json'))
  const x = agent['x-talaria'] as Record<string, unknown>
  const services = agent.services as Record<string, Record<string, unknown>>
  return { ...x, image: services['hermes-agent']?.image } as ReleaseInfo['compatibleAgent']
}

export interface SupportedAgent { releaseTag: string; version: string; sourceRevision: string }

/** TAL-349's verified Agent window (`sidecar/agent_support.json`); a missing, unreadable or invalid record proves nothing, so it is empty. */
export function supportedAgents(webRoot: string): SupportedAgent[] {
  try {
    const releases = readJson(resolve(webRoot, 'sidecar', 'agent_support.json')).releases
    if (!Array.isArray(releases)) return []
    const records = releases.map((r: Record<string, unknown>) => ({ releaseTag: r.releaseTag, version: r.version, sourceRevision: r.sourceRevision }))
    return records.every((r) => typeof r.releaseTag === 'string' && r.releaseTag !== '' && typeof r.version === 'string' && r.version !== '' && typeof r.sourceRevision === 'string' && SHA_RE.test(r.sourceRevision))
      ? records as SupportedAgent[] : []
  } catch {
    return []
  }
}

export function supportedContracts(webRoot: string): ReleaseInfo['contracts'] {
  const c = readJson(resolve(webRoot, 'contract_versions.json')) as Record<string, Record<string, number>>
  return { appWeb: [c.appWeb?.fixtureVersion ?? 0], webRelay: [c.webRelay?.protocolVersion ?? 0] }
}

export function developmentInfo(webRoot: string): ReleaseInfo {
  return { tag: null, version: 'development', sourceRevision: null, releaseSet: null, contracts: supportedContracts(webRoot), compatibleAgent: compatibleAgent(webRoot) }
}

export function validateReleaseInfo(metadata: unknown, webRoot: string): ReleaseInfo {
  const fields = ['tag', 'version', 'sourceRevision', 'releaseSet', 'contracts', 'compatibleAgent']
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid Web release metadata fields')
  const m = metadata as Record<string, unknown>
  const keys = Object.keys(m).sort()
  if (keys.join(',') !== [...fields].sort().join(',')) throw new Error('Invalid Web release metadata fields')
  for (const key of ['sourceRevision', 'releaseSet']) {
    if (typeof m[key] !== 'string' || !SHA_RE.test(m[key])) throw new Error(`Web ${key} must be an immutable commit`)
  }
  if (m.sourceRevision !== m.releaseSet) throw new Error('Web release-set identity must match its source')
  // An Experimental package is `X.Y.Z-exp.<12-hex source>` under a web-exp tag (TAL-343).
  const experimental = typeof m.version === 'string' && typeof m.tag === 'string' && m.tag.startsWith('web-exp-v') && m.version.endsWith(`-exp.${String(m.sourceRevision).slice(0, 12)}`)
  if (typeof m.version !== 'string' || !(experimental ? /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-exp\.[a-f0-9]{12}$/ : /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/).test(m.version)) throw new Error('Web release version must be X.Y.Z')
  if (m.tag !== `web-v${m.version}` && m.tag !== `web-exp-v${m.version}`) throw new Error('Web release tag must match its namespaced version')
  if (JSON.stringify(m.contracts) !== JSON.stringify(supportedContracts(webRoot)) || JSON.stringify(m.compatibleAgent) !== JSON.stringify(compatibleAgent(webRoot))) {
    throw new Error('Web release metadata disagrees with its packaged contracts or Agent pin')
  }
  return ReleaseInfoSchema.parse(m)
}

export function checkoutRevision(root: string): string | null {
  try {
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim()
    return SHA_RE.test(head) ? head : null
  } catch {
    return null
  }
}

export function loadReleaseInfo(sources: ReleaseSources, opts: { verifyCheckout?: boolean } = {}): ReleaseInfo {
  const file = sources.releaseFile ?? resolve(sources.webRoot, '_release.json')
  let metadata: ReleaseInfo
  try {
    metadata = validateReleaseInfo(readJson(file), sources.webRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return developmentInfo(sources.webRoot)
    throw error
  }
  const webRoot = dirname(file)
  const markers = [resolve(webRoot, '.git'), resolve(webRoot, '..', '.git')]
  if ((opts.verifyCheckout ?? true) && markers.some((m) => existsSync(m)) && checkoutRevision(webRoot) !== metadata.sourceRevision) {
    return developmentInfo(sources.webRoot)
  }
  return metadata
}

/** `-dirty-<sha1(diff)[:8]>` for changed Web content (a cache fingerprint), else ``. */
function dirtySuffix(webRoot: string): string {
  // A version lookup must not refresh the whole Git index behind a Web-only pathspec.
  const gitDiff = ['-C', webRoot, '-c', 'diff.autoRefreshIndex=false', 'diff']
  try {
    execFileSync('git', [...gitDiff, '--quiet', 'HEAD', '--', '.'], { stdio: 'ignore', timeout: 1000 })
    return ''
  } catch (error) {
    if ((error as { status?: number }).status !== 1) return ''
  }
  try {
    const diff = execFileSync('git', [...gitDiff, '--binary', 'HEAD', '--', '.'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000, maxBuffer: 64 * 1024 * 1024 })
    if (diff) return `-dirty-${createHash('sha1').update(diff, 'utf8').digest('hex').slice(0, 8)}`
  } catch {
    /* fall through */
  }
  return '-dirty'
}

/** Stamped tag, else a `web-v*` git describe, else the package version, else `unknown`. */
export function detectWebuiVersion(release: ReleaseInfo, webRoot: string, packageVersion?: string): string {
  if (release.tag) return release.tag
  try {
    const out = execFileSync(
      'git',
      ['-C', webRoot, 'describe', '--tags', '--always', '--abbrev=7', '--match', 'web-v[0-9]*', '--match', 'web-exp-v[0-9]*'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 },
    ).trim()
    if (out) return out + dirtySuffix(webRoot)
  } catch {
    /* not a checkout */
  }
  if (packageVersion && packageVersion !== '0.0.0') return packageVersion.startsWith('web-') ? packageVersion : `web-v${packageVersion}`
  return 'unknown'
}

/**
 * The installed release's What's New announcement, or null: absent, malformed, or generated for another component,
 * version or source than the release this server runs. A bad payload stays quiet rather than failing startup.
 */
export function loadWhatsNew(webRoot: string, release: ReleaseInfo): WhatsNewAnnouncement | null {
  try {
    const parsed = WhatsNewAnnouncementSchema.safeParse(readJson(resolve(webRoot, '_whats_new.json')))
    const announcement = parsed.success ? parsed.data : null
    return announcement?.component === 'web' && release.sourceRevision !== null && announcement.version === release.version
      && announcement.sourceCommit === release.sourceRevision ? announcement : null
  } catch {
    return null
  }
}

const OBSERVATION_RE = /^web:(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const CORE_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-|$)/

/**
 * Whether one tab presents `announcement` now (TAL-1616). A browser's observation token names the X.Y.Z release it
 * last recorded: the first observation is quiet, and an announcement is eligible once for a later X.Y.Z. Builds of
 * one X.Y.Z (Experimental commits) and older releases are quiet, and an older release keeps the newer token. A tab whose loaded bundle is not the build this
 * server serves (a stale UI, or no verifiable build) neither presents nor records a release; an unreadable token
 * counts as no observation. `observed` is compared, never trusted as release identity.
 */
export function whatsNewState(announcement: WhatsNewAnnouncement | null, release: ReleaseInfo, observed: string | undefined, loadedBuild: string | undefined, currentBuild: string | null): WhatsNewState {
  const quiet = { announcement, eligible: false, observation: null, acknowledgement: null }
  const installed = release.sourceRevision === null ? null : CORE_RE.exec(release.version)
  if (!installed || !currentBuild || loadedBuild !== currentBuild) return quiet
  const token = `web:${installed[1]}.${installed[2]}.${installed[3]}`
  const prior = OBSERVATION_RE.exec(observed ?? '')
  const order = prior === null ? 1 : Math.sign([1, 2, 3].map((i) => Number(installed[i]) - Number(prior[i])).find((d) => d !== 0) ?? 0)
  if (announcement && prior !== null && order > 0) return { ...quiet, eligible: true, acknowledgement: token }
  // An older release keeps the newer token, so a rollback never re-presents a release the browser already recorded.
  return order < 0 ? quiet : { ...quiet, observation: token }
}
