import { useId, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronDown, ChevronUp, ListChecks } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { HubPage } from '../../shell/AppShell'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { Row, RowList, SectionHeader } from '../../ui/List'
import { useTranscript } from '../chat/useTranscript'
import { readPersisted } from '../../lib/persisted'
import { SessionIdSchema } from '../../contracts/session'
import { cn } from '../../ui/cn'
import type { Session } from '../../contracts'

export function TodosPage({ sessionId }: { sessionId?: string | null }) {
  const restored = SessionIdSchema.safeParse(readPersisted('hermes-webui-session'))
  const sid = sessionId ?? (restored.success ? restored.data : null)
  const { session, query } = useTranscript(sid)
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
          <TodoList state={session.todo_state} />
        </section>
      )}
    </HubPage>
  )
}

/** A chat's server-ordered todos, as the Todos hub page, (TAL-2154) the chat panel's Todos page and (TAL-1122) the chat's task list strip show them. */
export function TodoList({ state }: { state: Session['todo_state'] }) {
  const todos = state?.display_items ?? []
  return (
    <>
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
    </>
  )
}

/**
 * TAL-1122: the chat's task list as the opt-in strip at the top of the reading column, closed until its header opens it.
 * Its rows are `TodoList`'s and its count is the server's `plan_progress`; it is absent while the server lists no item.
 * Open, only the list scrolls, inside the height `.chat-task-list` caps.
 */
export function ChatTaskList({ state }: { state: Session['todo_state'] }) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  if (!state?.display_items?.length) return null
  const progress = state.plan_progress
  return (
    <section className="chat-task-list flex shrink-0 flex-col border-b border-border px-5 max-[641px]:px-2.5">
      <div className="mx-auto flex min-h-0 w-full max-w-(--msg-max) flex-col">
        <button type="button" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => setOpen((o) => !o)} className="flex min-h-11 w-full shrink-0 items-center gap-2 text-left text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-accent">
          <ListChecks size={14} aria-hidden="true" />
          <span className="text-sm font-semibold text-text">{m.tab_todos()}</span>{' '}
          {progress && progress.total > 0 && <span className="text-xs tabular-nums">{m.bg_agents_progress({ done: progress.completed, total: progress.total })}</span>}
          {open ? <ChevronUp size={14} className="ml-auto" aria-hidden="true" /> : <ChevronDown size={14} className="ml-auto" aria-hidden="true" />}
        </button>
        {open && <div id={bodyId} data-task-list-body="" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto pb-2"><TodoList state={state} /></div>}
      </div>
    </section>
  )
}
