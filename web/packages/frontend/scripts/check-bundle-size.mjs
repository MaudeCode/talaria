import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const clientDir = resolve(import.meta.dirname, '../dist/client')
// TAL-1206: measured static layout JS + CSS, with 10% headroom. Never includes lazy imports.
export const layoutBudgetBytes = Math.ceil(1_497_999 * 1.1)

/** Follow static imports only: deferred routes and renderer plugins are not layout costs. */
export function layoutFiles(manifest, layout = Object.keys(manifest).find((key) => /^src\/routes\/_app\.tsx\?/.test(key))) {
  if (!layout) throw new Error('bundle check: _app route entry missing from client manifest')
  const seen = new Set()
  const files = new Set()
  function visit(key) {
    if (seen.has(key)) return
    seen.add(key)
    const chunk = manifest[key]
    if (!chunk) throw new Error(`bundle check: manifest import missing: ${key}`)
    files.add(chunk.file)
    for (const css of chunk.css ?? []) files.add(css)
    for (const dependency of chunk.imports ?? []) visit(dependency)
  }
  visit(layout)
  return [...files].sort()
}

export function readLayout() {
  const manifest = JSON.parse(readFileSync(resolve(clientDir, '.vite/manifest.json'), 'utf8'))
  const files = layoutFiles(manifest)
  return { files, bytes: files.reduce((sum, file) => sum + statSync(resolve(clientDir, file)).size, 0) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { bytes, files } = readLayout()
  console.log(`bundle check: layout JS + CSS ${bytes} / ${layoutBudgetBytes} bytes (${files.length} files)`)
  if (bytes > layoutBudgetBytes) throw new Error('bundle check: static layout exceeds its measured baseline + 10%')
}
