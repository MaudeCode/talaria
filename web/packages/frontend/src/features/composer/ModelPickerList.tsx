import { useImperativeHandle, useLayoutEffect, useRef, type ReactNode, type Ref } from 'react'
import { Combobox } from '@base-ui/react/combobox'
import { useVirtualizer } from '@tanstack/react-virtual'

export interface ModelPickerListHandle { reveal: (key: string) => void }

/**
 * The model picker's scrolling, virtualized rows (TAL-1858). React Compiler skips a component that calls
 * `useVirtualizer`, so the hook lives in this file alone. On mount the `reveal` row is centred; a new query starts from
 * the top; `handle.reveal` keeps a keyboard highlight in view. `VirtualHistory` is the transcript's: it owns reader
 * anchoring and scroll restoration against the page's pane, which a popup list inside a listbox does not have.
 */
export function ModelPickerList<R extends { key: string }>({ handle, rows, estimateSize, reveal, query, render }: { handle: Ref<ModelPickerListHandle>; rows: R[]; estimateSize: (row: R) => number; reveal: string; query: string; render: (row: R) => ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => { const row = rows[i]; return row ? estimateSize(row) : 0 },
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 8,
  })
  const indexOf = (key: string) => rows.findIndex((row) => row.key === key)
  useImperativeHandle(handle, () => ({ reveal: (key) => { const i = indexOf(key); if (i >= 0) virtualizer.scrollToIndex(i, { align: 'auto' }) } }))
  // Only a new query or a remount (a new tab) repositions the list; a refresh or a star keeps the scroll under the pointer.
  const positioned = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (positioned.current === query) return
    positioned.current = query
    const i = query ? -1 : indexOf(reveal)
    if (i >= 0) virtualizer.scrollToIndex(i, { align: 'center' })
    else virtualizer.scrollToOffset(0)
  })
  return (
    <Combobox.List ref={scroller} data-model-picker-list className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 py-1.5">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]
          if (!row) return null
          return <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${String(item.start)}px)` }}>{render(row)}</div>
        })}
      </div>
    </Combobox.List>
  )
}
