import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PromptQueueAction, PromptQueueCard, PromptQueueCardInput, PromptQueueRun } from '@maudecode/talaria-web-contracts'
import { isDefiniteRefusal } from '../../contracts/common'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { HubPage } from '../../shell/AppShell'
import { Button } from '../../ui/Button'
import { Select } from '../../ui/Select'
import { ErrorState, LoadingState } from '../../ui/States'
import { randomHex } from '../../lib/randomHex'
import { getStreamContext, useStreamContext } from '../../stream/connection'
import { QueueCard } from '../composer/QueueCard'
import type { QueuedTurn } from '../composer/queue'
import { newResource, useResourceEffects, useResourceMutation, withCreated, withEffects } from '../sessions/useResourceMutation'
import { showErrorToast } from '../toast/errorToast'
import { statusLabel } from './automationStatus'

export const promptQueuesKey = ['prompt-queues'] as const
const resource = (run: PromptQueueRun) => `prompt-queue:${run.id}`
export const queueSelection = (id: string) => `queue:${id}`
const actionLabel = (action: PromptQueueAction) => ({ start: m.prompt_queue_start(), pause: m.prompt_queue_pause(), resume: m.prompt_queue_resume(), cancel: m.prompt_queue_cancel(), reconcile: m.prompt_queue_reconcile() })[action]
const queued = (card: PromptQueueCard, profile: string): QueuedTurn => ({ id: card.request_id, text: card.text, attachments: [], request: { profile } })

/** Extends Tasks' automation workbench; all dispatch and settlement remain on the server. */
export function usePromptQueues(selectedId: string | null, select: (id: string | null) => void): { runs: PromptQueueRun[]; body: ReactNode } {
  const context = useStreamContext()
  const effects = useResourceEffects()
  const [draft, setDraft] = useState<{ owner: object; cards: Draft[]; requestId: string } | null>(null)
  const query = useQuery({ queryKey: promptQueuesKey, queryFn: async () => ({ ...await api.fetchPromptQueues(), context }), structuralSharing: false, refetchInterval: 2000 })
  const runs = withCreated(withEffects(query.data?.context === context ? query.data.runs : [], resource, effects), 'prompt-queue', effects)
  const action = useResourceMutation({
    resource: ({ run, owner }: { run: PromptQueueRun; action: PromptQueueAction; owner: object }) => {
      if (owner !== getStreamContext()) throw new Error(m.error_generic())
      return resource(run)
    },
    queryKey: promptQueuesKey,
    effect: ({ action }) => ({ fields: { ...(action === 'reconcile' ? {} : { phase: action === 'start' || action === 'resume' ? 'running' : action === 'pause' ? 'paused' : 'cancelled' }), actions: [], editable: false } }),
    mutationFn: ({ run, action }) => api.promptQueueAction({ id: run.id, revision: run.revision, action }),
    onError: showErrorToast,
  })
  const edit = useResourceMutation({
    resource: ({ run, owner }: { run: PromptQueueRun; cards: PromptQueueCard[]; owner: object }) => {
      if (owner !== getStreamContext()) throw new Error(m.error_generic())
      return resource(run)
    },
    queryKey: promptQueuesKey,
    effect: ({ cards }) => ({ fields: { cards } }),
    mutationFn: ({ run, cards }) => api.editPromptQueue({ id: run.id, revision: run.revision, cards }),
    onError: showErrorToast,
  })
  const create = useResourceMutation({
    resource: ({ temporary, owner }: { temporary: PromptQueueRun; cards: PromptQueueCardInput[]; requestId: string; owner: object }) => {
      if (owner !== getStreamContext()) throw new Error(m.error_generic())
      return temporary.id
    },
    queryKey: promptQueuesKey,
    effect: ({ temporary }) => ({ fields: temporary }),
    mutationFn: ({ cards, requestId }) => api.createPromptQueue({ request_id: requestId, cards }),
    onSuccess: (run, { owner }) => { if (owner === getStreamContext()) { setDraft(null); select(queueSelection(run.id)) } },
    onError: (error) => { showErrorToast(error); if (isDefiniteRefusal(error)) select('queue:new') },
  })
  let body: ReactNode = null
  if (selectedId === 'queue:new') body = <QueueBuilder key="new-queue" initial={draft?.owner === context ? draft : null} onSave={(cards, requestId) => {
    setDraft({ owner: context, cards, requestId })
    const id = newResource('prompt-queue')
    const temporary: PromptQueueRun = { id, title: cards[0]?.text ?? '', profile: '', revision: 0, phase: 'draft', current_step: 0, cards: cards.map((c) => ({ ...c, request_id: randomHex(), title: c.session_id, backend: 'direct', authority_epoch: null, status: 'waiting', stream_id: null, admission_id: null, outcome: null })), actions: [], editable: false, error: null }
    create.mutate({ temporary, cards, requestId, owner: context })
    select(queueSelection(id))
  }} />
  else if (selectedId?.startsWith('queue:')) {
    const run = runs.find((r) => queueSelection(r.id) === selectedId)
    if (query.isPending) body = <HubPage title={m.prompt_queue_title()}><LoadingState /></HubPage>
    else if (query.isError) body = <HubPage title={m.prompt_queue_title()}><ErrorState error={query.error} onRetry={() => { void query.refetch() }} /></HubPage>
    else if (run) body = <HubPage title={run.title} help={m.prompt_queue_help()} actions={run.actions.map((act) => <Button key={act} variant="ghost" onClick={() => action.mutate({ run, action: act, owner: context })}>{actionLabel(act)}</Button>)}>
      <p role="status" className="mb-4 text-sm text-muted">{statusLabel(run.phase).label}</p>
      {run.error && <p role="alert" className="mb-4 text-sm text-error">{run.error}</p>}
      <QueueCard sessionId="" ariaLabel={run.title} queued={run.cards.map((card) => queued(card, run.profile))} readOnly={!run.editable} rowLabel={(id) => <span className="truncate text-xs text-muted">{run.cards.find((c) => c.request_id === id)?.title}</span>} rowStatus={(id) => <span className="shrink-0 text-xs text-muted">{run.cards.find((c) => c.request_id === id) && statusLabel(run.cards.find((c) => c.request_id === id)?.status ?? 'unknown').label}</span>} onChange={(rows) => {
        if (!rows.length) { action.mutate({ run, action: 'cancel', owner: context }); return }
        const cards = rows.flatMap((row) => { const card = run.cards.find((c) => c.request_id === row.id); return card ? [{ ...card, text: row.text }] : [] })
        edit.mutate({ run, cards, owner: context })
      }} />
    </HubPage>
  }
  return { runs, body }
}

