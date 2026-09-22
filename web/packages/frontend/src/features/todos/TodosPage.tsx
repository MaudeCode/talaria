import { m } from '../../paraglide/messages.js'
import { HubPage } from '../../shell/AppShell'
import { EmptyState } from '../../ui/States'
import { useTodoState } from './todoStore'
import { readPersisted } from '../../lib/persisted'
import { SessionIdSchema } from '../../contracts/session'
import { cn } from '../../ui/cn'

function isDone(item: { status?: string | undefined; done?: boolean | undefined; completed?: boolean | undefined }): boolean {
  return item.done === true || item.completed === true || item.status === 'done' || item.status === 'completed'
}

export function TodosPage({ sessionId }: { sessionId?: string | null }) {
  const restored = SessionIdSchema.safeParse(readPersisted('hermes-webui-session'))
  const sid = sessionId ?? (restored.success ? restored.data : null)
  const state = useTodoState(sid)
  const todos = state?.todos ?? []
  return (
    <HubPage title={m.tab_todos()}>
      {todos.length === 0 && <EmptyState>{m.todos_empty()}</EmptyState>}
      {todos.length > 0 && (
        <ul className="flex flex-col divide-y divide-border-subtle" id="todoPanel" aria-label={m.todos_from_session()}>
          {todos.map((t, i) => {
            const done = isDone(t)
            return (
              <li key={String(t.id ?? i)} className="flex items-start gap-2 py-2 text-sm">
                <span aria-hidden="true" className={cn('mt-0.5 inline-flex h-4 w-4 items-center justify-center rounded border text-[10px]', done ? 'border-success bg-success text-white' : 'border-border')}>{done ? '✓' : ''}</span>
                <span className={cn(done ? 'text-muted line-through' : 'text-text')}>{t.text ?? t.content ?? t.title ?? ''}</span>
                <span className="ml-auto text-[11px] text-muted">{done ? m.todos_done() : t.status ?? m.todos_pending()}</span>
              </li>
            )
          })}
        </ul>
      )}
      {state?.description && <p className="mt-3 text-xs text-muted">{state.description}</p>}
    </HubPage>
  )
}
