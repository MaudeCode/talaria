import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
// The registry and global prefix are disposable fixtures, independent of the CI host's container markers.
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, existsSync: (path: import('node:fs').PathLike) => ['/run/.containerenv', '/.dockerenv', '/.within_container'].includes(String(path)) ? false : fs.existsSync(path) }
})
import { applyWebUpdate, runGit, runPackageNpm, type BuildRun, type GetJson } from './updates.js'

it('uses real npm to stage a global replacement with its dependencies while preserving the existing bin links', async () => {
  const root = mkdtempSync(join(tmpdir(), 'talaria-npm-update-'))
  const registry = createServer()
  try {
    const pin = { 'x-talaria': { version: '1.0.0', sourceRevision: 'a'.repeat(40) }, services: { 'hermes-agent': { image: `docker.io/nousresearch/hermes-agent@sha256:${'b'.repeat(64)}` } } }
    const versions = { appWeb: { fixtureVersion: 1 }, webRelay: { protocolVersion: 2 } }
    const release = { tag: 'web-v2.0.0', version: '2.0.0', sourceRevision: 'c'.repeat(40), releaseSet: 'c'.repeat(40), contracts: { appWeb: [1], webRelay: [2] }, compatibleAgent: { ...pin['x-talaria'], image: pin.services['hermes-agent'].image } }
    const write = (path: string, value: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, value) }
    function pack(name: string, version: string): Buffer {
      const folder = join(root, `${name.split('/').pop() ?? name}-${version}`)
      const server = name === '@maudecode/talaria-web'
      const metadata = { name, version, type: 'module', ...(server ? { bin: { 'talaria-web': 'dist/bin/talaria-web.js', 'talaria-web-mcp': 'dist/bin/talaria-web-mcp.js' }, dependencies: { 'synthetic-update-dep': '1.0.0' } } : { exports: './index.js' }) }
      write(join(folder, 'package/package.json'), JSON.stringify(metadata))
      if (server) {
        write(join(folder, 'package/sidecar/agent_dependency.json'), JSON.stringify(pin))
        write(join(folder, 'package/contract_versions.json'), JSON.stringify(versions))
        if (version === '2.0.0') write(join(folder, 'package/_release.json'), JSON.stringify(release))
        for (const bin of ['talaria-web', 'talaria-web-mcp']) write(join(folder, `package/dist/bin/${bin}.js`), `#!/usr/bin/env node\nimport value from 'synthetic-update-dep'; console.log('${version} ' + value)\n`)
      } else write(join(folder, 'package/index.js'), "export default 'dependency-loaded'\n")
      execFileSync('tar', ['-czf', join(folder, 'package.tgz'), '-C', folder, 'package'], { stdio: 'pipe' })
      return readFileSync(join(folder, 'package.tgz'))
    }
    const packages = new Map([
      ['@maudecode/talaria-web', new Map([['1.0.0', pack('@maudecode/talaria-web', '1.0.0')], ['2.0.0', pack('@maudecode/talaria-web', '2.0.0')]])],
      ['synthetic-update-dep', new Map([['1.0.0', pack('synthetic-update-dep', '1.0.0')]])],
    ])
    await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve))
    const address = registry.address()
    if (!address || typeof address === 'string') throw new Error('missing registry port')
    const origin = `http://127.0.0.1:${String(address.port)}`
    registry.on('request', (req, res) => {
      const path = decodeURIComponent((req.url ?? '').slice(1))
      if (path.startsWith('tar/')) {
        const match = /^(.*)@([0-9.]+)$/.exec(path.slice(4))
        const bytes = match ? packages.get(match[1]!)?.get(match[2]!) : undefined
        if (bytes) { res.end(bytes); return }
      }
      const versions = packages.get(path)
      if (!versions) { res.writeHead(404); res.end('{}'); return }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ name: path, 'dist-tags': { latest: [...versions.keys()].at(-1) }, versions: Object.fromEntries([...versions].map(([version, bytes]) => [version, {
        name: path, version, ...(path === '@maudecode/talaria-web' ? { bin: { 'talaria-web': 'dist/bin/talaria-web.js', 'talaria-web-mcp': 'dist/bin/talaria-web-mcp.js' }, dependencies: { 'synthetic-update-dep': '1.0.0' } } : {}),
        dist: { tarball: `${origin}/tar/${encodeURIComponent(path)}@${version}`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` },
      }])) }))
    })
    const prefix = join(root, 'prefix')
    const run: BuildRun = (args, cwd, timeout) => runPackageNpm([...args, '--registry', origin, '--cache', join(root, 'cache'), '--userconfig', '/dev/null', '--ignore-scripts'], cwd, timeout)
    const initial = await run(['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', '@maudecode/talaria-web@1.0.0'], root, 20_000)
    expect(initial.ok, initial.out).toBe(true)
    const packageRoot = join(prefix, 'lib/node_modules/@maudecode/talaria-web')
    const npm: BuildRun = (args, cwd, timeout) => run(args[0] === 'root' ? [...args, '--prefix', prefix] : args, cwd, timeout)
    const getJson: GetJson = (_path, { asset }) => Promise.resolve(asset ? {
      schemaVersion: 1, status: 'complete', releaseSet: release.sourceRevision,
      components: { web: { ...release, npm: '@maudecode/talaria-web@2.0.0', image: `ghcr.io/maudecode/talaria-web@sha256:${'d'.repeat(64)}` } },
      contracts: { appWeb: { web: [1] }, webRelay: { web: [2] } }, agent: release.compatibleAgent,
    } : [{ tag_name: `release-set-${release.sourceRevision}`, published_at: '2026-01-01', assets: [{ name: 'release-set.json', id: 1 }] }])
    const id = { release: () => ({}), stamped: () => ({}), runningSourceRevision: () => null }
    expect(await applyWebUpdate(packageRoot, 'stable', runGit, getJson, id, npm)).toMatchObject({ ok: true })
    for (const bin of ['talaria-web', 'talaria-web-mcp']) {
      expect(execFileSync(process.execPath, [join(prefix, 'bin', bin)], { encoding: 'utf8' }).trim()).toBe('2.0.0 dependency-loaded')
    }
  } finally {
    registry.closeAllConnections()
    await new Promise<void>((resolve) => { registry.close(() => { resolve() }) })
    rmSync(root, { recursive: true, force: true })
  }
}, 45_000)
