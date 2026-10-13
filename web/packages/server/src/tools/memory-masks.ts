/**
 * TAL-886: the memory page shows MEMORY.md, USER.md and SOUL.md through `redactString`, so a save submits masks
 * (`ghp_Ab...6789`, `***`) where the file holds secrets. `restoreMasks` puts each secret back: a mask on a line the save
 * left unchanged keeps its own value, and one moved or copied elsewhere is mapped back by its text. A mask whose text
 * stands for more than one value, or one the save edited, is refused rather than written over its secret.
 */
import { HttpFailure } from '../sessions/service.js'

type Op = readonly ['=', number, number] | readonly ['-', number, -1] | readonly ['+', -1, number]

/** Past this many token edits, or tokens, the save is treated as a rewrite: its masks are then found by their text alone. */
const MAX_EDITS = 1_000
const MAX_TOKENS = 20_000

const tokens = (text: string): string[] => text.match(/\s+|\S+/g) ?? []

/** Myers' shortest edit script from `a` to `b` (`=` keeps, `-` deletes, `+` inserts), or null past `MAX_EDITS`. */
function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length
  const m = b.length
  if (n + m > MAX_TOKENS) return null
  const off = n + m + 1
  const v = new Int32Array(2 * off + 1)
  const trace: Int32Array[] = []
  for (let d = 0; d <= Math.min(n + m, MAX_EDITS); d += 1) {
    trace.push(v.slice(off - d - 1, off + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1 }
      v[off + k] = x
      if (x >= n && y >= m) return backtrack(trace, n, m)
    }
  }
  return null
}

function backtrack(trace: Int32Array[], n: number, m: number): Op[] {
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const at = (k: number): number => trace[d]![k + d + 1]!
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) { x -= 1; y -= 1; ops.push(['=', x, y]) }
    if (x === prevX) ops.push(['+', -1, y - 1])
    else ops.push(['-', x - 1, -1])
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) { x -= 1; y -= 1; ops.push(['=', x, y]) }
  return ops.reverse()
}

/** The edit script from `a` to `b`; a common head and tail are kept without searching. */
function diffTokens(a: string[], b: string[]): Op[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  const mid = myers(midA, midB) ?? [...midA.map((_, i): Op => ['-', i, -1]), ...midB.map((_, j): Op => ['+', -1, j])]
  const shift = (op: Op): Op => (op[0] === '=' ? ['=', op[1] + head, op[2] + head] : op[0] === '-' ? ['-', op[1] + head, -1] : ['+', -1, op[2] + head])
  return [
    ...a.slice(0, head).map((_, i): Op => ['=', i, i]),
    ...mid.map(shift),
    ...a.slice(a.length - tail).map((_, i): Op => ['=', a.length - tail + i, b.length - tail + i]),
  ]
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

interface Hunk { original: string; mask: string; first: number; last: number }

/** What marks a mask inside other text: the redactor's `***` or private-key marker, else its `abcdef...wxyz` preview. */
const markerOf = (mask: string): string =>
  ['[REDACTED PRIVATE KEY]', '***'].find((m) => mask.includes(m)) ?? /\S{6}\.\.\.\S{4}/.exec(mask)?.[0] ?? mask.trim()

/** Whether `a` is within `limit` single-character edits of `b`. */
function within(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i]
    for (let j = 1; j <= b.length; j += 1) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = row
  }
  return prev[b.length]! <= limit
}

/** A typed token that reads as an edit of `mask` (or its marker) rather than a new value: a few characters off, or bare asterisks. */
function nearMask(token: string, mask: string): boolean {
  const marker = markerOf(mask)
  if (marker === '***' && /^\*+$/.test(token)) return true
  return [marker, mask.trim()].some((text) => within(token, text, Math.max(1, text.length >> 2)))
}

const edited = (found: string): HttpFailure => new HttpFailure(422, `"${found}" hides a value the memory page does not show, and this save edits the text around it. Put it back as it was, or type the value.`, { code: 'memory_mask_edited', mask: found })

/**
 * `submitted` with every mask `redactString` put into `shown` restored to the `original` text it hides. A save of an
 * unchanged page is `original` itself.
 */
