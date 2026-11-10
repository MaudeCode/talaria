import { Link } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import { HubPage } from '../../shell/AppShell'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { Row, RowList, SectionHeader } from '../../ui/List'
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
      {!sid && <EmptyState><Link to="/" className="text-accent hover:underline">{m.todos_open_chat()}</Link></EmptyState>}
      {sid && query.isPending && <LoadingState />}
      {sid && session && (
        <section data-section="todos" className="flex flex-col gap-2">
          <SectionHeader>
            <Link to="/session/$sessionId" params={{ sessionId: sid }} className="text-inherit no-underline hover:text-text">{session.title || m.untitled()}</Link>
          </SectionHeader>
          {todos.length === 0 ? <EmptyState>{m.todos_chat_empty()}</EmptyState> : (
            <RowList id="todoPanel" aria-label={m.todos_from_session()}>
              {todos.map((t, i) => {
                const done = t.state === 'completed'
                return (
                  <Row compact key={String(t.id ?? i)}>
                    <span aria-hidden="true" className={cn('inline-flex h-4 w-4 shrink-0 items-center justify-center self-center rounded border text-xs', done ? 'border-success bg-success text-white' : 'border-border')}>{done ? '✓' : ''}</span>
                    <span className={cn('min-w-0 flex-1 text-sm', done ? 'text-muted line-through' : 'text-text')}>{t.text}</span>
                    <span className="ml-auto text-[11px] text-muted">{t.state === 'completed' ? m.todos_done() : t.state === 'in_progress' ? m.live_working() : t.state === 'cancelled' ? m.prompt_queue_cancelled() : m.todos_pending()}</span>
                  </Row>
                )
              })}
            </RowList>
          )}
          {state?.description && <p className="text-xs text-muted">{state.description}</p>}
        </section>
      )}
    </HubPage>
  )
}
