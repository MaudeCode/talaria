import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import type { VisibleMessage } from './useTranscript'

export type HistoryVirtualizer = Virtualizer<HTMLDivElement, Element>

/**
 * The opt-in virtualized history window. React Compiler skips any component that calls `useVirtualizer`, so the hook
 * lives in this child alone and the rest of the transcript compiles. `handle` exposes the instance to the transcript's
 * scroll restoration; it is set before the parent's layout effects run.
 */
export function VirtualHistory({ rows, estimateSize, followsRef, handle, renderRow }: {
  rows: VisibleMessage[]
  estimateSize: (index: number) => number
  followsRef: RefObject<() => boolean>
  handle: RefObject<HistoryVirtualizer | null>
  renderRow: (row: VisibleMessage, index: number) => ReactNode
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
  })
  // While following, the transcript's follow owns the scroll position. The virtualizer's own compensation for a row measured
  // above the fold moves the pane up before the list's height catches up, which reads as the reader leaving the end
  // (a fresh transcript measures many rows at once). Elsewhere (reading up, a deep link) its default keeps rows still.
  useLayoutEffect(() => {
    Object.defineProperty(virtualizer, 'shouldAdjustScrollPositionOnItemSizeChange', { configurable: true, get: () => (followsRef.current() ? () => false : undefined) })
  }, [virtualizer, followsRef])
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