export function restoreMasks(original: string, shown: string, submitted: string): string {
  if (shown === original) return submitted
  if (submitted === shown) return original
  const a = tokens(original)
  const b = tokens(shown)
  // Each run of edits from the file to the page is one mask. A run that only drops file text (`RSA ` when the page's
  // `[REDACTED PRIVATE KEY]` aligns its `PRIVATE`) joins the run before it, or after it, so its text stays with a mask.
  const fileToPage = diffTokens(a, b)
  const runs: [start: number, end: number][] = []
  fileToPage.forEach(([kind], n) => {
    if (kind === '=') return
    const last = runs.at(-1)
    if (last?.[1] === n) last[1] = n + 1
    else runs.push([n, n + 1])
  })
  const hasInsert = ([start, end]: [number, number]): boolean => fileToPage.slice(start, end).some(([kind]) => kind === '+')
  for (let n = 0; n < runs.length && runs.length > 1; ) {
    if (hasInsert(runs[n]!)) { n += 1; continue }
    const at = n > 0 ? n - 1 : n
    runs.splice(at, 2, [runs[at]![0], runs[at + 1]![1]])
    n = at
  }
  const hunks: Hunk[] = []
  const hunkOf = new Int32Array(b.length).fill(-1)
  for (const [start, end] of runs) {
    const hunk = { original: '', mask: '', first: -1, last: -1 }
    for (const [kind, i, j] of fileToPage.slice(start, end)) {
      if (kind !== '+') hunk.original += a[i]!
      if (kind === '-') continue
      hunk.mask += b[j]!
      if (hunk.first < 0) hunk.first = j
      hunk.last = j
      hunkOf[j] = hunks.length
    }
    hunks.push(hunk)
  }
  const meanings = new Map<string, Set<string>>()
  for (const hunk of hunks) if (hunk.mask.trim()) meanings.set(hunk.mask, (meanings.get(hunk.mask) ?? new Set()).add(hunk.original))
  // A mask the page also shows as literal text (a Markdown `***`) may stand for that text too, so it never maps back by text.
  const literal = b.map((token, j) => (hunkOf[j]! >= 0 ? '\u0000' : token)).join('')
  for (const [mask, values] of meanings) if (new RegExp(`(?<!\\S)${escapeRe(mask)}(?!\\S)`).test(literal)) values.add(mask)
  const c = tokens(submitted)
  const pageToSave = diffTokens(b, c)
  const keptAt = new Int32Array(b.length).fill(-1)
  for (const [kind, j, k] of pageToSave) if (kind === '=') keptAt[j] = k
  // A mask is in place when its whole line is, token for token: a mask moved to another entry, even one that shows the same
  // `***`, is not.
  const lineBreak = (j: number): boolean => b[j]!.includes('\n')
  const inPlace = hunks.map((hunk) => {
    if (hunk.first < 0) return false
    let from = hunk.first
    while (from > 0 && !lineBreak(from) && !lineBreak(from - 1)) from -= 1
    let to = hunk.last
    while (to < b.length - 1 && !lineBreak(to) && !lineBreak(to + 1)) to += 1
    const start = keptAt[from]!
    if (start < 0) return false
    for (let j = from; j <= to; j += 1) if (keptAt[j] !== start + j - from) return false
    return true
  })
  const markers = new Set(hunks.map((hunk) => markerOf(hunk.mask)).filter(Boolean))
  const byLength = (x: string, y: string): number => y.length - x.length
  const alternatives = (list: Iterable<string>): string => [...list].sort(byLength).map(escapeRe).join('|')
  const maskRe = meanings.size ? new RegExp(`(?<!\\S)(${alternatives(meanings.keys())})(?!\\S)|${alternatives(markers)}`, 'g') : null
  // Text the user moved, copied or typed: a whole mask maps back by its text alone; a mask inside an edited word cannot.
  const restoreLoose = (text: string): string => (maskRe ? text.replace(maskRe, (found, whole: string | undefined) => {
    const values = whole === undefined ? [] : [...meanings.get(whole)!]
    if (values.length === 1) return values[0]!
    if (values.length > 1) throw new HttpFailure(422, `The memory page shows "${found}" for more than one hidden value, so the save cannot tell which one it means. Put it back where it was, or type the value.`, { code: 'memory_mask_ambiguous', mask: found })
    throw edited(found)
  }) : text)
  // A mask the save replaced with text like it (`**` for `***`) was edited, not replaced by a new value: refuse it.
  let removed: Hunk[] = []
  let typed: string[] = []
  const settle = (): void => {
    for (const hunk of removed) if (typed.some((token) => nearMask(token, hunk.mask))) throw edited(markerOf(hunk.mask))
    removed = []
    typed = []
  }
  let out = ''
  let loose = ''
  const flush = (): void => { out += restoreLoose(loose); loose = '' }
  for (const [kind, j, k] of pageToSave) {
    if (kind === '-') { const hunk = hunks[hunkOf[j]!]; if (hunk && !removed.includes(hunk)) removed.push(hunk); continue }
    if (kind === '+') { loose += c[k]!; if (c[k]!.trim()) typed.push(c[k]!); continue }
    settle()
    const hunk = hunkOf[j]!
    if (hunk >= 0 && inPlace[hunk]) {
      if (j === hunks[hunk]!.first) { flush(); out += hunks[hunk]!.original }
    } else if (hunk >= 0 || !b[j]!.trim()) loose += b[j]!
    else { flush(); out += b[j]! }
  }
  settle()
  flush()
  return out
}
