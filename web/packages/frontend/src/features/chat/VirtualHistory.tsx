import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { defaultRangeExtractor, useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import type { VisibleMessage } from './useTranscript'

export type HistoryVirtualizer = Virtualizer<HTMLDivElement, Element>

/**
 * The opt-in virtualized history window. React Compiler skips any component that calls `useVirtualizer`, so the hook
 * lives in this child alone and the rest of the transcript compiles. `handle` exposes the instance to the transcript's
 * scroll restoration; it is set before the parent's layout effects run.
 */
export function VirtualHistory({ rows, estimateSize, handle, renderRow, anchorKey, onCommit }: {
  rows: VisibleMessage[]
  estimateSize: (index: number) => number
  handle: RefObject<HistoryVirtualizer | null>
  renderRow: (row: VisibleMessage, index: number) => ReactNode
  /** The reader's anchor row stays mounted, so a measurement that moves it out of the window can still be corrected. */
  anchorKey: () => string | null
  /** Runs after every commit, before paint: rows measured above the reader move in the same frame as the correction. */
  onCommit: () => void
}) {
  // The pane is found from the list itself: when both mount in one commit (entering a cached session), the parent's
  // pane ref is attached only after this child's layout effects, where the virtualizer reads its scroll element.
  const listRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current?.closest<HTMLDivElement>('#messages') ?? null,
    estimateSize,
    overscan: 8,
    getItemKey: (i) => rows[i]?.key ?? i,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range)
      const key = anchorKey()
      const index = key === null ? -1 : rows.findIndex((row) => row.key === key)
      if (index < 0 || indexes.includes(index)) return indexes
      return index < (indexes[0] ?? 0) ? [index, ...indexes] : [...indexes, index]
    },
  })
  // The transcript's follow and reader anchor own the scroll position. TanStack's own compensation for a row measured above
  // the fold moves the pane before the list's height catches up, and on iOS WebKit it defers that compensation and replays
  // the sum once scrolling stops, on top of positions already settled (TAL-1177).
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false
  useLayoutEffect(() => { onCommit() })
  useLayoutEffect(() => {
    handle.current = virtualizer
    return () => { handle.current = null }
  }, [handle, virtualizer])
  return (
    <div ref={listRef} data-virtual-history style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      {virtualizer.getVirtualItems().map((v) => {
        const row = rows[v.index]
        if (!row) return null
        return (
          <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}>
            {renderRow(row, v.index)}
          </div>
        )
      })}
    </div>
  )
}