type Draft = QueuedTurn & PromptQueueCardInput & { title: string }
/** Only device-local drafts live here. Saving creates a draft run; starting is always a separate action. */
function QueueBuilder({ initial, onSave }: { initial: { cards: Draft[]; requestId: string } | null; onSave: (cards: Draft[], requestId: string) => void }) {
  const context = useStreamContext()
  const [owner] = useState(context)
  const [cards, setCards] = useState<Draft[]>(initial?.cards ?? [])
  const [requestId] = useState(() => initial?.requestId ?? randomHex())
  const [sid, setSid] = useState('')
  const [text, setText] = useState('')
  const sessions = useQuery({ queryKey: keys.sessions.list({}), queryFn: () => api.fetchSessions() })
  const add = () => {
    if (owner !== getStreamContext()) return
    const target = sessions.data?.sessions.find((s) => s.session_id === sid)
    if (!target || !text.trim()) return
    setCards([...cards, { id: randomHex(), session_id: sid, project_id: target.project_id ?? null, title: target.title || sid, text: text.trim(), attachments: [], request: { profile: target.profile ?? 'default' } }])
    setText('')
  }
  return <HubPage title={m.prompt_queue_new()} help={m.prompt_queue_help()} actions={<Button disabled={!cards.length || owner !== context} onClick={() => { if (owner === getStreamContext()) onSave(cards, requestId) }}>{m.prompt_queue_save()}</Button>}>
    {sessions.isError && <ErrorState error={sessions.error} onRetry={() => { void sessions.refetch() }} />}
    <div className="mb-5 flex max-w-2xl flex-col gap-3">
      <label className="text-sm" htmlFor="queue-target">{m.prompt_queue_chat()}</label>
      <Select id="queue-target" aria-label={m.prompt_queue_chat()} value={sid} onValueChange={setSid} placeholder={m.prompt_queue_chat()}>{(sessions.data?.sessions ?? []).map((s) => <option key={s.session_id} value={s.session_id}>{s.title || s.session_id}</option>)}</Select>
      <label className="text-sm" htmlFor="queue-message">{m.prompt_queue_message()}</label>
      <textarea id="queue-message" className="min-h-24 rounded-(--r-sm) border border-border bg-surface p-3 text-sm" value={text} onChange={(e) => setText(e.target.value)} maxLength={32000} />
      <Button className="self-start" disabled={!sid || !text.trim() || cards.length >= 100} onClick={add}>{m.prompt_queue_add()}</Button>
    </div>
    {!cards.length && <p className="text-sm text-muted">{m.prompt_queue_empty()}</p>}
    <QueueCard sessionId="" ariaLabel={m.prompt_queue_new()} queued={cards} onChange={(rows) => setCards(rows.flatMap((row) => { const card = cards.find((c) => c.id === row.id); return card ? [{ ...card, text: row.text }] : [] }))} rowLabel={(id) => <span className="truncate text-xs text-muted">{cards.find((c) => c.id === id)?.title}</span>} />
  </HubPage>
}
