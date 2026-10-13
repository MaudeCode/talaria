/**
 * TAL-886: the memory page shows MEMORY.md, USER.md and SOUL.md through `redactString`, so a save submits masks
 * (`ghp_Ab...6789`, `***`) where the file holds secrets. `restoreMasks` puts each secret back: a mask still where the
 * page showed it keeps its own value, and one moved or copied elsewhere is mapped back by its text, refused when that
 * text masks more than one value.
 */
import { HttpFailure } from '../sessions/service.js'

type Op = readonly ['=', number, number] | readonly ['-', number, -1] | readonly ['+', -1, number]

/** Past this many token edits the save is treated as a rewrite: unchanged masks are then found by their text. */
const MAX_EDITS = 2_000

const tokens = (text: string): string[] => text.match(/\s+|\S+/g) ?? []

/** Myers' shortest edit script from `a` to `b` (`=` keeps, `-` deletes, `+` inserts), or null past `MAX_EDITS`. */
function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length
  const m = b.length
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
  const ops1 = diffTokens(a, b)
  const runs: [start: number, end: number][] = []
  ops1.forEach(([kind], n) => {
    if (kind === '=') return
    const last = runs.at(-1)
    if (last?.[1] === n) last[1] = n + 1
    else runs.push([n, n + 1])
  })
  const shows = ([start, end]: [number, number]): boolean => ops1.slice(start, end).some(([kind]) => kind === '+')
  for (let n = 0; n < runs.length && runs.length > 1; ) {
    if (shows(runs[n]!)) { n += 1; continue }
    const at = n > 0 ? n - 1 : n
    runs.splice(at, 2, [runs[at]![0], runs[at + 1]![1]])
    n = at
  }
  const hunks: { original: string; mask: string; first: number; last: number }[] = []
  const hunkOf = new Int32Array(b.length).fill(-1)
  for (const [start, end] of runs) {
    const hunk = { original: '', mask: '', first: -1, last: -1 }
    for (const [kind, i, j] of ops1.slice(start, end)) {
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
  for (const hunk of hunks) if (hunk.mask) meanings.set(hunk.mask, (meanings.get(hunk.mask) ?? new Set()).add(hunk.original))
  const c = tokens(submitted)
  const ops = diffTokens(b, c)
  const keptAt = new Int32Array(b.length).fill(-1)
  for (const [kind, j, k] of ops) if (kind === '=') keptAt[j] = k
  // A mask is still in place when every one of its tokens is, side by side.
  const inPlace = hunks.map((hunk) => {
    const start = keptAt[hunk.first]
    if (start === undefined || start < 0) return false
    for (let j = hunk.first; j <= hunk.last; j += 1) if (keptAt[j] !== start + j - hunk.first) return false
    return true
  })
  const masks = [...meanings.keys()].sort((x, y) => y.length - x.length)
  const maskRe = masks.length ? new RegExp(`(?<!\\S)(?:${masks.map(escapeRe).join('|')})(?!\\S)`, 'g') : null
  // Text the user moved, copied or typed: a mask in it maps back by its text alone.
  const restoreLoose = (text: string): string => (maskRe ? text.replace(maskRe, (mask) => {
    const values = [...meanings.get(mask)!]
    if (values.length > 1) throw new HttpFailure(422, `The memory page shows "${mask}" for more than one hidden value, so the save cannot tell which one it means. Put it back where it was, or type the value.`, { code: 'memory_mask_ambiguous', mask })
    return values[0]!
  }) : text)
  let out = ''
  let loose = ''
  const flush = (): void => { out += restoreLoose(loose); loose = '' }
  for (const [kind, j, k] of ops) {
    if (kind === '-') continue
    if (kind === '+') { loose += c[k]!; continue }
    const hunk = hunkOf[j]!
    if (hunk >= 0 && inPlace[hunk]) {
      if (j === hunks[hunk]!.first) { flush(); out += hunks[hunk]!.original }
    } else if (hunk >= 0 || !b[j]!.trim()) loose += b[j]!
    else { flush(); out += b[j]! }
  }
  flush()
  return out
}
