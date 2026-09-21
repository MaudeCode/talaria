/**
 * The Web root owns `static/dist`, `sidecar/agent_dependency.json`, and `contract_versions.json`.
 * In a source checkout that is `web/` (four levels above `dist/bin`); in an npm install the
 * `prepack` step copies those trees into the package, so the package root itself qualifies.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export function isWebRoot(dir: string): boolean {
  return existsSync(join(dir, 'sidecar', 'agent_dependency.json')) && existsSync(join(dir, 'contract_versions.json'))
}

export function resolveWebRoot(start: string): string {
  let dir = resolve(start)
  for (let depth = 0; depth < 6; depth += 1) {
    if (isWebRoot(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`talaria-web: no Web root (sidecar/agent_dependency.json + contract_versions.json) above ${start}; set TALARIA_WEB_ROOT`)
}
