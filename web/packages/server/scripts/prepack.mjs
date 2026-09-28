// `npm pack` / `npm publish`: copy the runtime trees the bins resolve through the Web root
// (license, built frontend bundle, sidecar package and scripts, contract metadata, release stamp)
// into the package so a global install is self-contained. `postpack` removes the copies.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const pkg = resolve(import.meta.dirname, '..')
const web = resolve(pkg, '..', '..')
const copies = ['LICENSE', 'static/dist', 'static/brand', 'sidecar/talaria_sidecar', 'sidecar/scripts', 'sidecar/agent_dependency.json', 'contract_versions.json', '_release.json']
const clean = process.argv.includes('--clean')
for (const relative of copies) {
  const target = resolve(pkg, relative)
  rmSync(target, { recursive: true, force: true })
  if (clean) continue
  const source = resolve(web, relative)
  if (!existsSync(source)) {
    if (relative === '_release.json') continue // development builds carry no release stamp
    throw new Error(`prepack: missing ${source}`)
  }
  cpSync(source, target, { recursive: true, filter: (path) => !/__pycache__|\.pyc$|\.venv/.test(path) })
}
if (clean) for (const dir of ['static', 'sidecar']) rmSync(resolve(pkg, dir), { recursive: true, force: true })
