// Build gate for the Paraglide catalogue (HWEB-100).
// Fails when: a locale defines a key English lacks; English lacks a key any
// locale defines (parity); a translation's placeholders differ from English;
// a variant message's inputs differ from English; or a message is empty.
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dir = resolve(import.meta.dirname, '../messages')
const settings = JSON.parse(readFileSync(resolve(import.meta.dirname, '../project.inlang/settings.json'), 'utf8'))
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort()
const errors = []
const configured = [...settings.locales].sort()
if (JSON.stringify(files) !== JSON.stringify(configured)) errors.push(`locale files ${files.join(',')} differ from project.inlang locales ${configured.join(',')}`)

const load = (l) => JSON.parse(readFileSync(join(dir, `${l}.json`), 'utf8'))
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
