/** TAL-819: the Agent's staged skill or memory writes on the Skills and Memory pages, each with its diff, approve and reject. */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { Button } from '../../ui/Button'
import { showToast } from '../toast/toast'
import { showErrorToast } from '../toast/errorToast'
import { useResourceEffects, useResourceMutation, withEffects } from '../sessions/useResourceMutation'

type Kind = 'skills' | 'memory'

export function PendingWritesPanel({ kind }: { kind: Kind }) {
  const qc = useQueryClient()
  // Background reviews and cron runs stage writes while the page is open; there is no event for them, so the panel polls.
  const pending = useQuery({ queryKey: keys.pendingWrites(kind), queryFn: () => api.fetchPendingWrites(kind), staleTime: 15_000, refetchInterval: 30_000 })
  // An answered item leaves the list at once; one the server did not apply returns with the reread.
  const effects = useResourceEffects()
  const review = useResourceMutation({
    resource: ({ id }: { verb: 'approve' | 'reject'; id: string; revision: string }) => `pending-write:${kind}:${id}`,
    queryKey: keys.pendingWrites(kind),
    effect: () => ({ remove: true }),
    mutationFn: ({ verb, id, revision }) => api.reviewPendingWrites(verb, kind, [{ id, revision }]),
    onSuccess: ({ results }) => {
      for (const r of results) showToast(r.message, r.done ? 2500 : 4000, r.done ? 'info' : 'error')
      void qc.invalidateQueries({ queryKey: kind === 'skills' ? keys.skills.all : keys.memory })
      void qc.invalidateQueries({ queryKey: keys.profiles })
    },
    onError: (e) => showErrorToast(e),
  })
  const items = withEffects(pending.data?.items ?? [], (item) => `pending-write:${kind}:${item.id}`, effects)
  if (!pending.data?.visible || items.length === 0) return null
  return (
    <section aria-labelledby={`pending-${kind}-title`} className="mb-6 flex flex-col gap-1" id={`pending-${kind}`}>
      <h3 id={`pending-${kind}-title`} className="text-[11px] font-semibold uppercase tracking-wider text-muted">{m.pending_writes_title()}</h3>
      <ul className="flex flex-col divide-y divide-border-subtle">
        {items.map((item) => (
          <li key={item.id} className="flex flex-col gap-1.5 py-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-text">{item.summary}</div>
                <div className="font-mono text-[11px] text-muted">{item.target} · {item.op}</div>
              </div>
              <div className="flex gap-2">
                <Button variant="primary" disabled={!item.approvable} onClick={() => review.mutate({ verb: 'approve', id: item.id, revision: item.revision })}>{m.pending_writes_approve()}</Button>
                <Button variant="ghost" onClick={() => review.mutate({ verb: 'reject', id: item.id, revision: item.revision })}>{m.pending_writes_reject()}</Button>
              </div>
            </div>
            <details>
              <summary className="cursor-pointer text-xs text-muted hover:text-text">{m.pending_writes_diff()}</summary>
              <pre className="mt-1.5 max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border-subtle bg-code-bg p-3 font-mono text-[11px] leading-snug text-pre-text">{item.diff}</pre>
            </details>
          </li>
        ))}
      </ul>
    </section>
  )
}
