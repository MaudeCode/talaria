import { useId, useLayoutEffect, useRef, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { toSuggestion, type CommandSuggestion } from './commands'
import { cn } from '../../ui/cn'

/**
 * Slash-command autocomplete rendered above the textarea. ARIA listbox with
 * aria-activedescendant; the textarea keeps focus and forwards arrow/enter/tab.
 *
 * TAL-2314: the server answers each typed prefix with its rows, in order. While the draft's own answer loads, the
 * previous prefix's rows stay shown as `stale` and no key, hover or click picks from them: Enter submits the typed text as
 * when nothing matches, and Tab and the arrows do nothing. A failed read leaves keys to the composer.
 */
export function useCommandPalette(text: string) {
  const match = /^\/([\w-]*)$/.exec(text.trimStart())
  const open = !!match
  const prefix = match?.[1] ?? ''
  const commands = useQuery({ queryKey: keys.commandSuggestions(prefix), queryFn: ({ signal }) => api.fetchCommands(prefix, signal), enabled: open, staleTime: 5 * 60_000, placeholderData: keepPreviousData })
  const stale = open && !commands.isError && (commands.isPlaceholderData || !commands.isSuccess)
  const items: CommandSuggestion[] = open ? (commands.data?.commands ?? []).map(toSuggestion) : []
  const [activeState, setActiveState] = useState<{ text: string; index: number }>({ text, index: 0 })
  const active = activeState.text === text ? activeState.index : 0
  const setActive = (update: number | ((a: number) => number)) => setActiveState((s) => ({ text, index: typeof update === 'function' ? update(s.text === text ? s.index : 0) : update }))
  const listId = useId()
  const activeId = open && !stale && items[active] ? `${listId}-${items[active].name}` : undefined
  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>, apply: (s: CommandSuggestion) => void): boolean => {
    if (!open || e.key === 'Enter' && stale) return false
    if (stale && (e.key === 'Tab' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); return true }
    if (items.length === 0) return false
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % items.length); return true }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); return true }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { const s = items[active]; if (s) { e.preventDefault(); apply(s); return true } }
    if (e.key === 'Escape') { e.preventDefault(); return true }
    return false
  }
  return { open, items, stale, active, setActive, listId, activeId, handleKey }
}

export function CommandPaletteList({ items, stale, active, listId, onPick, onHover }: { items: CommandSuggestion[]; stale: boolean; active: number; listId: string; onPick: (s: CommandSuggestion) => void; onHover: (i: number) => void }) {
  const list = useRef<HTMLUListElement>(null)
  const [room, setRoom] = useState<number>()
  // TAL-2627: the list opens upward, so it is capped by the room between the card and the top of the chat stage (the
  // area under the header; `main` outside a chat), less its 4px margin and a 4px gap, and scrolls its rows there.
  // Measured after every render and resize.
  useLayoutEffect(() => {
    const el = list.current
    if (!el?.parentElement) return
    const card = el.parentElement
    const fit = () => setRoom(Math.max(0, Math.floor(card.getBoundingClientRect().top - (el.closest('.chat-stage, main')?.getBoundingClientRect().top ?? 0) - 8)))
    fit()
    window.addEventListener('resize', fit)
    window.visualViewport?.addEventListener('resize', fit)
    return () => { window.removeEventListener('resize', fit); window.visualViewport?.removeEventListener('resize', fit) }
  })
  // The active row stays in view. Only the list scrolls: scrollIntoView would also scroll the clipped area under the header.
  useLayoutEffect(() => {
    const el = list.current
    const row = el?.children[active] as HTMLElement | undefined
    if (el && row) el.scrollTop = Math.min(Math.max(el.scrollTop, row.offsetTop + row.offsetHeight - el.clientHeight), row.offsetTop)
  }, [active, room])
  if (items.length === 0) return null
  return (
    <ul ref={list} id={listId} role="listbox" aria-label="Commands" aria-busy={stale || undefined} style={room === undefined ? undefined : { '--palette-room': `${String(room)}px` } as React.CSSProperties} className="absolute bottom-full left-0 right-0 z-20 mb-1 max-h-[min(--spacing(64),var(--palette-room,100vh))] overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-md">
      {items.map((s, i) => (
        <li key={s.name} id={`${listId}-${s.name}`} role="option" aria-selected={!stale && i === active} onMouseEnter={() => { if (!stale) onHover(i) }} onMouseDown={(e) => { e.preventDefault(); if (!stale) onPick(s) }} className={cn('flex cursor-default items-baseline gap-2 rounded-md px-2 py-1.5 text-sm', stale ? 'opacity-60' : i === active && 'bg-hover')}>
          <span className="font-mono text-text">/{s.name}</span>
          {s.args && <span className="font-mono text-[11px] text-muted">{s.args}</span>}
          <span className="min-w-0 flex-1 truncate text-xs text-muted">{s.desc}</span>
          {s.category && <span className="text-xs uppercase tracking-wider text-muted">{s.category}</span>}
        </li>
      ))}
    </ul>
  )
}
