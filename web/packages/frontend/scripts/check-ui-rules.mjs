// UI rules check (TAL-2103): counts patterns docs/design-system.md forbids in non-test `.tsx` under src/features and
// src/shell (src/ui defines the primitives, so it is exempt). A ratchet against scripts/ui-rules-baseline.json: a
// count above its allowance fails with every `file:line`; a count below it fails until `--update` lowers the baseline.
// Only a hand-written `exceptions` entry with a reason raises an allowance.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const ALLOWED_SIZES = new Set(['11px', '13px', '20px'])
/** The Settings row kit, which defines its rows on `FieldRow`. */
const SETTINGS_KIT = new Set(['src/features/settings/SettingsRows.tsx', 'src/features/settings/SettingsGroup.tsx'])
const UPDATE = 'node scripts/check-ui-rules.mjs --update'
/** TAL-2131: the folders that wear marks, dots and symbol buttons instead of chips, pills and words (design-system §7, §12). */
const SYMBOL_FOLDERS = ['settings', 'profiles', 'workspaces', 'logs', 'connectors'].map((folder) => `src/features/${folder}/`)
const inSymbolFolders = (file) => SYMBOL_FOLDERS.some((folder) => file.startsWith(folder))
/** A class string with both `rounded-full` and a border width (`border`, `border-2`, `border-t`): a pill, not a dot or a bar. */
const PILL = /(?<![\w-])rounded-full(?![\w-])[^"'`]*?(?<![\w-])border(?:-[0-9]+|-[xytblr])?(?![\w-])|(?<![\w-])border(?:-[0-9]+|-[xytblr])?(?![\w-])[^"'`]*?(?<![\w-])rounded-full(?![\w-])/g
/** Blanks every `<DialogFooter>` block, keeping its line breaks, so a dialog's confirm and cancel words are not counted. */
const withoutDialogFooters = (text) => text.replace(/<DialogFooter(?![\w$])[\s\S]*?<\/DialogFooter>/g, (block) => block.replace(/[^\n]/g, ' '))

/** Each rule: the paths it scans (prefixes relative to the package), a matcher returning one entry per hit, and its message. */
const RULES = {
  card: {
    scope: (file) => file.startsWith('src/features/') || file.startsWith('src/shell/'),
    match: (line) => [...line.matchAll(/rounded-(?:lg|xl|2xl) border border-border bg-surface/g)],
    message: 'design-system §1.1: no card containers; use rows or SettingsGroup',
  },
  'raw-control': {
    scope: (file) => file.startsWith('src/features/') || file.startsWith('src/shell/'),
    match: (line) => [...line.matchAll(/type="(?:checkbox|radio|range)"/g)],
    message: 'use Switch, MenuCheckboxItem, MenuRadioItem or Slider',
  },
  pill: {
    scope: inSymbolFolders,
    match: (line) => [...line.matchAll(/<Badge(?![\w$])/g), ...line.matchAll(PILL)],
    message: 'design-system §7: no Badge or pill here; a state is a StatusDot, a selection a Mark, a plan or kind word joins the second line',
  },
  'success-text': {
    scope: (file) => file.startsWith('src/features/') || file.startsWith('src/shell/'),
    match: (line) => [...line.matchAll(/(?<![\w-])text-success(?![\w-])/g)],
    message: 'design-system §7: success is a StatusDot (ui/Badge.tsx) or a meter, never green text',
  },
  'word-button': {
    scope: inSymbolFolders,
    prepare: withoutDialogFooters,
    match: (line) => [...line.matchAll(/<Button(?![\w$])/g)],
    message: 'design-system §12: a symbol IconButton with an aria-label and tooltip; words stay only in a DialogFooter',
  },
  'settings-heading': {
    scope: (file) => file.startsWith('src/features/settings/'),
    match: (line) => [...line.matchAll(/<h[2-6][ >]/g)],
    message: 'use SettingsGroup or SectionHeader',
  },
  'settings-row': {
    scope: (file) => file.startsWith('src/features/settings/') && !SETTINGS_KIT.has(file),
    match: (line) => [...line.matchAll(/<FieldRow(?![\w$])/g)],
    message: 'use a SettingsRows.tsx row',
  },
  'text-size': {
    scope: (file) => file.startsWith('src/features/') || file.startsWith('src/shell/'),
    match: (line) => [...line.matchAll(/text-\[([0-9.]+px)\]/g)].filter((m) => !ALLOWED_SIZES.has(m[1])),
    message: 'design-system §10: use text-xs, text-sm or text-md (bracket sizes only 11px, 13px, 20px)',
  },
}

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name)
  return entry.isDirectory() ? walk(path) : [path]
})

