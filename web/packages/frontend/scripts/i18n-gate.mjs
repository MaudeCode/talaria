// Build gate for the Paraglide catalogue (HWEB-100).
// Fails when: a locale defines a key English lacks; English lacks a key any
// locale defines (parity); a translation's placeholders differ from English;
// a variant message's inputs differ from English; a message is empty; or a
// catalog is not in canonical form: keys in code-unit order, tab-indented
// JSON with a trailing newline (TAL-2110). `--fix` rewrites every catalog into
// that form, so concurrent branches add keys at different lines.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dir = resolve(import.meta.dirname, '../messages')
const settings = JSON.parse(readFileSync(resolve(import.meta.dirname, '../project.inlang/settings.json'), 'utf8'))
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort()
const errors = []
const configured = [...settings.locales].sort()
if (JSON.stringify(files) !== JSON.stringify(configured)) errors.push(`locale files ${files.join(',')} differ from project.inlang locales ${configured.join(',')}`)

const load = (l) => JSON.parse(readFileSync(join(dir, `${l}.json`), 'utf8'))
const canonical = (cat) => JSON.stringify(Object.fromEntries(Object.keys(cat).sort().map((k) => [k, cat[k]])), null, '\t') + '\n'
if (process.argv.includes('--fix')) {
  let changed = 0
  for (const locale of files) {
    const path = join(dir, `${locale}.json`)
    const text = readFileSync(path, 'utf8')
    const fixed = canonical(JSON.parse(text))
    if (fixed === text) continue
    writeFileSync(path, fixed)
    changed++
  }
  console.log(`i18n-gate --fix: rewrote ${changed} of ${files.length} catalogs`)
  process.exit(0)
}
const fixHint = 'run npm run i18n:fix -w packages/frontend'
for (const locale of files) {
  const text = readFileSync(join(dir, `${locale}.json`), 'utf8')
  const cat = JSON.parse(text)
  const keys = Object.keys(cat)
  const i = keys.findIndex((k, n) => n > 0 && k < keys[n - 1])
  if (i > 0) errors.push(`${locale}.json: key ${keys[i]} is out of order (after ${keys[i - 1]}); ${fixHint}`)
  else if (text !== canonical(cat)) errors.push(`${locale}.json is not in canonical form (tab-indented, trailing newline); ${fixHint}`)
}
const placeholders = (value) => {
  const set = new Set()
  const texts = typeof value === 'string' ? [value] : value.flatMap((v) => Object.values(v.match ?? {}))
  for (const t of texts) for (const m of String(t).matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) set.add(m[1])
  return [...set].sort().join(',')
}
const inputs = (value) => (typeof value === 'string' ? '' : (value[0]?.declarations ?? []).filter((d) => d.startsWith('input ')).map((d) => d.slice(6)).sort().join(','))

const en = load(settings.baseLocale)
for (const [k, v] of Object.entries(en)) {
  if (typeof v === 'string' ? v.trim() === '' : !Array.isArray(v) || v.length === 0) errors.push(`en.${k} is empty`)
}
for (const locale of files) {
  if (locale === settings.baseLocale) continue
  const cat = load(locale)
  for (const k of Object.keys(cat)) if (!(k in en)) errors.push(`${locale}.${k} has no English source`)
  for (const [k, v] of Object.entries(cat)) {
    if (!(k in en)) continue
    if (typeof v === 'string' && v.trim() === '') errors.push(`${locale}.${k} is empty`)
    const pe = placeholders(en[k])
    const pl = placeholders(v)
    // Every English placeholder must be available; a translation may omit one but never invent one.
    for (const p of pl.split(',').filter(Boolean)) if (!pe.split(',').includes(p)) errors.push(`${locale}.${k} uses {${p}} which English lacks`)
    if (inputs(v) && inputs(en[k]) && inputs(v) !== inputs(en[k])) errors.push(`${locale}.${k} variant inputs ${inputs(v)} differ from English ${inputs(en[k])}`)
  }
}
if (errors.length) {
  console.error(`i18n-gate: ${errors.length} problem(s)`)
  for (const e of errors.slice(0, 50)) console.error(' - ' + e)
  process.exit(1)
}
console.log(`i18n-gate: ${files.length} locales, ${Object.keys(en).length} English keys, parity OK`)
