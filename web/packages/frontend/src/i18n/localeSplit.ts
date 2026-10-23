/**
 * TAL-1403: per-locale message loading. Paraglide's `message-modules` output gives every
 * message one module that defines all 15 locale functions, so the startup bundle carried every
 * locale. This build step keeps the base-locale function in each message module and moves the
 * other locales into one lazily imported chunk per locale, which `loadLocaleMessages` (the
 * `virtual:talaria-locales` module) installs on the Paraglide runtime before the UI renders in
 * that locale. Messages a locale leaves byte-identical to the base locale stay out of its chunk
 * and fall back to the base function.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { normalizePath, type Plugin } from 'vite'

const DISPATCH = /^\tif \(locale === "([^"]+)"\) return (\w+)\(inputs\)\n/gm
const FALLBACK = /^\treturn (\w+)\(inputs\)$/m
// The dispatcher; reserved-word keys are declared without `export` and re-exported under a string name.
const DISPATCHER = /^(?:export )?const (\w+) = [^\n]*\n\tconst locale = /m

export interface SplitMessage {
  /** The message module with only the base-locale function. */
  code: string
  /** Message key (the dispatcher's local name). */
  key: string
  /** Function expression per non-base locale, without entries identical to the base locale. */
  locales: Record<string, string>
}

/** Splits one generated Paraglide message module; null when the module is not a message (the `_index.js` barrel). */
export function splitMessageModule(source: string): SplitMessage | null {
  const key = DISPATCHER.exec(source)?.[1]
  const fallback = FALLBACK.exec(source)?.[1]
  const dispatch = [...source.matchAll(DISPATCH)]
  if (!key || !fallback || dispatch.length === 0) return null
  // A locale function is `const name = <arrow function>\n};`, or `/** @type … */\nconst name = other;` when it reuses another locale's.
  const declaration = (name: string, seen: string[] = []): { start: number; end: number; expression: string } => {
    const head = `\nconst ${name} = `
    const start = source.indexOf(head)
    if (start < 0 || seen.includes(name)) throw new Error(`locale split: ${key}: declaration ${name} missing`)
    const alias = /^(\w+);\n/.exec(source.slice(start + head.length))
    if (alias?.[1]) {
      const comment = source.lastIndexOf('\n/** @type ', start - 1)
      const lineStart = comment >= 0 && !source.slice(comment + 1, start).includes('\n') ? comment + 1 : start + 1
      return { start: lineStart, end: start + head.length + alias[0].length, expression: declaration(alias[1], [...seen, name]).expression }
    }
    const end = source.indexOf('\n};\n', start)
    if (end < 0) throw new Error(`locale split: ${key}: declaration ${name} unterminated`)
    return { start: start + 1, end: end + 4, expression: source.slice(start + head.length, end + 2) }
  }
  const base = declaration(fallback).expression
  const locales: Record<string, string> = {}
  const removed: { start: number; end: number }[] = []
  for (const [, locale, name] of dispatch) {
    if (!locale || !name) continue
    const own = declaration(name)
    removed.push(own)
    if (own.expression !== base) locales[locale] = own.expression
  }
  let code = ''
  let cursor = 0
  for (const span of removed.sort((a, b) => a.start - b.start)) {
    code += source.slice(cursor, span.start)
    cursor = source[span.end] === '\n' ? span.end + 1 : span.end
  }
  code += source.slice(cursor)
  const lookup = `\tconst localized = localeDictionaries[locale]?.[${JSON.stringify(key)}]\n\tif (localized) return localized(inputs)\n`
  let replaced = false
  code = code.replace(DISPATCH, () => (replaced ? '' : ((replaced = true), lookup)))
  return { code: `import { localeDictionaries } from '../runtime.js';\n${code}`, key, locales }
}

/** One locale's chunk: the message dictionary as its default export, and its own URL for the service worker. */
export function localeChunk(entries: { key: string; expression: string }[], registryPath: string): string {
  const body = entries.map(({ key, expression }) => `\t${JSON.stringify(key)}: ${expression},\n`).join('')
  return `import * as registry from ${JSON.stringify(registryPath)}\nexport const url = import.meta.url\nexport default {\n${body}}\n`
}

/** Paraglide's runtime gains the dictionaries the transformed message modules read. */
export const RUNTIME_DICTIONARIES = '\n/** @type {Record<string, Record<string, (inputs: any) => LocalizedString>>} */\nexport const localeDictionaries = {}\n'

const LOADER_ID = 'virtual:talaria-locales'
const CHUNK_PREFIX = 'virtual:talaria-locale/'

/** Vite plugin, ordered after the Paraglide plugin; `outdir` is Paraglide's output directory. */
export function paraglideLocaleSplit(outdir: string): Plugin {
  const root = normalizePath(resolve(outdir))
  const messagesDir = `${root}/messages`
  let compiled: Map<string, { key: string; expression: string }[]> | null = null
  const byLocale = () => {
    if (compiled) return compiled
    compiled = new Map()
    for (const file of readdirSync(messagesDir).sort()) {
      if (!file.endsWith('.js')) continue
      const split = splitMessageModule(readFileSync(`${messagesDir}/${file}`, 'utf8'))
      if (!split) continue
      for (const [locale, expression] of Object.entries(split.locales)) {
        const entries = compiled.get(locale) ?? []
        entries.push({ key: split.key, expression })
        compiled.set(locale, entries)
      }
    }
    return compiled
  }
  return {
    name: 'talaria-paraglide-locale-split',
    // Before later plugins reprint the modules, so the transform reads Paraglide's own output, as the chunks do.
    enforce: 'pre',
    buildStart() { compiled = null },
    watchChange(id) { if (id.startsWith(root)) compiled = null },
    resolveId(source) {
      if (source === LOADER_ID) return '\0' + LOADER_ID
      if (source.startsWith(CHUNK_PREFIX)) return `\0${CHUNK_PREFIX}locale-${source.slice(CHUNK_PREFIX.length)}.js`
      return undefined
    },
    load(id) {
      if (id === '\0' + LOADER_ID) {
        const chunks = [...byLocale().keys()].sort().map((locale) => `\t${JSON.stringify(locale)}: () => import(${JSON.stringify(CHUNK_PREFIX + locale)}),\n`).join('')
        return `import { localeDictionaries } from ${JSON.stringify(`${root}/runtime.js`)}
const chunks = {\n${chunks}}
const loading = {}
export function loadLocaleMessages(locale) {
\tconst chunk = Object.hasOwn(chunks, locale) ? chunks[locale] : null
\tif (!chunk) return Promise.resolve(undefined)
\treturn (loading[locale] ??= chunk().then((loaded) => { localeDictionaries[locale] = loaded.default; return loaded.url }, (error) => { delete loading[locale]; throw error }))
}
`
      }
      const match = new RegExp(`^\\0${CHUNK_PREFIX}locale-(.+)\\.js$`).exec(id)
      if (match?.[1]) return localeChunk(byLocale().get(match[1]) ?? [], `${root}/registry.js`)
      return undefined
    },
    transform(code, id) {
      const [file = id, query] = id.split('?')
      // Only the module itself (dev adds `?t=`/`?v=` cache keys); `?raw` and similar imports stay as they are.
      if (query && !/^[tv]=/.test(query)) return undefined
      if (file === `${root}/runtime.js`) return { code: code + RUNTIME_DICTIONARIES, map: null }
      if (!file.startsWith(messagesDir + '/') || !file.endsWith('.js')) return undefined
      const split = splitMessageModule(code)
      return split ? { code: split.code, map: null } : undefined
    },
  }
}
