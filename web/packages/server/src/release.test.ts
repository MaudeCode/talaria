import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReleaseInfo, WhatsNewAnnouncement } from '@maudecode/talaria-web-contracts'
import { compatibleAgent, detectWebuiVersion, developmentInfo, loadReleaseInfo, loadWhatsNew, supportedAgents, validateReleaseInfo, whatsNewState } from './release.js'
import { bootTestServer, WEB_ROOT } from './test/harness.js'
import { readFileSync } from 'node:fs'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('release info', () => {
  it('versions changed Web content without scanning unrelated components or marking timestamp-only rewrites dirty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'talaria-version-'))
    dirs.push(dir)
    const web = join(dir, 'web')
    mkdirSync(web)
    mkdirSync(join(dir, 'app'))
    const file = join(web, 'index.js')
    writeFileSync(file, 'original\n')
    writeFileSync(join(dir, 'app', 'unrelated.swift'), 'original\n')
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' })
    git('init', '-q')
    git('add', '.')
    git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')
    git('tag', 'web-v9.8.7')
    const dev = developmentInfo(WEB_ROOT)
    const indexPath = join(dir, '.git', 'index')
    const index = readFileSync(indexPath)
    // Build generators can rewrite identical bytes, leaving the index's stat cache stale.
    utimesSync(file, 2_000_000_000, 2_000_000_000)
    utimesSync(join(dir, 'app', 'unrelated.swift'), 2_000_000_000, 2_000_000_000)
    expect(detectWebuiVersion(dev, web)).toBe('web-v9.8.7')
    expect(readFileSync(indexPath)).toEqual(index)
    writeFileSync(join(dir, 'app', 'unrelated.swift'), 'unrelated change\n')
    expect(detectWebuiVersion(dev, web)).toBe('web-v9.8.7')
    writeFileSync(file, 'changed\n')
    const changed = detectWebuiVersion(dev, web)
    expect(changed).toMatch(/^web-v9\.8\.7-dirty-[a-f0-9]{8}$/)
    writeFileSync(join(dir, 'app', 'unrelated.swift'), 'another unrelated change\n')
    expect(detectWebuiVersion(dev, web)).toBe(changed)
    writeFileSync(file, 'changed again\n')
    expect(detectWebuiVersion(dev, web)).not.toBe(changed)
    expect(readFileSync(indexPath)).toEqual(index)
  })

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

  it('reads the verified Agent window, which holds the pin', () => {
    const window = supportedAgents(WEB_ROOT)
    expect(window.length).toBeGreaterThan(0)
    expect(window.map((agent) => agent.sourceRevision)).toContain(compatibleAgent(WEB_ROOT).sourceRevision)
    expect(supportedAgents(join(WEB_ROOT, 'missing'))).toEqual([])
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

describe("What's New (TAL-1616)", () => {
  const fixture = JSON.parse(readFileSync(join(WEB_ROOT, '../contracts/fixtures/whats-new.json'), 'utf8')) as { web: WhatsNewAnnouncement; app: WhatsNewAnnouncement; state: unknown; invalid: unknown[] }
  const stamped = (version: string): ReleaseInfo => ({ ...developmentInfo(WEB_ROOT), tag: `web-v${version}`, version, sourceRevision: fixture.web.sourceCommit, releaseSet: fixture.web.sourceCommit })
  const build = 'b'.repeat(64)
  const announcement = fixture.web
  const state = (release: ReleaseInfo, observed: string | undefined, loaded: string | undefined = build, current: string | null = build, payload: WhatsNewAnnouncement | null = announcement) => whatsNewState(payload, release, observed, loaded, current)

  it('is quiet on first observation, presents a later release once, and stays quiet once acknowledged', () => {
    const release = stamped('1.1.0')
    const quiet = { announcement, eligible: false, observation: 'web:1.1.0', acknowledgement: null }
    expect(state(release, undefined)).toEqual(quiet)
    const eligible = state(release, 'web:1.0.9')
    expect(eligible).toEqual(fixture.state)
    // Until the user dismisses it, nothing is recorded: a failed or unseen read leaves the stored token unchanged.
    expect(state(release, 'web:1.0.9')).toEqual(eligible)
    expect(state(release, eligible.acknowledgement!)).toEqual(quiet)
    expect(state(release, 'web:0.12.0').eligible).toBe(true)
  })

  it('keeps build-only, older, unannounced and App observations quiet', () => {
    expect(state(stamped(`1.1.0-exp.${'c'.repeat(12)}`), 'web:1.1.0')).toEqual({ announcement, eligible: false, observation: 'web:1.1.0', acknowledgement: null })
    expect(state(stamped('1.1.0'), 'web:1.2.0')).toMatchObject({ eligible: false, observation: 'web:1.1.0' })
    expect(state(stamped('1.1.0'), 'web:1.0.0', build, build, null)).toEqual({ announcement: null, eligible: false, observation: 'web:1.1.0', acknowledgement: null })
    for (const observed of ['app:1.0.0', 'web:1.0', 'web:01.0.0', 'web:1.0.0 ', '{"version":"1.0.0"}', 'x'.repeat(256)]) {
      expect(state(stamped('1.1.0'), observed), observed).toEqual({ announcement, eligible: false, observation: 'web:1.1.0', acknowledgement: null })
    }
  })

  it('never presents or records a release for a stale, unverifiable or development UI', () => {
    const silent = { announcement, eligible: false, observation: null, acknowledgement: null }
    for (const [loaded, current] of [['a'.repeat(64), build], [undefined, build], [build, null]] as const) {
      expect(whatsNewState(announcement, stamped('1.1.0'), 'web:1.0.0', loaded, current)).toEqual(silent)
      expect(whatsNewState(announcement, stamped('1.1.0'), undefined, loaded, current)).toEqual(silent)
    }
    expect(state(developmentInfo(WEB_ROOT), 'web:1.0.0')).toEqual(silent)
  })

  it('serves only a valid payload generated for the installed Web release', () => {
    const dir = mkdtempSync(join(tmpdir(), 'talaria-whats-new-'))
    dirs.push(dir)
    const write = (value: unknown) => { writeFileSync(join(dir, '_whats_new.json'), typeof value === 'string' ? value : JSON.stringify(value)) }
    expect(loadWhatsNew(dir, stamped('1.1.0'))).toBeNull()
    write(announcement)
    expect(loadWhatsNew(dir, stamped('1.1.0'))).toEqual(announcement)
    expect(loadWhatsNew(dir, stamped('1.2.0'))).toBeNull()
    expect(loadWhatsNew(dir, { ...stamped('1.1.0'), sourceRevision: 'd'.repeat(40), releaseSet: 'd'.repeat(40) })).toBeNull()
    expect(loadWhatsNew(dir, { ...developmentInfo(WEB_ROOT), version: '1.1.0' })).toBeNull()
    write({ ...fixture.app, version: '1.1.0' })
    expect(loadWhatsNew(dir, stamped('1.1.0'))).toBeNull()
    for (const invalid of [...fixture.invalid, '{', '']) {
      write(invalid)
      expect(loadWhatsNew(dir, stamped('1.1.0'))).toBeNull()
    }
  })

  it('answers the shared fixture over HTTP from the loaded build and stored token, without changing release identity', async () => {
    const s = await bootTestServer({ deps: (deps) => { deps.release = stamped('1.1.0'); deps.whatsNew = announcement; deps.spa.buildId = () => build } })
    try {
      const read = async (query: string) => s.get(`/api/whats-new${query}`)
      const res = await read(`?loaded_build=${build}&observed=web:1.0.0`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(fixture.state)
      expect(await (await read(`?loaded_build=${'a'.repeat(64)}&observed=web:1.0.0`)).json()).toMatchObject({ eligible: false, observation: null })
      expect((await read(`?loaded_build=not-a-build`)).status).toBe(400)
      expect((await read(`?loaded_build=${build}&observed=${'x'.repeat(257)}`)).status).toBe(400)
      expect(s.deps.release).toEqual(stamped('1.1.0'))
    } finally {
      await s.close()
    }
  })
})
