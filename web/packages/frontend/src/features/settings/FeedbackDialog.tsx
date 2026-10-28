import { useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { isApiError } from '../../contracts/common'
import { FEEDBACK_DRAFT_KEY as DRAFT_KEY, FeedbackDraftSchema, FeedbackDraftsSchema } from '../../contracts/persisted'
import { randomUuid } from '../../lib/randomHex'
import { readPersistedJson, removePersisted, writePersistedJson } from '../../lib/persisted'
import { currentLocale } from '../../i18n/runtime'
import { formatDurationUnits } from '../../i18n/units'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { TextInput } from '../../ui/Field'
import { LoadingState, ErrorState } from '../../ui/States'
import { cn } from '../../ui/cn'
import { dismissToast, showRichToast } from '../toast/toast'
import { showErrorToast } from '../toast/errorToast'

type Draft = z.infer<typeof FeedbackDraftSchema>
const SENT_TOAST = 'feedback-sent'
const fresh = (): Draft => ({ requestId: randomUuid(), kind: 'bug', title: '', body: '', includeDiagnostics: true })
const blank = (draft: Draft) => !/\S/.test(draft.title) && !/\S/.test(draft.body)

/**
 * Module scope so a send outlives the Help section. `draft` is the form; `held` keeps every report the server has not
 * accepted yet (sent and awaiting an answer, or set aside by a rollback), so neither a refusal nor a reload loses one.
 */
let state: { open: boolean; draft: Draft; held: Draft[] } | null = null
const inFlight = new Set<string>()
const listeners = new Set<() => void>()
const current = () => (state ??= { open: false, ...(readPersistedJson(DRAFT_KEY, FeedbackDraftsSchema) ?? { draft: fresh(), held: [] }) })
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
function update(next: Partial<{ open: boolean; draft: Draft; held: Draft[] }>): void {
  state = { ...current(), ...next }
  if (blank(state.draft) && !state.held.length) removePersisted(DRAFT_KEY)
  else writePersistedJson(DRAFT_KEY, { draft: state.draft, held: state.held })
  for (const listener of listeners) listener()
}

/** An empty form picks up the oldest held report that is not in flight (set aside by a rollback, or cut off by a reload). */
export function openFeedback(): void {
  const { draft, held } = current()
  const waiting = blank(draft) ? held.find((d) => !inFlight.has(d.requestId)) : undefined
  update(waiting ? { open: true, draft: waiting, held: held.filter((d) => d !== waiting) } : { open: true })
}

/** The server keys idempotency on the whole report, so changed content is a new request; an unchanged retry reuses its id. */
function edit(change: Partial<Omit<Draft, 'requestId'>>): void {
  update({ draft: { ...current().draft, ...change, requestId: randomUuid() } })
}

const errorCode = (error: unknown): string | null => {
  if (!isApiError(error) || typeof error.body !== 'object' || error.body === null) return null
  const code = (error.body as { error?: unknown }).error
  return typeof code === 'string' ? code : null
}
/** Relay may have taken the report, or the answer was lost: the outcome is unknown. */
const unknownOutcome = (error: unknown) => errorCode(error) === 'relay_unreachable' || (isApiError(error) && (error.kind === 'network' || error.kind === 'timeout'))

function errorText(error: unknown): string {
  switch (errorCode(error)) {
    case 'rate_limited': {
      // The quota window is one hour, so the wait is seconds or minutes.
      const seconds = Math.max(1, Number((error as { body: { retryAfterSeconds?: unknown } }).body.retryAfterSeconds) || 0)
      const wait = seconds < 60 ? formatDurationUnits(currentLocale(), [seconds, 'second']) : formatDurationUnits(currentLocale(), [Math.ceil(seconds / 60), 'minute'])
      return m.feedback_rate_limited({ wait })
    }
    case 'feedback_unavailable': return m.feedback_unavailable()
    case 'invalid': return m.feedback_invalid()
    default: return m.feedback_unreachable()
  }
}

/** Optimistic send: the form empties and confirms at once; a refusal reopens it with that report and the error. */
async function send(): Promise<void> {
  const sent = current().draft
  inFlight.add(sent.requestId)
  update({ open: false, draft: fresh(), held: [...current().held, sent] })
  showRichToast({ id: SENT_TOAST, text: m.feedback_sent(), ttl: 2500, kind: 'info', dismissible: false, actions: [] })
  const { requestId, kind, title, body, includeDiagnostics } = sent
  const input = { requestId, kind, title, body, includeDiagnostics, client: { platform: 'web' as const } }
  let refused = false
  let refusal: unknown
  try {
    try {
      await api.submitFeedback(input)
    } catch (error) {
      if (!unknownOutcome(error)) throw error
      await api.submitFeedback(input)
    }
  } catch (error) {
    refused = true
    refusal = error
  }
  inFlight.delete(requestId)
  const held = current().held.filter((d) => d.requestId !== requestId)
  if (!refused) { update({ held }); return }
  // A report written meanwhile waits behind the refused one instead of being replaced.
  const { draft } = current()
  dismissToast(SENT_TOAST)
  update({ open: true, draft: sent, held: blank(draft) ? held : [draft, ...held] })
  showErrorToast(new Error(errorText(refusal)))
}

const KINDS = [['bug', () => m.feedback_kind_bug()], ['feature', () => m.feedback_kind_feature()], ['other', () => m.feedback_kind_other()]] as const

function Diagnostics() {
  const diagnostics = useQuery({ queryKey: keys.feedbackDiagnostics, queryFn: api.fetchFeedbackDiagnostics, staleTime: 0 })
  if (diagnostics.isPending) return <LoadingState compact />
  if (diagnostics.isError) return <ErrorState error={diagnostics.error} onRetry={() => void diagnostics.refetch()} />
  return <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-input px-3 py-2 font-mono text-xs text-text [overflow-wrap:anywhere]" data-feedback-diagnostics>{diagnostics.data.text}</pre>
}

export function FeedbackDialog() {
  const { open, draft } = useSyncExternalStore(subscribe, current, current)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const ready = /\S/.test(draft.title) && /\S/.test(draft.body)
  return (
    <Dialog open={open} onOpenChange={(next) => update({ open: next })} title={m.feedback_send_open()} className="max-h-[90dvh] overflow-y-auto">
      <form className="flex flex-col gap-3 text-sm" onSubmit={(e) => { e.preventDefault(); if (ready) void send() }}>
        <div role="group" aria-label={m.feedback_kind()} className="flex gap-1 rounded-md border border-border bg-input p-1">
          {KINDS.map(([kind, label]) => (
            <button key={kind} type="button" aria-pressed={draft.kind === kind} onClick={() => edit({ kind })} className={cn('min-h-9 flex-auto whitespace-nowrap rounded px-3 text-sm text-muted hover:text-text', draft.kind === kind && 'bg-surface text-text shadow-sm')}>{label()}</button>
          ))}
        </div>
        <label className="flex flex-col gap-1">
          <span>{m.feedback_title()}</span>
          <TextInput value={draft.title} maxLength={120} onChange={(e) => edit({ title: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1">
          <span>{m.feedback_details()}</span>
          <textarea value={draft.body} maxLength={8000} rows={6} onChange={(e) => edit({ body: e.target.value })} className="min-h-9 w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-text placeholder:text-muted focus:border-accent" />
        </label>
        <div>
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={draft.includeDiagnostics} onChange={(e) => edit({ includeDiagnostics: e.target.checked })} />{m.feedback_include_diagnostics()}</label>
          <details onToggle={(e) => setShowDiagnostics(e.currentTarget.open)}>
            <summary className="cursor-pointer text-muted">{m.feedback_diagnostics_show()}</summary>
            {showDiagnostics && <Diagnostics />}
          </details>
        </div>
        <div className="mt-1 flex justify-end gap-2">
          <Button onClick={() => update({ open: false })}>{m.cancel()}</Button>
          <Button type="submit" variant="primary" disabled={!ready}>{m.feedback_send()}</Button>
        </div>
      </form>
    </Dialog>
  )
}
