import { m } from '../../paraglide/messages.js'
import { HubPage } from '../../shell/AppShell'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { useTranscript } from '../chat/useTranscript'
import { readPersisted } from '../../lib/persisted'
import { SessionIdSchema } from '../../contracts/session'
import { cn } from '../../ui/cn'

export function TodosPage({ sessionId }: { sessionId?: string | null }) {
  const restored = SessionIdSchema.safeParse(readPersisted('hermes-webui-session'))
  const sid = sessionId ?? (restored.success ? restored.data : null)
  const { session, query } = useTranscript(sid)
  const state = session?.todo_state
  const todos = state?.display_items ?? []
  return (
    <HubPage title={m.tab_todos()}>
      {query.isError && <ErrorState error={query.error} onRetry={() => { void query.refetch() }} />}
      {query.isPending && sid && <LoadingState />}
      {!query.isError && (!sid || !query.isPending) && todos.length === 0 && <EmptyState>{m.todos_empty()}</EmptyState>}
      {todos.length > 0 && (
        <ul className="flex flex-col divide-y divide-border-subtle" id="todoPanel" aria-label={m.todos_from_session()}>
          {todos.map((t, i) => {
            const done = t.state === 'completed'
            return (
              <li key={String(t.id ?? i)} className="flex items-start gap-2 py-2 text-sm">
                <span aria-hidden="true" className={cn('mt-0.5 inline-flex h-4 w-4 items-center justify-center rounded border text-[10px]', done ? 'border-success bg-success text-white' : 'border-border')}>{done ? '✓' : ''}</span>
                <span className={cn(done ? 'text-muted line-through' : 'text-text')}>{t.text}</span>
                <span className="ml-auto text-[11px] text-muted">{t.state === 'completed' ? m.todos_done() : t.state === 'in_progress' ? m.live_working() : t.state === 'cancelled' ? m.prompt_queue_cancelled() : m.todos_pending()}</span>
              </li>
            )
          })}
        </ul>
      )}
      {state?.description && <p className="mt-3 text-xs text-muted">{state.description}</p>}
    </HubPage>
  )
}
