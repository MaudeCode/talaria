// Post-processes the TanStack Start SPA build into the committed, Python-served
// layout under ../static/dist.
//
// Input : dist/client/_shell.html + dist/client/assets/* (+ sw.js, manifest)
// Output: ../static/dist/index.html with request-time placeholders, relative
//         asset URLs, no inline scripts, and the hashed assets copied verbatim.
//
// Why: the Start prerender emits two inline framework scripts (scroll
// restoration and the SSR hydration barrier) and absolute "/./assets" URLs.
// The Python shell is served under an arbitrary mount prefix with a CSP that
// has no 'unsafe-inline' for scripts, and the client entry mounts with
// createRoot rather than hydrating SSR output, so neither inline script is
// needed. Everything here is deterministic: no timestamps, sorted file order.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const here = resolve(import.meta.dirname)
const clientDir = resolve(here, '../dist/client')
const outDir = resolve(here, '../../static/dist')

const shellPath = join(clientDir, '_shell.html')
if (!existsSync(shellPath)) {
  console.error('finalize-dist: dist/client/_shell.html missing; run `vite build` first')
  process.exit(1)
}
let html = readFileSync(shellPath, 'utf8')

// 1. Drop every inline script. Only external module scripts survive.
html = html.replace(/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/g, '')
// 2. Drop React streaming comment markers.
html = html.replace(/<!--\$-->|<!--\/\$-->|<!--\$\?-->|<!--\$!-->/g, '')
// 3. Relative asset URLs: "/./assets/x" and "/assets/x" -> "./assets/x".
html = html.replace(/(href|src)="\/(?:\.\/)?assets\//g, '$1="./assets/')
// 4. Request-time placeholders substituted by api/spa_shell.py.
html = html.replace(/<html lang="[^"]*"/, '<html lang="__LANG__"')
if (!html.includes('<base ')) {
  html = html.replace('<head>', '<head><base href="__BASE_HREF__">')
} else {
  html = html.replace(/<base href="[^"]*">/, '<base href="__BASE_HREF__">')
}
// 5. Sanity: no inline handlers or scripts may remain.
if (/<script(?![^>]*\ssrc=)/.test(html) || /\son[a-z]+="/i.test(html)) {
  console.error('finalize-dist: inline script or handler remained in the shell')
  process.exit(1)
}
if (!/<script type="module"[^>]*src="\.\/assets\//.test(html)) {
  console.error('finalize-dist: module entry script not found in the shell')
  process.exit(1)
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'index.html'), html + (html.endsWith('\n') ? '' : '\n'))

// Copy assets and PWA files, sorted for deterministic output.
const skip = new Set(['_shell.html', '.vite'])
for (const name of readdirSync(clientDir).sort()) {
  if (skip.has(name)) continue
  const from = join(clientDir, name)
  const to = join(outDir, name)
  if (statSync(from).isDirectory()) cpSync(from, to, { recursive: true })
  else cpSync(from, to)
}

// Manifest of emitted files for the Python packaging test and check-dist.
const files = []
const walk = (dir, rel) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    const r = rel ? `${rel}/${name}` : name
    if (statSync(p).isDirectory()) walk(p, r)
    else if (r !== 'FILES.txt') files.push(r)
  }
}
walk(outDir, '')
writeFileSync(join(outDir, 'FILES.txt'), files.join('\n') + '\n')
console.log(`finalize-dist: wrote ${files.length} files to static/dist`)
