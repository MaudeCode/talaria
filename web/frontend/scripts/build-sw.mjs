// Build the service worker (workbox injectManifest strategy) into static/dist/sw.js.
//
// 1. Bundle src/sw.ts with Vite in library mode (workbox inlined, no hash).
// 2. Inject the precache manifest: the shell (index.html), the assets the shell
//    references directly (entry chunks and stylesheet), the web manifest and
//    brand icons. Lazy route/library chunks are hashed and cached on first use
//    by the runtime cache in sw.ts, so the install footprint stays small.
// The TanStack Start builder does not run vite-plugin-pwa's closeBundle for the
// client environment, so this script drives the same workbox pipeline directly.
import { build } from 'vite'
import { injectManifest } from 'workbox-build'
import { resolve } from 'node:path'
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'

const here = resolve(import.meta.dirname)
const distRoot = resolve(here, '../../static/dist')
const swTmp = resolve(here, '../dist/sw')

if (!existsSync(resolve(distRoot, 'index.html'))) {
  console.error('build-sw: static/dist/index.html missing; run finalize-dist first')
  process.exit(1)
}

await build({
  configFile: false,
  logLevel: 'warn',
  root: resolve(here, '..'),
  build: {
    outDir: swTmp,
    emptyOutDir: true,
    sourcemap: false,
    minify: 'oxc',
    target: 'es2022',
    lib: { entry: resolve(here, '../src/sw.ts'), formats: ['es'], fileName: () => 'sw.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
})

// Extension SDK (protocol v1), loaded by sandboxed panel documents.
const sdkTmp = resolve(here, '../dist/sdk')
await build({
  configFile: false,
  logLevel: 'warn',
  root: resolve(here, '..'),
  build: { outDir: sdkTmp, emptyOutDir: true, sourcemap: false, minify: 'oxc', target: 'es2022', lib: { entry: resolve(here, '../src/extensions/sdk.ts'), formats: ['iife'], name: 'HermesExtensionSdk', fileName: () => 'extension-sdk.js' } },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
})
writeFileSync(resolve(distRoot, 'extension-sdk.js'), readFileSync(resolve(sdkTmp, 'extension-sdk.js')))
rmSync(sdkTmp, { recursive: true, force: true })

const shell = readFileSync(resolve(distRoot, 'index.html'), 'utf8')
const shellAssets = [...shell.matchAll(/(?:href|src)="\.\/(assets\/[^"]+)"/g)].map((m) => m[1])
const wanted = new Set(['index.html', 'manifest.webmanifest', ...shellAssets])

const { count, size, warnings } = await injectManifest({
  swSrc: resolve(swTmp, 'sw.js'),
  swDest: resolve(distRoot, 'sw.js'),
  globDirectory: distRoot,
  globPatterns: ['index.html', 'manifest.webmanifest', 'assets/*.{js,css}'],
  globIgnores: ['sw.js', 'FILES.txt'],
  injectionPoint: 'self.__WB_MANIFEST',
  manifestTransforms: [
    async (entries) => ({
      manifest: entries
        .filter((e) => wanted.has(e.url))
        .map((e) => ({ ...e, url: `./${e.url}` }))
        .sort((a, b) => a.url.localeCompare(b.url)),
      warnings: [],
    }),
  ],
  maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
})
for (const w of warnings) console.warn('build-sw:', w)
rmSync(swTmp, { recursive: true, force: true })

const filesPath = resolve(distRoot, 'FILES.txt')
const files = readFileSync(filesPath, 'utf8').split('\n').filter(Boolean)
const extra = ['sw.js', 'extension-sdk.js'].filter((f) => !files.includes(f))
if (extra.length) writeFileSync(filesPath, [...files, ...extra].sort().join('\n') + '\n')
console.log(`build-sw: precached ${count} shell files (${size} bytes)`)
