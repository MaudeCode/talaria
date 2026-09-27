/**
 * Release identity: the stamped `<webRoot>/_release.json` (written by
 * `scripts/stamp-release.py`), the sidecar Agent pin, supported contract versions
 * (`<webRoot>/contract_versions.json`), and the process-lifetime version string.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { ReleaseInfoSchema, type ReleaseInfo } from '@maudecode/talaria-web-contracts'

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

/** `-dirty-<sha1(diff)[:8]>` for a modified checkout (content-derived, so it stays a valid cache fingerprint), else ``. */
function dirtySuffix(webRoot: string): string {
  try {
    execFileSync('git', ['-C', webRoot, 'diff-index', '--quiet', 'HEAD', '--'], { stdio: 'ignore', timeout: 1000 })
    return ''
  } catch (error) {
    if ((error as { status?: number }).status !== 1) return ''
  }
  try {
    const diff = execFileSync('git', ['-C', webRoot, 'diff', '--binary', 'HEAD', '--'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000, maxBuffer: 64 * 1024 * 1024 })
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
