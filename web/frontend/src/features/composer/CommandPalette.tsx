import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { suggestCommands, type CommandSuggestion } from './commands'
import { cn } from '../../ui/cn'

/**
 * Slash-command autocomplete rendered above the textarea. ARIA listbox with
 * aria-activedescendant; the textarea keeps focus and forwards arrow/enter/tab.
 */
export function useCommandPalette(text: string) {
  const commands = useQuery({ queryKey: keys.commands, queryFn: api.fetchCommands, staleTime: 5 * 60_000 })
  const match = /^\/([\w-]*)$/.exec(text.trimStart())
  const open = !!match
  const items: CommandSuggestion[] = open ? suggestCommands(match[1] ?? '', commands.data?.commands ?? []) : []
  const [activeState, setActiveState] = useState<{ text: string; index: number }>({ text, index: 0 })
  const active = activeState.text === text ? activeState.index : 0
  const setActive = (update: number | ((a: number) => number)) => setActiveState((s) => ({ text, index: typeof update === 'function' ? update(s.text === text ? s.index : 0) : update }))
  const listId = useId()
  const activeId = open && items[active] ? `${listId}-${items[active].name}` : undefined
  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>, apply: (s: CommandSuggestion) => void): boolean => {
    if (!open || items.length === 0) return false
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % items.length); return true }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); return true }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { const s = items[active]; if (s) { e.preventDefault(); apply(s); return true } }
    if (e.key === 'Escape') { e.preventDefault(); return true }
    return false
  }
  return { open, items, active, setActive, listId, activeId, handleKey }
}

export function CommandPaletteList({ items, active, listId, onPick, onHover }: { items: CommandSuggestion[]; active: number; listId: string; onPick: (s: CommandSuggestion) => void; onHover: (i: number) => void }) {
  if (items.length === 0) return null
  return (
    <ul id={listId} role="listbox" aria-label="Commands" className="cmd-dropdown absolute bottom-full left-0 right-0 z-20 mb-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-md">
      {items.map((s, i) => (
        <li key={s.name} id={`${listId}-${s.name}`} role="option" aria-selected={i === active} onMouseEnter={() => onHover(i)} onMouseDown={(e) => { e.preventDefault(); onPick(s) }} className={cn('flex cursor-default items-baseline gap-2 rounded-md px-2 py-1.5 text-sm', i === active && 'bg-hover')}>
          <span className="font-mono text-text">/{s.name}</span>
          {s.args && <span className="font-mono text-[11px] text-muted">{s.args}</span>}
          <span className="min-w-0 flex-1 truncate text-xs text-muted">{s.desc}</span>
          {s.source === 'server' && s.category && <span className="text-[10px] uppercase tracking-wider text-muted">{s.category}</span>}
        </li>
      ))}
    </ul>
  )
}
