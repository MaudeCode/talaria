import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { AcceptedSourceReference } from '@maudecode/talaria-web-contracts'
import { fetchSourceReferences } from '../../api/endpoints'
import { useDebounced } from '../../lib/useDebounced'
import { m } from '../../paraglide/messages.js'
import { Dialog } from '../../ui/Dialog'
import { ErrorState } from '../../ui/States'
import { relativeTime, SessionListItem } from './SessionListPanel'

/** Extends the sidebar's session row with selection; the server owns candidates and accepted labels. */
export function SessionReferences({ profile, selected, onChange }: {
  profile: string
  selected: AcceptedSourceReference[]
  onChange?: (selected: AcceptedSourceReference[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const q = useDebounced(query, 200)
  const candidates = useQuery({ queryKey: ['session-reference-candidates', profile, q], queryFn: ({ signal }) => fetchSourceReferences(q, signal), enabled: open, staleTime: 0 })
  if (!onChange && !selected.length) return null
  return <div className="pointer-events-auto mx-auto max-w-(--msg-max) flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-muted" data-testid="session-references">
    {onChange && <button type="button" className="min-h-11 hover:text-text" onClick={() => setOpen(true)}>{m.session_references()}</button>}
    {!onChange && <span>{m.session_references()}</span>}
    {selected.map((ref) => onChange
      ? <button key={ref.session_id} title={ref.title} type="button" className="min-h-11 max-w-48 content-center truncate hover:text-text" aria-label={m.session_reference_remove({ title: ref.title })} onClick={() => onChange(selected.filter((r) => r.session_id !== ref.session_id))}>{ref.title} ×</button>
      : <Link key={ref.session_id} title={ref.title} to="/session/$sessionId" params={{ sessionId: ref.tip_session_id }} className="min-h-11 max-w-48 content-center truncate hover:text-text">{ref.title}</Link>)}
    {onChange && <Dialog open={open} onOpenChange={setOpen} title={m.session_references()}>
      <input type="search" maxLength={200} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={m.session_reference_search()} placeholder={m.session_reference_search()} className="mb-3 w-full rounded-md border border-border bg-input px-3 py-2 text-sm" />
      {candidates.isError && <ErrorState error={candidates.error} onRetry={() => { void candidates.refetch() }} />}
      {candidates.isPending && <p role="status">{m.loading()}</p>}
      {candidates.data && <>
        <div className="max-h-[50dvh] overflow-y-auto" role="group" aria-label={m.session_references()}>
          {candidates.data.sessions.map((row) => {
            const ref = row.source_reference
            const chosen = selected.some((s) => s.session_id === ref.session_id)
            return <SessionListItem key={row.session_id} row={row} active={false} proj={undefined} preview={undefined} timeLabel={relativeTime(row.sort_ts)} onArchive={() => undefined} selection={{ selected: chosen, disabled: !chosen && selected.length >= candidates.data.max_sources, onSelect: () => onChange(chosen ? selected.filter((s) => s.session_id !== ref.session_id) : [...selected, { ...ref, title: row.title }]) }} />
          })}
        </div>
        {!candidates.data.sessions.length && <p>{m.session_reference_empty()}</p>}
        <p className="mt-2 text-xs text-muted">{m.session_reference_count({ selected: selected.length, max: candidates.data.max_sources })}</p>
      </>}
      <div className="mt-3 flex justify-end"><button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-hover" onClick={() => setOpen(false)}>{m.done()}</button></div>
    </Dialog>}
  </div>
}
