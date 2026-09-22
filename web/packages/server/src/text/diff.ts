/**
 * Unified diff in the shape Python's `difflib.unified_diff(..., lineterm="")`
 * emits: `---`/`+++` headers, `@@` hunks with 3 lines of context, and lines
 * that keep their own line endings (callers pass `splitlines(keepends=True)`).
 */

interface Op { tag: 'equal' | 'replace' | 'delete' | 'insert'; i1: number; i2: number; j1: number; j2: number }

/** Longest-common-subsequence opcodes (Myers would be smaller; this is O(n·m) but the inputs are small files). */
export function opcodes(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  // ponytail: O(n*m) LCS table; switch to Myers if rollback diffs of large files show up in profiles.
  const table: Uint32Array[] = []
  for (let i = 0; i <= n; i += 1) table.push(new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = table[i]!
    const next = table[i + 1]!
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  const push = (tag: Op['tag'], i1: number, i2: number, j1: number, j2: number): void => {
    const last = ops[ops.length - 1]
    if (last?.tag === tag && last.i2 === i1 && last.j2 === j1) {
      last.i2 = i2
      last.j2 = j2
      return
    }
    ops.push({ tag, i1, i2, j1, j2 })
  }
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      push('equal', i, i + 1, j, j + 1)
      i += 1
      j += 1
    } else if (j < m && (i >= n || ((table[i]!)[j + 1] ?? 0) >= ((table[i + 1])?.[j] ?? 0))) {
      push('insert', i, i, j, j + 1)
      j += 1
    } else {
      push('delete', i, i + 1, j, j)
      i += 1
    }
  }
  // Merge adjacent delete+insert pairs into replace blocks like difflib does.
  const merged: Op[] = []
  for (const op of ops) {
    const last = merged[merged.length - 1]
    if (last && ((last.tag === 'delete' && op.tag === 'insert') || (last.tag === 'insert' && op.tag === 'delete')) && last.i2 === op.i1 && last.j2 === op.j1) {
      merged[merged.length - 1] = { tag: 'replace', i1: last.i1, i2: op.i2, j1: last.j1, j2: op.j2 }
      continue
    }
    merged.push({ ...op })
  }
  return merged
}

function formatRange(start: number, stop: number): string {
  const beginning = start + 1
  const length = stop - start
  if (length === 1) return String(beginning)
  return `${String(length ? beginning : beginning - 1)},${String(length)}`
}

export function unifiedDiff(a: string[], b: string[], fromFile: string, toFile: string, context = 3): string[] {
  const ops = opcodes(a, b)
  const groups: Op[][] = []
  // difflib.SequenceMatcher.get_grouped_opcodes
  let codes = ops.map((o) => ({ ...o }))
  if (!codes.length) codes = [{ tag: 'equal', i1: 0, i2: 1, j1: 0, j2: 1 }]
  const first = codes[0]
  if (first?.tag === 'equal') Object.assign(first, { i1: Math.max(first.i1, first.i2 - context), j1: Math.max(first.j1, first.j2 - context) })
  const last = codes[codes.length - 1]
  if (last?.tag === 'equal') Object.assign(last, { i2: Math.min(last.i2, last.i1 + context), j2: Math.min(last.j2, last.j1 + context) })
  const nn = context + context
  let group: Op[] = []
  for (const op of codes) {
    let { i1, j1 } = op
    const { i2, j2, tag } = op
    if (tag === 'equal' && i2 - i1 > nn) {
      group.push({ tag, i1, i2: Math.min(i2, i1 + context), j1, j2: Math.min(j2, j1 + context) })
      groups.push(group)
      group = []
      i1 = Math.max(i1, i2 - context)
      j1 = Math.max(j1, j2 - context)
    }
    group.push({ tag, i1, i2, j1, j2 })
  }
  if (group.length && !(group.length === 1 && group[0]?.tag === 'equal')) groups.push(group)
  const out: string[] = []
  let started = false
  for (const g of groups) {
    if (!started) {
      started = true
      out.push(`--- ${fromFile}`, `+++ ${toFile}`)
    }
    const gFirst = g[0]!
    const gLast = g[g.length - 1]!
    out.push(`@@ -${formatRange(gFirst.i1, gLast.i2)} +${formatRange(gFirst.j1, gLast.j2)} @@`)
    for (const op of g) {
      if (op.tag === 'equal') {
        for (const line of a.slice(op.i1, op.i2)) out.push(` ${line}`)
        continue
      }
      if (op.tag === 'replace' || op.tag === 'delete') for (const line of a.slice(op.i1, op.i2)) out.push(`-${line}`)
      if (op.tag === 'replace' || op.tag === 'insert') for (const line of b.slice(op.j1, op.j2)) out.push(`+${line}`)
    }
  }
  return out
}
