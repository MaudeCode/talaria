import { useId, useLayoutEffect, useRef, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { AtSign, File, Folder } from 'lucide-react'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useDebounced } from '../../lib/useDebounced'
import { toSuggestion, type CommandSuggestion } from './commands'
import { cn } from '../../ui/cn'

const PATH_ICONS = { file: File, folder: Folder, reference: AtSign }

/**
 * TAL-1342: an owner chat's path completions for the draft before the caret, once typing pauses. The server picks the word,
 * its candidates and their insertion text; another chat's answer is never shown, even while this one's loads.
 */
function usePathCompletions(paths: { sessionId: string; before: string } | null) {
  const sent = paths ? { sessionId: paths.sessionId, before: paths.before.slice(-1024) } : null
  const settled = useDebounced(sent && JSON.stringify([sent.sessionId, sent.before]), 150)
  const [sessionId = '', before = ''] = settled ? JSON.parse(settled) as [string, string] : []
  const query = useQuery({
    queryKey: keys.pathCompletions(sessionId, before),
    queryFn: ({ signal }) => api.completePaths(sessionId, before, signal),
    enabled: !!settled && !!sent?.before.trim(), staleTime: 30_000,
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[2] === sent?.sessionId ? previous : undefined,
  })
  const current = !!sent && sessionId === sent.sessionId && before === sent.before && query.isSuccess && !query.isPlaceholderData
  // Only this chat's answer: right after a switch the settled key, and so the data, is still the previous chat's.
  const answer = sessionId === sent?.sessionId && query.data?.replace_from != null && query.data.items.length ? query.data : null
  // The rows' offsets count from the start of what was sent, which may be the draft's tail.
  const offset = paths && answer ? paths.before.length - before.length + (answer.replace_from ?? 0) : 0
  const items: CommandSuggestion[] = answer?.items.map((item) => ({ name: item.label, desc: item.detail, path: { kind: item.kind, insert: item.insert, from: offset } })) ?? []
  return { items, stale: !current }
}

/**
 * Slash-command autocomplete rendered above the textarea. ARIA listbox with
 * aria-activedescendant; the textarea keeps focus and forwards arrow/enter/tab.
 *
 * TAL-2314: the server answers each typed prefix with its rows, in order. While the draft's own answer loads, the
 * previous prefix's rows stay shown as `stale` and no key, hover or click picks from them: Enter submits the typed text as
 * when nothing matches, and Tab and the arrows do nothing. A failed read leaves keys to the composer.
 */
export function useCommandPalette(text: string, sessionId: string | null, paths: { sessionId: string; before: string } | null = null) {
  const match = /^\/([\w-]*)$/.exec(text.trimStart())
  const slash = !!match
  const prefix = match?.[1] ?? ''
  const commands = useQuery({ queryKey: keys.commandSuggestions(prefix, sessionId), queryFn: ({ signal }) => api.fetchCommands(prefix, sessionId, signal), enabled: slash, staleTime: 5 * 60_000, placeholderData: keepPreviousData })
  const completions = usePathCompletions(slash ? null : paths)
  // Escape closes path completions until the draft changes.
  const [dismissed, setDismissed] = useState<string | null>(null)
  const pathOpen = !slash && completions.items.length > 0 && dismissed !== text
  const open = slash || pathOpen
  const stale = slash ? !commands.isError && (commands.isPlaceholderData || !commands.isSuccess) : pathOpen && completions.stale
  const items: CommandSuggestion[] = slash ? (commands.data?.commands ?? []).map(toSuggestion) : pathOpen ? completions.items : []
  // The selection belongs to one completion target: the draft and, for path rows, the word before the caret. A list that
  // shrinks under it keeps its last row selected.
  const target = slash ? text : `${text}\n${paths?.before ?? ''}`
  const [activeState, setActiveState] = useState<{ target: string; index: number }>({ target, index: 0 })
  const active = activeState.target === target ? Math.min(activeState.index, Math.max(items.length - 1, 0)) : 0
  const setActive = (update: number | ((a: number) => number)) => setActiveState(() => ({ target, index: typeof update === 'function' ? update(active) : update }))
  const listId = useId()
  const activeId = open && !stale && items[active] ? `${listId}-${String(active)}` : undefined
  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>, apply: (s: CommandSuggestion) => void): boolean => {
    if (!open || e.key === 'Enter' && stale) return false
    if (stale && (e.key === 'Tab' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); return true }
    if (items.length === 0) return false
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % items.length); return true }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); return true }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { const s = items[active]; if (s) { e.preventDefault(); apply(s); return true } }
    if (e.key === 'Escape') { e.preventDefault(); if (pathOpen) setDismissed(text); return true }
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
    <ul ref={list} id={listId} role="listbox" aria-label={items[0]?.path ? 'Files' : 'Commands'} aria-busy={stale || undefined} style={room === undefined ? undefined : { '--palette-room': `${String(room)}px` } as React.CSSProperties} className="absolute bottom-full left-0 right-0 z-20 mb-1 max-h-[min(--spacing(64),var(--palette-room,100vh))] overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-md">
      {items.map((s, i) => (
        <li key={s.path?.insert ?? s.name} id={`${listId}-${String(i)}`} role="option" aria-selected={!stale && i === active} onMouseEnter={() => { if (!stale) onHover(i) }} onMouseDown={(e) => { e.preventDefault(); if (!stale) onPick(s) }} className={cn('flex cursor-default items-baseline gap-2 rounded-md px-2 py-1.5 text-sm', stale ? 'opacity-60' : i === active && 'bg-hover')}>
          {s.path ? <PathLabel kind={s.path.kind} label={s.name} /> : <span className="font-mono text-text">/{s.name}</span>}
          {s.args && <span className="font-mono text-[11px] text-muted">{s.args}</span>}
          <span className="min-w-0 flex-1 truncate text-xs text-muted">{s.desc}</span>
          {s.category && <span className="text-xs uppercase tracking-wider text-muted">{s.category}</span>}
        </li>
      ))}
    </ul>
  )
}

function PathLabel({ kind, label }: { kind: keyof typeof PATH_ICONS; label: string }) {
  const Icon = PATH_ICONS[kind]
  return <span className="flex min-w-0 items-center gap-1.5 self-center font-mono text-text"><Icon size={13} className="shrink-0 text-muted" aria-hidden="true" /><span className="truncate">{label}</span></span>
}