/** Every hit under `root` (the frontend package): `{ rule, file, line }`, file relative to `root` with `/` separators. */
export function scan(root) {
  const hits = []
  for (const top of ['src/features', 'src/shell']) {
    if (!existsSync(join(root, top))) continue
    for (const path of walk(join(root, top)).sort()) {
      if (!path.endsWith('.tsx') || path.endsWith('.test.tsx')) continue
      const file = relative(root, path).split(sep).join('/')
      const rules = Object.entries(RULES).filter(([, rule]) => rule.scope(file))
      if (!rules.length) continue
      const source = readFileSync(path, 'utf8')
      for (const [id, rule] of rules) {
        (rule.prepare ? rule.prepare(source) : source).split('\n').forEach((text, i) => {
          for (const _ of rule.match(text)) hits.push({ rule: id, file, line: i + 1 })
        })
      }

    }
  }
  return hits
}

/** `{ rule: { file: count } }`, keys sorted by rule then file, zero counts absent. */
function tally(hits) {
  const counts = {}
  for (const { rule, file } of hits) (counts[rule] ??= {})[file] = (counts[rule][file] ?? 0) + 1
  return sortCounts(counts)
}

const sortCounts = (counts) => Object.fromEntries(Object.keys(counts).sort().filter((rule) => Object.keys(counts[rule]).length)
  .map((rule) => [rule, Object.fromEntries(Object.keys(counts[rule]).sort().map((file) => [file, counts[rule][file]]))]))

/** The baseline file's canonical text: rules then files sorted, two-space JSON, trailing newline. */
export const serialize = (baseline) => JSON.stringify({ counts: sortCounts(baseline.counts ?? {}), exceptions: baseline.exceptions ?? [] }, null, 2) + '\n'

/** Problems with the hand-written `exceptions`: unknown rule, missing file, non-positive count or an empty reason. */
function exceptionErrors(baseline) {
  return (baseline.exceptions ?? []).flatMap((e, i) => {
    const where = `exceptions[${i}] (${e?.rule ?? '?'} ${e?.file ?? '?'})`
    const errors = []
    if (!(e?.rule in RULES)) errors.push(`${where}: unknown rule`)
    if (typeof e?.file !== 'string' || !e.file) errors.push(`${where}: missing file`)
    if (!Number.isInteger(e?.count) || e.count < 1) errors.push(`${where}: count must be a positive integer`)
    if (typeof e?.reason !== 'string' || !e.reason.trim()) errors.push(`${where}: reason must be a non-empty sentence`)
    return errors
  })
}

/** Baseline count plus every exception's count for one rule and file. */
const allowance = (baseline, rule, file) => (baseline.counts?.[rule]?.[file] ?? 0)
  + (baseline.exceptions ?? []).filter((e) => e.rule === rule && e.file === file).reduce((sum, e) => sum + (Number.isInteger(e.count) ? e.count : 0), 0)

