import { paraglideVitePlugin } from '@inlang/paraglide-js'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { renderThemeCss } from './src/theme/skins'

/** Serves the token stylesheet rendered from src/theme/skins.ts as `virtual:hermes-theme.css`. */
function hermesTheme(): Plugin {
  const id = 'virtual:hermes-theme.css'
  const resolved = '\0' + id
  return {
    name: 'hermes-theme',
    resolveId: (source) => (source === id ? resolved : undefined),
    load: (file) => (file === resolved ? renderThemeCss() : undefined),
  }
}

// The Python server serves the committed output from ../static/dist (see
// scripts/finalize-dist.mjs). The service worker is built by scripts/build-sw.mjs
// (workbox injectManifest) after the app build, because the Start builder does
// not run vite-plugin-pwa's closeBundle for the client environment. Relative base keeps hashed asset URLs valid
// under any subpath mount; the shell's <base href> is filled per request.
// `HERMES_WEBUI_DEV_PROXY=http://host:port npm run dev` serves the app from source with HMR and forwards
// server-owned API, static, extension, and plugin paths to the configured WebUI.
const devProxy = process.env.HERMES_WEBUI_DEV_PROXY
const SERVER_OWNED = '(?:api|static|extensions|plugins|dashboard-plugins)'
const PROXY_ROUTE = `^(?!/(?:src|@|node_modules)/)(?:/[^/]+)*/${SERVER_OWNED}(?:/|$)`
const PROXIED = new RegExp(`^(?:/[^/]+)*?(?=/${SERVER_OWNED}(?:/|$))`)

export default defineConfig({
  base: './',
  ...(devProxy
    ? { server: { host: true, proxy: { [PROXY_ROUTE]: { target: devProxy, changeOrigin: true, headers: { origin: devProxy }, rewrite: (path: string) => path.replace(PROXIED, '') } } } }
    : {}),
  resolve: { alias: { '~': new URL('./src', import.meta.url).pathname } },
  plugins: [
    paraglideVitePlugin({
      project: './project.inlang',
      outdir: './src/paraglide',
      strategy: ['globalVariable', 'baseLocale'],
      emitGitIgnore: false,
      emitPrettierIgnore: false,
      outputStructure: 'message-modules',
      disableAsyncLocalStorage: true,
      isServer: 'false',
    }),
    hermesTheme(),
    tailwindcss(),
    tanstackStart({
      srcDirectory: 'src',
      spa: { enabled: true, maskPath: '/', prerender: { enabled: true, outputPath: '/_shell', crawlLinks: false, retryCount: 0 } },
      client: { entry: './client.tsx' },
      router: { entry: './router.tsx' },
    }),
    viteReact(),
  ],
  build: {
    sourcemap: process.env.HERMES_WEBUI_SOURCEMAP === '1',
    manifest: true,
    // The pre-paint head script must stay a file: a data: URL script is blocked by the CSP script-src.
    assetsInlineLimit: (file) => (file.endsWith('/prepaint.js') ? false : undefined),
    rollupOptions: {
      output: {
        // Stable, sorted chunk naming; content hashes make output deterministic for identical inputs.
        hashCharacters: 'base36',
      },
    },
  },
})
