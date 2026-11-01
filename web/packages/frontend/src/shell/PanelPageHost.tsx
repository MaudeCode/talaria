/**
 * TAL-373: one right panel, many pages. The host owns the tabs (selection, keyboard, focus, accessible state) and the
 * shared panel (edge toggle, resize, close, mobile drawer); each page owns its data, actions and navigation. A new page
 * is a component plus an entry in the caller's `pages` list. Every page stays mounted while the panel is, hidden when
 * inactive, so its state (a folder, a preview, an unsaved draft) survives tab switches; pages use `active` to stop work.
 * An inactive page sits in a hidden `Activity`, so its effects pause and its renders wait for idle time (TAL-1388).
 */
import { Activity, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { RightPanel } from './RightPanel'
import { cn } from '../ui/cn'

export interface PanelPage {
  /** Stable id: persisted as the user's choice and used in element ids. */
  id: string
  label: string
  /** The page body; `active` is false while another page is shown. */
  render: (active: boolean) => ReactNode
}

export interface PanelPageHostProps {
  open: boolean
  onToggle: () => void
  onClose: () => void
  /** Accessible name of the panel. */
  label: string
  pages: PanelPage[]
  activeId: string
  onSelect: (id: string) => void
}

/** The page shown: the requested one when it exists, else the first page. */
export function resolvePage(pages: PanelPage[], requested: string | null | undefined): PanelPage | undefined {
  return pages.find((p) => p.id === requested) ?? pages[0]
}

export function PanelPageHost({ open, onToggle, onClose, label, pages, activeId, onSelect }: PanelPageHostProps) {
  const base = useId()
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const active = resolvePage(pages, activeId)
  const tabId = (id: string) => `${base}-tab-${id}`
  const panelId = (id: string) => `${base}-page-${id}`
  // A narrow panel scrolls its tabs rather than truncating them; the selected one stays in view as the layout settles.
  // The panel mounts its header through a portal slot that can attach after this host's effects, so attaching re-runs them.
  const strip = useRef<HTMLDivElement | null>(null)
  const [stripAttached, setStripAttached] = useState(false)
  const attachStrip = (el: HTMLDivElement | null) => { strip.current = el; setStripAttached(el !== null) }
  const activeIndex = pages.findIndex((p) => p.id === active?.id)
  useLayoutEffect(() => {
    const list = strip.current
    if (!open || !list) return
    const reveal = () => {
      const tab = tabs.current[activeIndex]
      if (!tab) return
      const bounds = list.getBoundingClientRect()
      const rect = tab.getBoundingClientRect()
      if (rect.left < bounds.left) list.scrollLeft -= bounds.left - rect.left
      else if (rect.right > bounds.right) list.scrollLeft += rect.right - bounds.right
    }
    reveal()
    if (typeof ResizeObserver === 'undefined') return
    // The strip and its tabs: a late web font widens the labels without resizing the strip.
    const observer = new ResizeObserver(reveal)
    observer.observe(list)
    for (const tab of tabs.current) if (tab) observer.observe(tab)
    return () => { observer.disconnect() }
  }, [open, activeIndex, stripAttached])
  // Arrow keys move between tabs and select them (automatic activation); Home/End jump to the ends.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = pages.findIndex((p) => p.id === active?.id)
    const next = e.key === 'ArrowRight' ? index + 1 : e.key === 'ArrowLeft' ? index - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? pages.length - 1 : null
    if (next === null || !pages.length) return
    e.preventDefault()
    const target = (next + pages.length) % pages.length
    const page = pages[target]
    if (!page) return
    onSelect(page.id)
    tabs.current[target]?.focus()
  }
  const tablist = (
    <div ref={attachStrip} role="tablist" aria-label={label} className="panel-tabs flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" onKeyDown={onKeyDown}>
      {pages.map((p, i) => {
        const selected = p.id === active?.id
        return (
          <button
            key={p.id}
            ref={(el) => { tabs.current[i] = el }}
            type="button"
            role="tab"
            id={tabId(p.id)}
            aria-selected={selected}
            aria-controls={panelId(p.id)}
            tabIndex={selected ? 0 : -1}
            data-page={p.id}
            // Labels stay whole; the tab strip scrolls, so the focus ring is drawn inside the tab, never clipped by it.
            className={cn('panel-tab shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent', selected ? 'bg-surface-subtle text-text' : 'text-muted hover:text-text')}
            onClick={() => onSelect(p.id)}
          >
            {p.label}
          </button>
        )
      })}
    </div>
  )
  return (
    <RightPanel open={open} onToggle={onToggle} onClose={onClose} label={label} panelId="pages" title={tablist}>
      {pages.map((p) => (
        <div key={p.id} role="tabpanel" id={panelId(p.id)} aria-labelledby={tabId(p.id)} hidden={p.id !== active?.id} className="flex min-h-0 flex-1 flex-col" data-page-panel={p.id}>
          <Activity mode={p.id === active?.id ? 'visible' : 'hidden'}>{p.render(open && p.id === active?.id)}</Activity>
        </div>
      ))}
    </RightPanel>
  )
}
