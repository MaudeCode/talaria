import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compatibleAgent, developmentInfo, loadReleaseInfo, validateReleaseInfo } from './release.js'
import { WEB_ROOT } from './test/harness.js'
import { readFileSync } from 'node:fs'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('release info', () => {
  it('packages the same contract versions the monorepo publishes (contracts/versions.json)', () => {
    const shared = JSON.parse(readFileSync(join(WEB_ROOT, '..', 'contracts', 'versions.json'), 'utf8')) as Record<string, Record<string, number>>
    const packaged = JSON.parse(readFileSync(join(WEB_ROOT, 'contract_versions.json'), 'utf8')) as Record<string, Record<string, number>>
    expect(packaged.appWeb?.fixtureVersion).toBe(shared.appWeb?.fixtureVersion)
    expect(packaged.webRelay?.protocolVersion).toBe(shared.webRelay?.protocolVersion)
  })

  it('reports a development checkout when no stamp exists, with the sidecar Agent pin', () => {
    const info = loadReleaseInfo({ webRoot: WEB_ROOT })
    expect(info.version).toBe('development')
    expect(info.tag).toBeNull()
    expect(info.compatibleAgent.sourceRevision).toMatch(/^[a-f0-9]{40}$/)
    expect(info.compatibleAgent.image).toContain('hermes')
    expect(info.contracts.appWeb).toEqual([1])
  })

  it('validates a stamp the way api/release_info.py does', () => {
    const sha = 'a'.repeat(40)
    const dev = developmentInfo(WEB_ROOT)
    const good = { tag: 'web-v1.2.3', version: '1.2.3', sourceRevision: sha, releaseSet: sha, contracts: dev.contracts, compatibleAgent: compatibleAgent(WEB_ROOT) }
    expect(validateReleaseInfo(good, WEB_ROOT).tag).toBe('web-v1.2.3')
    expect(validateReleaseInfo({ ...good, tag: 'web-exp-v1.2.3' }, WEB_ROOT).tag).toBe('web-exp-v1.2.3')
    expect(() => validateReleaseInfo({ ...good, tag: 'app-v1.2.3' }, WEB_ROOT)).toThrow('namespaced version')
    expect(() => validateReleaseInfo({ ...good, releaseSet: 'b'.repeat(40) }, WEB_ROOT)).toThrow('release-set identity')
    expect(() => validateReleaseInfo({ ...good, version: '1.2' }, WEB_ROOT)).toThrow('X.Y.Z')
    const exp = `1.2.3-exp.${good.sourceRevision.slice(0, 12)}`
    expect(validateReleaseInfo({ ...good, version: exp, tag: `web-exp-v${exp}` }, WEB_ROOT).version).toBe(exp)
    expect(() => validateReleaseInfo({ ...good, version: exp, tag: `web-v${exp}` }, WEB_ROOT)).toThrow('X.Y.Z')
    expect(() => validateReleaseInfo({ ...good, version: '1.2.3-exp.bbbbbbbbbbbb', tag: 'web-exp-v1.2.3-exp.bbbbbbbbbbbb' }, WEB_ROOT)).toThrow('X.Y.Z')
    expect(() => validateReleaseInfo({ ...good, extra: 1 }, WEB_ROOT)).toThrow('metadata fields')
    expect(() => validateReleaseInfo({ ...good, compatibleAgent: { ...good.compatibleAgent, version: '0.0.0' } }, WEB_ROOT)).toThrow('Agent pin')
  })

  it('falls back to development info when the stamp disagrees with the checkout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'talaria-release-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'web'))
    const sha = 'c'.repeat(40)
    const dev = developmentInfo(WEB_ROOT)
    const stamp = join(dir, 'web', '_release.json')
    writeFileSync(stamp, JSON.stringify({ tag: 'web-v9.9.9', version: '9.9.9', sourceRevision: sha, releaseSet: sha, contracts: dev.contracts, compatibleAgent: dev.compatibleAgent }))
    expect(loadReleaseInfo({ webRoot: WEB_ROOT, releaseFile: stamp }, { verifyCheckout: false }).tag).toBe('web-v9.9.9')
    // The temp dir has no .git marker, so the stamp is trusted as-is.
    expect(loadReleaseInfo({ webRoot: WEB_ROOT, releaseFile: stamp }).tag).toBe('web-v9.9.9')
    // A checkout marker with a different HEAD demotes it to development.
    writeFileSync(join(dir, '.git'), '')
    try {
      expect(loadReleaseInfo({ webRoot: WEB_ROOT, releaseFile: stamp }).version).toBe('development')
    } finally {
      rmSync(join(dir, '.git'), { force: true })
    }
  })
})