/** Every rule and file named by the tree, the baseline or an exception. */
const keys = (hits, baseline) => {
  const seen = new Set([
    ...hits.map((h) => `${h.rule}\0${h.file}`),
    ...Object.entries(baseline.counts ?? {}).flatMap(([rule, files]) => Object.keys(files).map((file) => `${rule}\0${file}`)),
    ...(baseline.exceptions ?? []).map((e) => `${e.rule}\0${e.file}`),
  ])
  return [...seen].sort().map((key) => key.split('\0'))
}

/** Compare the tree's hits with the baseline. Returns error lines; empty means pass. */
function check(hits, baseline, text = serialize(baseline)) {
  const errors = exceptionErrors(baseline)
  const counts = tally(hits)
  for (const [rule, file] of keys(hits, baseline)) {
    const actual = counts[rule]?.[file] ?? 0
    const allowed = allowance(baseline, rule, file)
    if (actual > allowed) {
      errors.push(`${file}: ${actual} ${rule} (allowed ${allowed}): ${RULES[rule]?.message ?? 'unknown rule'}`)
      for (const h of hits) if (h.rule === rule && h.file === file) errors.push(`  ${h.file}:${h.line} ${rule}: ${RULES[rule].message}`)
    } else if (actual < allowed) {
      const exempt = allowed - (baseline.counts?.[rule]?.[file] ?? 0)
      errors.push(actual < exempt
        ? `${file}: ${actual} ${rule}, below its exceptions' ${exempt}; lower or remove that exceptions entry`
        : `${file}: ${actual} ${rule}, below the baseline's ${allowed}; run ${UPDATE}`)
    }
  }
  if (!errors.length && text !== serialize(baseline)) errors.push(`ui-rules-baseline.json is not sorted and formatted; run ${UPDATE}`)
  return errors
}

/**
 * The baseline `--update` writes: each count lowered to what the tree needs beyond its exceptions, zero entries
 * removed. Never raises a count; `refused` lists the files whose tree count exceeds the allowance.
 */
function lower(hits, baseline) {
  const counts = tally(hits)
  const next = {}
  const refused = []
  for (const [rule, files] of Object.entries(baseline.counts ?? {})) {
    for (const [file, count] of Object.entries(files)) {
      const exempt = allowance(baseline, rule, file) - count
      const needed = Math.min(count, Math.max(0, (counts[rule]?.[file] ?? 0) - exempt))
      if (needed) (next[rule] ??= {})[file] = needed
    }
  }
  for (const [rule, file] of keys(hits, baseline)) if ((counts[rule]?.[file] ?? 0) > allowance(baseline, rule, file)) refused.push(`${rule} ${file}`)
  return { baseline: { counts: sortCounts(next), exceptions: baseline.exceptions ?? [] }, refused }
}

/** CLI: check, or `--update` to lower the baseline. `root` is the frontend package. */
export function main(root = resolve(import.meta.dirname, '..'), args = process.argv.slice(2)) {
  const path = join(root, 'scripts/ui-rules-baseline.json')
  const text = existsSync(path) ? readFileSync(path, 'utf8') : serialize({})
  const baseline = JSON.parse(text)
  const hits = scan(root)
  if (args.includes('--update')) {
    const { baseline: next, refused } = lower(hits, baseline)
    writeFileSync(path, serialize(next))
    if (refused.length) {
      console.error(`check-ui-rules --update: refused to raise ${refused.length} count(s); remove the new instances or add an exceptions entry with a reason`)
      for (const r of refused) console.error(' - ' + r)
      return 1
    }
    console.log('check-ui-rules --update: baseline lowered to the tree')
    return 0
  }
  const errors = check(hits, baseline, text)
  if (errors.length) {
    console.error(`check-ui-rules: ${errors.length} problem(s) (see web/TESTING.md, "UI rules")`)
    for (const e of errors) console.error(e.startsWith('  ') ? e : ' - ' + e)
    return 1
  }
  console.log(`check-ui-rules: ${hits.length} counted instance(s), none above the baseline`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) process.exitCode = main()
