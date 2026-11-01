/** Sub-pixel rounding between adjacent rows' rects; anything larger is an overlap. */
const OVERLAP_PX = 0.5

/** A row's viewport box, or null when it has none (`display: none`): such a row has no place in the visual order. */
export type RowBox = Pick<DOMRect, 'top' | 'bottom' | 'height'> | null

/** Each row's box, read once per capture however many lookups ask for it. */
export function rowBoxes(rows: readonly Element[]): (index: number) => RowBox {
  const boxes = new Map<number, RowBox>()
  return (index) => {
    const cached = boxes.get(index)
    if (cached !== undefined) return cached
    const rect = rows[index]?.getBoundingClientRect()
    const box = !rect || (rect.width === 0 && rect.height === 0) ? null : rect
    boxes.set(index, box)
    return box
  }
}

/** The first row at or after `from` (and before `to`) that has a box, or -1. */
export function nextBoxed(box: (index: number) => RowBox, from: number, to: number): number {
  for (let index = from; index < to; index++) if (box(index)) return index
  return -1
}

/** The reference order walk: the first boxed row ending below `edge`. Used whenever the rows are out of visual order. */
function scanRowPast(count: number, edge: number, box: (index: number) => RowBox): number {
  for (let index = 0; index < count; index++) if ((box(index)?.bottom ?? -Infinity) > edge) return index
  return -1
}

/**
 * The first boxed row, in visual order, whose bottom passes `edge`, or -1. Top-level transcript rows stack in DOM order,
 * so their bottoms only grow: the search gallops from the start (a reader near the top reads only its own rows) and then
 * bisects, reading O(log n) rows instead of every row above the reader. A row without a box is skipped, never compared.
 * The stacking is checked where it matters, at the crossing: a row overlapping its predecessor there (a negative margin,
 * or a virtualized row measured taller than its estimate) falls back to the full walk.
 */
export function firstRowPast(count: number, edge: number, box: (index: number) => RowBox): number {
  // Every boxed row before `low` ends at or above `edge`; `found` passes it.
  let low = 0, high = count, found = -1, step = 1
  for (let probe = 0; probe < count; probe = low + step, step *= 2) {
    const at = nextBoxed(box, probe, count)
    if (at < 0) { high = probe; break }
    if ((box(at)?.bottom ?? -Infinity) > edge) { found = at; high = probe; break }
    low = at + 1
  }
  while (low < high) {
    const mid = (low + high) >>> 1
    const at = nextBoxed(box, mid, found < 0 ? high : found)
    if (at < 0) { high = mid; continue }
    if ((box(at)?.bottom ?? -Infinity) > edge) { found = at; high = mid } else low = at + 1
  }
  const crossing = box(found)
  if (found <= 0 || !crossing) return found
  // Stacked rows start where the previous boxed row ends (that row was read by the search). One that starts above it
  // overlaps the crossing, where the order decides the result, so the full walk answers instead.
  for (let index = found - 1; index >= 0; index--) {
    const previous = box(index)
    if (previous) return previous.bottom - crossing.top > OVERLAP_PX ? scanRowPast(count, edge, box) : found
  }
  return found
}

/**
 * The reader's anchor row between `top` and `bottom`, or -1: the first fully visible row, else the row the view starts
 * inside (the walk in Transcript before TAL-1631, which read every row above the reader). One locator serves the
 * reader capture and the before-prepend capture.
 */
export function readerAnchorRow(count: number, top: number, bottom: number, box: (index: number) => RowBox): number {
  const first = firstRowPast(count, top, box)
  const start = first < 0 ? null : box(first)
  if (!start || start.top >= bottom) return -1
  if (start.top >= top) return first
  const next = nextBoxed(box, first + 1, count)
  const following = next < 0 ? null : box(next)
  if (!following || following.top >= bottom) return first
  if (following.top >= top) return next
  // A following row that also starts above the view overlaps the first one: walk the rest in full, as the reference does.
  for (let index = next + 1; index < count; index++) {
    const row = box(index)
    if (!row || row.bottom <= top) continue
    if (row.top >= bottom) break
    if (row.top >= top) return index
  }
  return first
}
