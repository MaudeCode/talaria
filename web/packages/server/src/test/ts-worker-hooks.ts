/**
 * Lets a worker thread started from TypeScript sources (vitest) load the
 * server modules: maps their compiled `.js` specifiers back to `.ts` and
 * compiles each file with Node's TypeScript transform.
 */
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\//.test(specifier) && specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
      const source = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL)
      if (existsSync(fileURLToPath(source))) return next(source.href, context)
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (!url.endsWith('.ts')) return next(url, context)
    return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform', sourceUrl: url }) }
  },
})
