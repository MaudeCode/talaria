import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

// The gate resolves messages/ and project.inlang/ next to its own directory, so each case copies it into a temp tree.
const tree = (catalogs: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'i18n-gate-'))
  for (const dir of ['scripts', 'messages', 'project.inlang']) mkdirSync(join(root, dir))
  copyFileSync(resolve(import.meta.dirname, 'i18n-gate.mjs'), join(root, 'scripts/i18n-gate.mjs'))
  writeFileSync(join(root, 'project.inlang/settings.json'), JSON.stringify({ baseLocale: 'en', locales: Object.keys(catalogs) }))
  for (const [locale, text] of Object.entries(catalogs)) writeFileSync(join(root, `messages/${locale}.json`), text)
  const run = (...args: string[]) => spawnSync(process.execPath, [join(root, 'scripts/i18n-gate.mjs'), ...args], { encoding: 'utf8' })
  const read = (locale: string) => readFileSync(join(root, `messages/${locale}.json`), 'utf8')
  return { run, read }
}
const canonical = (o: object) => JSON.stringify(o, null, '\t') + '\n'
const sorted = { en: canonical({ a_key: 'A', b_key: 'B {n}' }), de: canonical({ a_key: 'A-de', b_key: 'B-de {n}' }) }

it('passes a sorted, canonical tree', () => {
  expect(tree(sorted).run().status).toBe(0)
})

it('fails a key appended out of order, naming the file, the key and the fix command', () => {
  const { run } = tree({ ...sorted, de: canonical({ b_key: 'B-de {n}', a_key: 'A-de' }) })
  const result = run()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('de.json')
  expect(result.stderr).toContain('a_key')
  expect(result.stderr).toContain('npm run i18n:fix -w packages/frontend')
})

it('fails a sorted file whose formatting differs from the canonical form', () => {
  const { run } = tree({ ...sorted, en: JSON.stringify({ a_key: 'A', b_key: 'B {n}' }, null, 2) + '\n' })
  const result = run()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('en.json')
  expect(result.stderr).toContain('npm run i18n:fix -w packages/frontend')
})

it('--fix rewrites unsorted and misformatted catalogs into the canonical form, idempotently', () => {
  const { run, read } = tree({ en: JSON.stringify({ b_key: 'B {n}', a_key: 'A' }, null, 2), de: canonical({ b_key: 'B-de {n}', a_key: 'A-de' }) })
  expect(run('--fix').status).toBe(0)
  expect({ en: read('en'), de: read('de') }).toEqual(sorted)
  expect(run('--fix').status).toBe(0)
  expect({ en: read('en'), de: read('de') }).toEqual(sorted)
  expect(run().status).toBe(0)
})

it('still fails a locale key that English lacks', () => {
  const result = tree({ ...sorted, de: canonical({ a_key: 'A-de', b_key: 'B-de {n}', c_key: 'C-de' }) }).run()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('de.c_key has no English source')
})
