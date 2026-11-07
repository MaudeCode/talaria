import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { clientDir, layoutFiles, readLayout } from './check-bundle-size.mjs'

it('chat route static dependency graphs exclude xterm runtime and stylesheet', () => {
  const manifest = JSON.parse(readFileSync(resolve(clientDir, '.vite/manifest.json'), 'utf8'))
  const routes = Object.keys(manifest).filter((key) => /^src\/routes\/_app(?:\.index|\.session\.\$sessionId)?\.tsx\?/.test(key))
  expect(routes).toHaveLength(3)
  for (const route of routes) {
    for (const file of layoutFiles(manifest, route)) {
      const source = readFileSync(resolve(clientDir, file), 'utf8')
      // Package names disappear when bundled; these runtime/CSS signatures survive minification.
      expect(/Terminal requires a parent element|\.xterm-screen/.exec(source), `${route}: ${file}`).toBeNull()
    }
  }
})

it('the app layout static dependency graph excludes diagram and KaTeX runtimes and styles', () => {
  const { files } = readLayout()
  expect(files.length).toBeGreaterThan(0)
  expect(files.filter((file) => /MarkdownRenderer/.test(file))).toEqual([])
  for (const file of files) {
    const source = readFileSync(resolve(clientDir, file), 'utf8')
    // Runtime signatures survive minification, unlike library/chunk filenames.
    expect(/KaTeX parse error:|suppressErrorRendering|unsupported-diagram|font-family:KaTeX_/.exec(source), file).toBeNull()
  }
})

it('the app layout static dependency graph carries only base-locale messages', () => {
  // TAL-1403: other locales load as per-locale chunks; Paraglide's minified locale dispatch survives as `===\`ja\``.
  for (const file of readLayout().files) expect(/===`(?:ja|de|ru)`/.exec(readFileSync(resolve(clientDir, file), 'utf8')), file).toBeNull()
})

it('the app layout static dependency graph excludes the skin token tables', () => {
  // TAL-1700: Verdigris's dark `--code-text`, a literal only skins.ts holds. The stylesheet needs it, so only scripts count.
  const SKIN_TABLE = '#D6AE74'
  const script = (file: string) => (file.endsWith('.js') ? readFileSync(resolve(clientDir, file), 'utf8') : '')
  for (const file of readLayout().files) expect(script(file).includes(SKIN_TABLE), file).toBe(false)
  // The Appearance picker still loads the table lazily; this also fails if the signature goes stale.
  const manifest = JSON.parse(readFileSync(resolve(clientDir, '.vite/manifest.json'), 'utf8'))
  expect(Object.values<{ file: string }>(manifest).some(({ file }) => script(file).includes(SKIN_TABLE))).toBe(true)
})

it('the app layout static dependency graph excludes the sidecar RPC schemas', () => {
  // TAL-1698: unused method tables shake away with their names, but the Zod calls inside them stay, so these
  // field names (a goal RPC param and the runtime handshake's pin) are what survives of any src/sidecar/ module.
  for (const file of readLayout().files) expect(/default_max_turns|pinned_revision/.exec(readFileSync(resolve(clientDir, file), 'utf8')), file).toBeNull()
})

it('counts shared static imports and styles once, follows cycles, and excludes dynamic imports', () => {
  expect(layoutFiles({
    'src/routes/_app.tsx?tsr-split=component': { file: 'layout.js', imports: ['shared', 'child'], css: ['layout.css'], dynamicImports: ['lazy'] },
    shared: { file: 'shared.js', css: ['shared.css'] },
    child: { file: 'child.js', imports: ['shared', 'src/routes/_app.tsx?tsr-split=component'] },
    lazy: { file: 'lazy.js' },
  })).toEqual(['child.js', 'layout.css', 'layout.js', 'shared.css', 'shared.js'])
  expect(() => layoutFiles({})).toThrow('route entry missing')
  expect(() => layoutFiles({ 'src/routes/_app.tsx?tsr-split=component': { file: 'layout.js', imports: ['missing'] } })).toThrow('manifest import missing')
})

it('the Markdown renderer chunk loads no Oniguruma WebAssembly', () => {
  // TAL-1706: Shiki's root entry pulls the engine in although Talaria passes the JavaScript regex engine.
  const manifest = JSON.parse(readFileSync(resolve(clientDir, '.vite/manifest.json'), 'utf8'))
  const dynamicImports: string[] = manifest['src/features/chat/render/MarkdownRenderer.tsx'].dynamicImports
  expect(dynamicImports.filter((key) => key.endsWith('/shiki/dist/wasm.mjs'))).toEqual([])
  // The `wasm` language grammar is a different chunk and stays; it also fails this test if the manifest keys change.
  expect(dynamicImports.filter((key) => key.endsWith('/@shikijs/langs/dist/wasm.mjs'))).toHaveLength(1)
})

it('SessionListPanel ships React Compiler output', () => {
  const manifest = JSON.parse(readFileSync(resolve(clientDir, '.vite/manifest.json'), 'utf8'))
  // The panel shares the shell's chunk; its list's element id survives minification.
  const chunks = Object.values<{ file: string }>(manifest).filter(({ file }) => file.endsWith('.js')).map(({ file }) => readFileSync(resolve(clientDir, file), 'utf8')).filter((source) => source.includes('sessionList'))
  // Compiled components compare memo cache slots against this symbol; React DOM defines it in a different chunk.
  expect(chunks.map((source) => source.includes('react.memo_cache_sentinel'))).toEqual([true])
})
