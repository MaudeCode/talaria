import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { main, scan as scanRules, serialize } from '../../../../scripts/check-ui-rules.mjs'

const webConfig = JSON.parse(readFileSync(resolve(import.meta.dirname, 'ui-rules.json'), 'utf8'))
const scan = (root: string) => scanRules(root, webConfig)

const temporaryTrees: string[] = []
afterEach(() => {
  for (const root of temporaryTrees.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Counts = Record<string, Record<string, number>>
interface Exception { rule: string; file: string; count: number; reason?: string }

/** A temp frontend package holding `files` (path relative to the package → source) and, when given, a baseline. */
const tree = (files: Record<string, string>, baseline?: { counts?: Counts; exceptions?: Exception[] }) => {
  const root = mkdtempSync(join(tmpdir(), 'ui-rules-'))
  temporaryTrees.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts/ui-rules.json'), JSON.stringify(webConfig))
  if (baseline) writeFileSync(join(root, 'scripts/ui-rules-baseline.json'), serialize(baseline))
  return root
}
const run = (root: string, ...args: string[]) => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const status = main(root, args.includes('--config') ? args : ['--config', 'scripts/ui-rules.json', ...args])
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
  ['pill', settings, '<Badge tone="border-border text-muted">Plan</Badge>', 'design-system §7'],
  ['pill', 'src/features/profiles/Row.tsx', '<span className="rounded-full border px-2">Pro</span>', 'design-system §7'],
  ['success-text', page, '<span className="text-success">Done</span>', 'StatusDot'],
  ['word-button', 'src/features/connectors/Row.tsx', '<Button onClick={go}>Connect</Button>', 'design-system §12'],
])('a new %s fails with its file, line, rule id and message', (rule, file, line, message) => {
  const { status, stderr } = run(tree({ [file]: `export const X = () => (\n  ${line}\n)\n` }, {}))
  expect(status).toBe(1)
  expect(stderr).toContain(`${file}:2 ${rule}: `)
  expect(stderr).toContain(message)
})

it('ignores the allowed text sizes, src/ui, tests, settings rules outside settings and the Settings row kit', () => {
  const root = tree({
    [page]: '<span className="text-[11px] text-[13px] text-[20px]" /><h3>ok</h3><FieldRow label="ok" />',
    'src/ui/Card.tsx': '<div className="rounded-lg border border-border bg-surface text-[12px]"><input type="range" /></div>',
    'src/features/demo/Page.test.tsx': '<input type="radio" className="text-[15px]" />',
    'src/features/settings/SettingsRows.tsx': '<FieldRow label="the kit" />',
    'src/features/settings/SettingsGroup.tsx': '<FieldRow label="the kit" />',
  })
  expect(scan(root)).toEqual([])
})

it('TAL-2131: counts a pill or word button only in the symbol folders, and spares dialog footers, dots and bars', () => {
  const root = tree({
    // Outside the five folders a Badge, a pill and a word button stay allowed.
    [page]: '<Badge tone="x">a</Badge><span className="rounded-full border" /><Button>Go</Button>',
    [settings]: [
      '<DialogFooter className="mt-3"><Button onClick={close}>Cancel</Button>',
      '  <Button type="submit">Save</Button></DialogFooter>',
      '<span className="size-[7px] rounded-full bg-success" /><div className="h-1 rounded-full bg-border" />',
      '<IconButton variant="ghost" label="Add"><Plus /></IconButton><span className="rounded-full ring-2 ring-inset" />',
      '<Button>Word</Button>',
    ].join('\n'),
  })
  expect(scan(root)).toEqual([{ rule: 'word-button', file: settings, line: 5 }])
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
  expect(below.stderr).toContain('--config scripts/ui-rules.json --update')
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
  expect(stderr).toContain('--config scripts/ui-rules.json --update')
  expect(run(root, '--update').status).toBe(0)
  expect(Object.keys(baselineOf(root).counts)).toEqual(['raw-control', 'text-size'])
})

// App config is exercised through the CLI boundary with disposable Swift files and its own baseline.
const appConfig = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../app/ci/ui-rules.json'), 'utf8'))
const appPage = 'app/Talaria/Features/Settings/DemoView.swift'
const appTree = (files: Record<string, string>, baseline: { counts?: Counts; exceptions?: Exception[] } = {}) => {
  const root = tree(files)
  mkdirSync(join(root, 'app/ci'), { recursive: true })
  writeFileSync(join(root, 'app/ci/ui-rules.json'), JSON.stringify(appConfig))
  writeFileSync(join(root, 'app/ci/ui-rules-baseline.json'), serialize(baseline))
  return root
}
const runApp = (root: string, ...args: string[]) => run(root, '--config', 'app/ci/ui-rules.json', ...args)

it.each([
  ['settings-card', 'SettingsCard(', 'SidebarList'],
  ['settings-card', 'settingsGroupedCell(', 'SidebarList'],
  ['grouped-list', '.listStyle(.insetGrouped)', 'plain lists'],
  ['grouped-list', '.listStyle(.grouped)', 'plain lists'],
  ['grouped-list', 'systemGroupedBackground', 'plain lists'],
  ['page-form', 'Form {', 'modal editors'],
  ['card-fill', 'RoundedRectangle(cornerRadius: 8).fill(Color(.secondarySystemBackground))', 'no cards'],
  ['card-fill', '.cornerRadius(8).background(Color(.tertiarySystemFill))', 'no cards'],
  ['raw-settings-control', 'Toggle("Enabled", isOn: $enabled)', 'shared Settings rows'],
  ['settings-footnote', 'SettingsFootnote("Explanation")', 'section help'],
  ['settings-footnote', '} footer: {', 'section help'],
])('App config rejects new %s with its location and message: %s', (rule, source, message) => {
  const result = runApp(appTree({ [appPage]: `// fixture\n${source}` }))
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(`${appPage}:2 ${rule}: `)
  expect(result.stderr).toContain(message)
})

it('App config scopes exemptions to card fills, modal forms and shared control rows', () => {
  const root = appTree({
    'app/Talaria/Features/Chat/Transcript.swift': 'RoundedRectangle().fill(Color(.secondarySystemBackground))',
    'app/Talaria/Features/Onboarding/Welcome.swift': '.cornerRadius(8)\n.background(Color(.tertiarySystemFill))',
    'app/Talaria/Features/Settings/SettingsToggleRow.swift': 'Toggle("x", isOn: $x)',
    'app/Talaria/Features/Settings/DemoSheet.swift': 'Form {',
    'app/Talaria/Features/Settings/DemoEditorView.swift': 'Form {',
    'app/Talaria/Features/Settings/AddServerView.swift': 'Form {',
    'app/Talaria/Features/Settings/DemoTests.swift': 'SettingsCard(',
  })
  expect(runApp(root).status).toBe(0)
  // A transcript remains subject to the other page rules, and row helpers only exempt raw controls.
  writeFileSync(join(root, 'app/Talaria/Features/Chat/Transcript.swift'), 'Form {')
  writeFileSync(join(root, 'app/Talaria/Features/Settings/SettingsToggleRow.swift'), 'SettingsCard(')
  const result = runApp(root)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Transcript.swift:1 page-form')
  expect(result.stderr).toContain('SettingsToggleRow.swift:1 settings-card')
})

it.each([-3, -2, -1, 0, 1, 2, 3])('App card-fill uses a two-line window in either direction: offset %s', (offset) => {
  const lines = Array<string>(7).fill('// spacer')
  lines[3] = 'RoundedRectangle(cornerRadius: 8)'
  lines[3 + offset] = `${lines[3 + offset] ?? ''} Color(.secondarySystemGroupedBackground)`
  const result = runApp(appTree({ [appPage]: lines.join('\n') }))
  expect(result.status).toBe(Math.abs(offset) <= 2 ? 1 : 0)
  if (Math.abs(offset) <= 2) expect(result.stderr).toContain(`${appPage}:4 card-fill`)
})

it('App baseline ratchets independently and prints its config-specific update command', () => {
  const root = appTree({ [appPage]: 'SettingsFootnote(status)' }, {
    counts: { 'settings-card': { [appPage]: 1 } },
    exceptions: [{ rule: 'settings-footnote', file: appPage, count: 1, reason: 'status text' }],
  })
  expect(runApp(root).stderr).toContain('--config app/ci/ui-rules.json --update')
  expect(runApp(root, '--update').status).toBe(0)
  expect(runApp(root).status).toBe(0)
  expect(JSON.parse(readFileSync(join(root, 'app/ci/ui-rules-baseline.json'), 'utf8')).counts).toEqual({})
  writeFileSync(join(root, appPage), 'SettingsFootnote(status)\nSettingsCard(')
  expect(runApp(root, '--update').status).toBe(1)
  expect(JSON.parse(readFileSync(join(root, 'app/ci/ui-rules-baseline.json'), 'utf8')).counts).toEqual({})
})
