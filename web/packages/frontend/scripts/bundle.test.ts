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

it('the app layout static dependency graph excludes Mermaid and KaTeX runtimes and styles', () => {
  const { files } = readLayout()
  expect(files.length).toBeGreaterThan(0)
  expect(files.filter((file) => /MarkdownRenderer/.test(file))).toEqual([])
  for (const file of files) {
    const source = readFileSync(resolve(clientDir, file), 'utf8')
    // Runtime signatures survive minification, unlike library/chunk filenames.
    expect(/KaTeX parse error:|suppressErrorRendering|font-family:KaTeX_/.exec(source), file).toBeNull()
  }
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

it('SessionListPanel ships React Compiler output', () => {
  const manifest = JSON.parse(readFileSync(resolve(clientDir, '.vite/manifest.json'), 'utf8'))
  const chunks = Object.values<{ file: string }>(manifest).filter(({ file }) => /\/SessionListPanel-[^/]+\.js$/.test(file))
  // Compiled components compare memo cache slots against this symbol; React DOM defines it in a different chunk.
  expect(chunks.map(({ file }) => readFileSync(resolve(clientDir, file), 'utf8').includes('react.memo_cache_sentinel'))).toEqual([true])
})
