import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { main, scan, serialize } from './check-ui-rules.mjs'

type Counts = Record<string, Record<string, number>>
interface Exception { rule: string; file: string; count: number; reason?: string }

/** A temp frontend package holding `files` (path relative to the package → source) and, when given, a baseline. */
const tree = (files: Record<string, string>, baseline?: { counts?: Counts; exceptions?: Exception[] }) => {
  const root = mkdtempSync(join(tmpdir(), 'ui-rules-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  mkdirSync(join(root, 'scripts'), { recursive: true })
  if (baseline) writeFileSync(join(root, 'scripts/ui-rules-baseline.json'), serialize(baseline))
  return root
}
const run = (root: string, ...args: string[]) => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const status = main(root, args)
  const stderr = error.mock.calls.map((c) => c.join(' ')).join('\n')
  vi.restoreAllMocks()
  return { status, stderr }
}
const baselineOf = (root: string) => JSON.parse(readFileSync(join(root, 'scripts/ui-rules-baseline.json'), 'utf8'))

const page = 'src/features/demo/Page.tsx'
const settings = 'src/features/settings/DemoSection.tsx'

it.each([
  ['card', page, '<div className="rounded-lg border border-border bg-surface p-3" />', 'design-system §1.1'],
  ['text-size', page, '<span className="text-[12px]" />', 'design-system §10'],
  ['raw-control', page, '<input type="checkbox" />', 'Switch'],
  ['settings-heading', settings, '<h3 className="x">Title</h3>', 'SettingsGroup'],
  ['settings-row', settings, '<FieldRow label="x">y</FieldRow>', 'SettingsRows.tsx'],
])('a new %s fails with its file, line, rule id and message', (rule, file, line, message) => {
  const { status, stderr } = run(tree({ [file]: `export const X = () => (\n  ${line}\n)\n` }, {}))
  expect(status).toBe(1)
  expect(stderr).toContain(`${file}:2 ${rule}: `)
  expect(stderr).toContain(message)
})

it('ignores the allowed text sizes, src/ui, tests, settings rules outside settings and SettingsRows.tsx', () => {
  const root = tree({
    [page]: '<span className="text-[11px] text-[13px] text-[20px]" /><h3>ok</h3><FieldRow label="ok" />',
    'src/ui/Card.tsx': '<div className="rounded-lg border border-border bg-surface text-[12px]"><input type="range" /></div>',
    'src/features/demo/Page.test.tsx': '<input type="radio" className="text-[15px]" />',
    'src/features/settings/SettingsRows.tsx': '<FieldRow label="the kit" />',
  })
  expect(scan(root)).toEqual([])
})

it('scans src/shell and counts every hit on a line', () => {
  const root = tree({ 'src/shell/Bar.tsx': 'x\n<i className="text-[12px] text-[15px]" /><input type="radio" />' })
  expect(scan(root)).toEqual([
    { rule: 'raw-control', file: 'src/shell/Bar.tsx', line: 2 },
    { rule: 'text-size', file: 'src/shell/Bar.tsx', line: 2 },
    { rule: 'text-size', file: 'src/shell/Bar.tsx', line: 2 },
  ])
})

it('passes at the baseline and fails one above it, listing every hit in that file', () => {
  const files = { [page]: '<i className="text-[12px]" />\n<i className="text-[15px]" />\n' }
  expect(run(tree(files, { counts: { 'text-size': { [page]: 2 } } })).status).toBe(0)
  const { status, stderr } = run(tree(files, { counts: { 'text-size': { [page]: 1 } } }))
  expect(status).toBe(1)
  expect(stderr).toContain(`${page}:1 text-size`)
  expect(stderr).toContain(`${page}:2 text-size`)
})

it('fails below the baseline naming --update, which lowers the count and then passes', () => {
  const root = tree({ [page]: '<i className="text-[12px]" />\n' }, { counts: { 'text-size': { [page]: 3 }, card: { 'src/features/gone/Old.tsx': 1 } } })
  const below = run(root)
  expect(below.status).toBe(1)
  expect(below.stderr).toContain('node scripts/check-ui-rules.mjs --update')
  expect(run(root, '--update').status).toBe(0)
  expect(baselineOf(root)).toEqual({ counts: { 'text-size': { [page]: 1 } }, exceptions: [] })
  expect(run(root).status).toBe(0)
})

it('--update refuses to raise a count or add a file', () => {
  const other = 'src/features/demo/Other.tsx'
  const root = tree({ [page]: '<i className="text-[12px] text-[15px]" />', [other]: '<input type="range" />' }, { counts: { 'text-size': { [page]: 1 } } })
  const { status, stderr } = run(root, '--update')
  expect(status).toBe(1)
  expect(stderr).toContain(`text-size ${page}`)
  expect(stderr).toContain(`raw-control ${other}`)
  expect(baselineOf(root).counts).toEqual({ 'text-size': { [page]: 1 } })
})

it('an exceptions entry with a reason raises the allowance; --update keeps it and lowers only the baseline', () => {
  const exceptions = [{ rule: 'card', file: page, count: 1, reason: 'The import preview frames a foreign document.' }]
  const root = tree({ [page]: '<div className="rounded-xl border border-border bg-surface" />' }, { counts: { card: { [page]: 1 } }, exceptions })
  expect(run(root, '--update').status).toBe(0)
  expect(baselineOf(root)).toEqual({ counts: {}, exceptions })
  expect(run(root).status).toBe(0)
})

it.each([
  ['an empty reason', { rule: 'card', file: page, count: 1, reason: ' ' }],
  ['a missing reason', { rule: 'card', file: page, count: 1 }],
])('an exceptions entry with %s fails the check', (_, exception) => {
  const { status, stderr } = run(tree({ [page]: '<div className="rounded-xl border border-border bg-surface" />' }, { exceptions: [exception] }))
  expect(status).toBe(1)
  expect(stderr).toContain(`exceptions[0] (card ${page}): reason must be a non-empty sentence`)
})

it('fails a baseline that is not sorted by rule then file, naming --update', () => {
  const root = tree({ [page]: '<i className="text-[12px]" /><input type="radio" />' })
  writeFileSync(join(root, 'scripts/ui-rules-baseline.json'), JSON.stringify({ counts: { 'text-size': { [page]: 1 }, 'raw-control': { [page]: 1 } }, exceptions: [] }, null, 2) + '\n')
  const { status, stderr } = run(root)
  expect(status).toBe(1)
  expect(stderr).toContain('node scripts/check-ui-rules.mjs --update')
  expect(run(root, '--update').status).toBe(0)
  expect(Object.keys(baselineOf(root).counts)).toEqual(['raw-control', 'text-size'])
})
