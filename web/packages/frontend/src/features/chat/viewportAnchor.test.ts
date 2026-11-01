import { expect, it } from 'vitest'
import { firstRowPast, readerAnchorRow, type RowBox } from './viewportAnchor'

/** Synthetic layout: each row's viewport top and height; `null` is a `display: none` row. */
type Layout = ({ top: number; height: number } | null)[]

/** The reader walk Transcript ran before TAL-1631, over every row's raw rect (a hidden row reads as all zeros). */
function referenceAnchor(layout: Layout, top: number, bottom: number): number {
  let anchor = -1
  for (const [index, row] of layout.entries()) {
    const rect = row ? { top: row.top, bottom: row.top + row.height } : { top: 0, bottom: 0 }
    if (rect.top >= bottom) break
    if (rect.bottom <= top) continue
    if (anchor < 0 || rect.top >= top) anchor = index
    if (rect.top >= top) break
  }
  return anchor
}

/** The before-prepend lookup Transcript ran before TAL-1631. */
const referencePast = (layout: Layout, edge: number) => layout.findIndex((row) => (row ? row.top + row.height : 0) > edge)

function measured(layout: Layout) {
  const reads: number[] = []
  const box = (index: number): RowBox => {
    reads.push(index)
    const row = layout[index]
    return row ? { top: row.top, bottom: row.top + row.height, height: row.height } : null
  }
  return { reads, box }
}

/** Rows stacked in flow order from `start`, the way the transcript lays out its top-level rows. */
function stacked(heights: (number | null)[], start: number): Layout {
  let y = start
  return heights.map((height) => {
    if (height === null) return null
    const row = { top: y, height }
    y += height
    return row
  })
}

function random(seed: number) {
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed / 2_147_483_648
  }
}

it('matches the reference walk for mixed, empty, tall and hidden rows at every scroll position', () => {
  const next = random(1631)
  for (let trial = 0; trial < 400; trial++) {
    const count = [0, 1, 2, 3, 7, 40, 250][trial % 7]!
    // Grouped assistant turns are tall, tool rows short, markers empty; some rows are hidden.
    const heights = Array.from({ length: count }, () => {
      const kind = next()
      return kind < 0.1 ? null : kind < 0.2 ? 0 : kind < 0.3 ? 900 + Math.round(next() * 2000) : 20 + Math.round(next() * 400)
    })
    const total = heights.reduce<number>((sum, height) => sum + (height ?? 0), 0)
    // The pane sits at a non-negative viewport offset; its view starts anywhere from above the first row to past the last.
    const paneTop = Math.round(next() * 80), paneBottom = paneTop + 600
    const layout = stacked(heights, paneTop - Math.round(next() * (total + 1200)) + 600)
    const reader = measured(layout)
    expect(readerAnchorRow(count, paneTop, paneBottom, reader.box), `trial ${trial}`).toBe(referenceAnchor(layout, paneTop, paneBottom))
    expect(firstRowPast(count, paneTop, measured(layout).box), `trial ${trial}`).toBe(referencePast(layout, paneTop))
  }
})

it.each([
  { name: 'fully visible first row', start: 20, expected: 0 },
  { name: 'partly visible first row', start: -40, expected: 1 },
  { name: 'view inside one tall row', start: -40, height: 800, expected: 0 },
  { name: 'every row above the view', start: -6000, expected: -1 },
  { name: 'every row below the view', start: 700, expected: -1 },
])('keeps the anchor choice: $name', ({ start, height = 100, expected }) => {
  const layout = stacked(Array.from({ length: 10 }, () => height), start)
  expect(readerAnchorRow(layout.length, 0, 600, measured(layout).box)).toBe(expected)
  expect(referenceAnchor(layout, 0, 600)).toBe(expected)
})

it('skips hidden rows on either side of the bisection point', () => {
  const heights = Array.from({ length: 600 }, (_, i) => (i % 3 === 1 || (i > 280 && i < 320) ? null : 100))
  const layout = stacked(heights, -30_040)
  const reader = measured(layout)
  const anchor = readerAnchorRow(layout.length, 0, 600, reader.box)
  expect(anchor).toBe(referenceAnchor(layout, 0, 600))
  expect(layout[anchor]).toEqual({ top: 60, height: 100 })
  expect(new Set(reader.reads).size).toBeLessThan(100)
})

it('falls back to the full walk when rows overlap out of flow order', () => {
  // The row before the crossing reaches 50px into the first row the view starts in (a negative margin).
  const layout = stacked(Array.from({ length: 600 }, () => 100), -50_060)
  layout[499] = { top: -160, height: 150 }
  const reader = measured(layout)
  expect(readerAnchorRow(layout.length, 0, 600, reader.box)).toBe(referenceAnchor(layout, 0, 600))
  expect(new Set(reader.reads).size, 'the fallback walks the rows').toBeGreaterThan(500)
  const prepend = measured(layout)
  expect(firstRowPast(layout.length, 0, prepend.box)).toBe(referencePast(layout, 0))
  expect(new Set(prepend.reads).size).toBeGreaterThan(500)
  // The same rows in flow order bisect.
  const orderly = measured(stacked(Array.from({ length: 600 }, () => 100), -50_060))
  expect(readerAnchorRow(600, 0, 600, orderly.box)).toBe(501)
  expect(new Set(orderly.reads).size).toBeLessThanOrEqual(24)
})

it.each([
  { rows: 600, budget: 24 },
  { rows: 1200, budget: 28 },
])('reads at most $budget of $rows orderly rows for a reader near the tail', ({ rows, budget }) => {
  for (let back = 1; back <= 40; back++) {
    const layout = stacked(Array.from({ length: rows }, () => 100), -(rows - back) * 100 - 40)
    const reader = measured(layout)
    expect(readerAnchorRow(rows, 0, 600, reader.box)).toBe(referenceAnchor(layout, 0, 600))
    expect(new Set(reader.reads).size, `${back} rows from the end`).toBeLessThanOrEqual(budget)
  }
})

it('reads only the first rows when the reader is at the start', () => {
  const layout = stacked(Array.from({ length: 1200 }, () => 100), -40)
  const reader = measured(layout)
  expect(readerAnchorRow(layout.length, 0, 600, reader.box)).toBe(1)
  expect([...new Set(reader.reads)].sort((a, b) => a - b)).toEqual([0, 1])
})
