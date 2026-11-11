// Shared UI-rule scanner and lowering-only baseline ratchet. Client patterns live in --config JSON files.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name)
  return entry.isDirectory() ? walk(path) : [path]
})

/** Every matching instance, with paths relative to the configured root and original line numbers. */
export function scan(root, config) {
  const hits = []
  const filePattern = new RegExp(config.filePattern)
  const excluded = config.excludeFilePattern && new RegExp(config.excludeFilePattern)
  const rules = Object.entries(config.rules).map(([id, rule]) => [id, {
    ...rule,
    patterns: rule.patterns.map((pattern) => new RegExp(pattern, 'g')),
    excluded: rule.excludeFilePattern && new RegExp(rule.excludeFilePattern),
    blank: rule.blankPattern && new RegExp(rule.blankPattern, 'g'),
    nearby: rule.nearby && { ...rule.nearby, pattern: new RegExp(rule.nearby.pattern) },
  }])
  const files = new Set(config.roots.flatMap((top) => existsSync(join(root, top)) ? walk(join(root, top)) : []))
  for (const path of [...files].sort()) {
    const file = relative(root, path).split(sep).join('/')
    if (!filePattern.test(file) || excluded && excluded.test(file)) continue
    const source = readFileSync(path, 'utf8')
    for (const [id, rule] of rules) {
      if (!rule.paths.some((prefix) => file.startsWith(prefix))
        || rule.excludePaths?.some((prefix) => file.startsWith(prefix))
        || rule.excluded && rule.excluded.test(file)) continue
      // Blank allowed blocks without moving diagnostic line numbers.
      const lines = (rule.blank ? source.replace(rule.blank, (block) => block.replace(/[^\n]/g, ' ')) : source).split('\n')
      lines.forEach((text, i) => {
        if (rule.nearby && !lines.slice(Math.max(0, i - rule.nearby.lines), i + rule.nearby.lines + 1)
          .some((line) => rule.nearby.pattern.test(line))) return
        for (const pattern of rule.patterns) {
          for (const match of text.matchAll(pattern)) {
            if (!rule.ignoreValues?.includes(match[1])) hits.push({ rule: id, file, line: i + 1 })
          }
        }
      })
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
function exceptionErrors(baseline, rules) {
  return (baseline.exceptions ?? []).flatMap((e, i) => {
    const where = `exceptions[${i}] (${e?.rule ?? '?'} ${e?.file ?? '?'})`
    const errors = []
    if (!(e?.rule in rules)) errors.push(`${where}: unknown rule`)
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
function check(hits, baseline, text, rules, update) {
  const errors = exceptionErrors(baseline, rules)
  const counts = tally(hits)
  for (const [rule, file] of keys(hits, baseline)) {
    const actual = counts[rule]?.[file] ?? 0
    const allowed = allowance(baseline, rule, file)
    if (actual > allowed) {
      errors.push(`${file}: ${actual} ${rule} (allowed ${allowed}): ${rules[rule]?.message ?? 'unknown rule'}`)
      for (const h of hits) if (h.rule === rule && h.file === file) errors.push(`  ${h.file}:${h.line} ${rule}: ${rules[rule].message}`)
    } else if (actual < allowed) {
      const exempt = allowed - (baseline.counts?.[rule]?.[file] ?? 0)
      errors.push(actual < exempt
        ? `${file}: ${actual} ${rule}, below its exceptions' ${exempt}; lower or remove that exceptions entry`
        : `${file}: ${actual} ${rule}, below the baseline's ${allowed}; run ${update}`)
    }
  }
  if (!errors.length && text !== serialize(baseline)) errors.push(`ui-rules-baseline.json is not sorted and formatted; run ${update}`)
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

/** CLI paths are relative to cwd; root and baseline are relative to the config and root, respectively. */
export function main(cwd = process.cwd(), args = process.argv.slice(2)) {
  const index = args.indexOf('--config')
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('check-ui-rules: --config <path> is required')
  const configPath = resolve(cwd, args[index + 1])
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const root = resolve(dirname(configPath), config.root)
  const path = resolve(root, config.baseline)
  const update = `node ${relative(cwd, import.meta.filename).split(sep).join('/')} --config ${args[index + 1]} --update`
  const text = existsSync(path) ? readFileSync(path, 'utf8') : serialize({})
  const baseline = JSON.parse(text)
  const hits = scan(root, config)
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
  const errors = check(hits, baseline, text, config.rules, update)
  if (errors.length) {
    console.error(`check-ui-rules: ${errors.length} problem(s) (${args[index + 1]})`)
    for (const e of errors) console.error(e.startsWith('  ') ? e : ' - ' + e)
    return 1
  }
  console.log(`check-ui-rules: ${hits.length} counted instance(s), none above the baseline`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try { process.exitCode = main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
