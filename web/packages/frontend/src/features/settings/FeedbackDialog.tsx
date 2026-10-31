import { useRef, useState, useSyncExternalStore, type ClipboardEvent, type DragEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Paperclip } from 'lucide-react'
import type { z } from 'zod'
import { FeedbackAttachmentTypeSchema } from '@maudecode/talaria-web-contracts'
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
import { AttachmentTray, type PendingFile } from '../composer/Attachments'
import { compressImage, compressVideo, type Compressed, type FeedbackLimits } from './feedbackMedia'

type Draft = z.infer<typeof FeedbackDraftSchema>
/**
 * A report with its attachments, which live in memory only: a reload keeps the text and drops the files. `sentAs` is
 * the requestId of a refused send, which may still hold the staged files.
 */
type Report = Draft & { files: PendingFile[]; sentAs?: string | undefined }
interface State { open: boolean; draft: Report; held: Report[]; notice: string | null }
const SENT_TOAST = 'feedback-sent'
const fresh = (): Report => ({ requestId: randomUuid(), kind: 'bug', title: '', body: '', includeDiagnostics: true, files: [] })
const blank = (draft: Report) => !/\S/.test(draft.title) && !/\S/.test(draft.body) && !draft.files.length
/** The stored form drops the in-memory files (the schema strips unknown keys). */
const persisted = (report: Report): Draft => FeedbackDraftSchema.parse(report)

/**
 * Module scope so a send outlives the Help section. `draft` is the form; `held` keeps every report the server has not
 * accepted yet (sent and awaiting an answer, or set aside by a rollback), so neither a refusal nor a reload loses one.
 * `notice` is the inline attachment error under the form.
 */
let state: State | null = null
const inFlight = new Set<string>()
const listeners = new Set<() => void>()
function current(): State {
  if (state) return state
  const saved = readPersistedJson(DRAFT_KEY, FeedbackDraftsSchema)
  return (state = { open: false, notice: null, draft: saved ? { ...saved.draft, files: [] } : fresh(), held: saved?.held.map((d) => ({ ...d, files: [] })) ?? [] })
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
function update(next: Partial<State>): void {
  state = { ...current(), ...next }
  if (!/\S/.test(state.draft.title) && !/\S/.test(state.draft.body) && !state.held.length) removePersisted(DRAFT_KEY)
  else writePersistedJson(DRAFT_KEY, { draft: persisted(state.draft), held: state.held.map(persisted) })
  for (const listener of listeners) listener()
}

/** An empty form picks up the oldest held report that is not in flight (set aside by a rollback, or cut off by a reload). */
export function openFeedback(): void {
  const { draft, held } = current()
  const waiting = blank(draft) ? held.find((d) => !inFlight.has(d.requestId)) : undefined
  update(waiting ? { open: true, draft: waiting, held: held.filter((d) => d !== waiting) } : { open: true })
}

/** The server keys idempotency on the whole report, so changed content is a new request; an unchanged retry reuses its id. */
function edit(change: Partial<Omit<Report, 'requestId' | 'sentAs'>>, notice: string | null = current().notice): void {
  const draft = { ...current().draft, ...change }
  // The server binds staged files to the request that sent them; a changed report stages its files again.
  const rebind = draft.sentAs ? draft.files.filter((f) => f.status === 'done') : []
  update({ draft: { ...draft, requestId: randomUuid(), sentAs: undefined, files: draft.files.map((f) => rebind.includes(f) ? { ...f, status: 'uploading', feedback: undefined } : f) }, notice })
  for (const f of rebind) stage(f.key, f.file, null, false)
}

/**
 * One compress-then-upload job per attachment, keyed by its chip; removing the chip aborts it. A job settles with the
 * staged chip or the error that dropped it, which is what a send waiting on it reports.
 */
type Settled = { file: PendingFile } | { error: string }
const jobs = new Map<string, { abort: AbortController; done: Promise<Settled> }>()
/** The picked file's identity per chip, so picking or pasting it again adds no second chip. */
const sources = new Map<string, string>()
const sourceKey = (f: File) => `${f.name}:${String(f.size)}:${String(f.lastModified)}`
const isVideo = (f: File) => f.type.startsWith('video/')

/** Change or drop a chip wherever its report now lives: the form, or a held report waiting to send. */
function patchFile(key: string, change: Partial<PendingFile> | null, notice?: string): void {
  const fix = (r: Report): Report => r.files.some((f) => f.key === key) ? { ...r, files: change ? r.files.map((f) => f.key === key ? { ...f, ...change } : f) : r.files.filter((f) => f.key !== key) } : r
  const { draft, held } = current()
  update({ draft: fix(draft), held: held.map(fix), ...(notice === undefined ? {} : { notice }) })
}

function forget(key: string): void {
  jobs.get(key)?.abort.abort()
  jobs.delete(key)
  sources.delete(key)
}

const megabytes = (bytes: number) => new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 1 }).format(bytes / 1_000_000)
const seconds = (n: number) => n % 60 ? formatDurationUnits(currentLocale(), [n, 'second']) : formatDurationUnits(currentLocale(), [n / 60, 'minute'])
function refusalText(name: string, video: boolean, result: Exclude<Compressed, { ok: true }>, limits: FeedbackLimits): string {
  switch (result.reason) {
    case 'too_large': return m.composer_too_large({ name, max: megabytes(video ? limits.maxVideoBytes : limits.maxImageBytes) })
    case 'too_long': return m.feedback_attachment_too_long({ name, max: seconds(limits.maxVideoSeconds) })
    default: return m.feedback_attachment_unsupported({ name })
  }
}

/** Compress (unless the chip already holds the compressed file), then stage it; the busy state stays on this chip. */
function stage(key: string, source: File, limits: FeedbackLimits | null, compress: boolean): void {
  jobs.get(key)?.abort.abort()
  const abort = new AbortController()
  const live = () => jobs.get(key)?.abort === abort
  const done = (async (): Promise<Settled> => {
    let file = source
    if (compress && limits) {
      const video = isVideo(source)
      const result = video ? await compressVideo(source, limits, abort.signal) : await compressImage(source, limits)
      if (!live()) return { error: '' }
      if (!result.ok) {
        const error = refusalText(source.name, video, result, limits)
        patchFile(key, null, error)
        jobs.delete(key)
        sources.delete(key)
        return { error }
      }
      file = result.file
      patchFile(key, { file, status: 'uploading' })
    }
    try {
      const staged = await api.uploadFeedbackAttachment(file, FeedbackAttachmentTypeSchema.parse(file.type))
      const settled: PendingFile = { key, file, status: 'done', feedback: staged }
      if (live()) patchFile(key, { status: 'done', feedback: staged, error: undefined })
      return { file: settled }
    } catch (failure) {
      const error = m.composer_upload_failed({ name: file.name })
      if (live()) patchFile(key, { status: 'error', error: failure instanceof Error ? failure.message : error }, error)
      return { error }
    }
  })()
  jobs.set(key, { abort, done })
}

/** Pick, paste or drop: within the server's count, video and type limits, each new file becomes a compressing chip. */
function addFiles(incoming: Iterable<File>, limits: FeedbackLimits): void {
  const { draft } = current()
  const known = new Set(draft.files.map((f) => sources.get(f.key)))
  const picked = Array.from(incoming).filter((file, i, all) => !known.has(sourceKey(file)) && all.findIndex((f) => sourceKey(f) === sourceKey(file)) === i)
  if (!picked.length) return
  const unsupported = picked.find((f) => !(f.type.startsWith('image/') || (limits.videoAllowed && isVideo(f))))
  const files = picked.filter((f) => f !== unsupported && (f.type.startsWith('image/') || (limits.videoAllowed && isVideo(f))))
  if (draft.files.length + files.length > limits.maxCount) { update({ notice: m.feedback_attachment_limit({ n: limits.maxCount }) }); return }
  if (draft.files.filter((f) => isVideo(f.file)).length + files.filter(isVideo).length > limits.maxVideoCount) { update({ notice: m.feedback_video_limit({ n: limits.maxVideoCount }) }); return }
  const chips = files.map((file): PendingFile => ({ key: randomUuid(), file, status: 'compressing' }))
  edit({ files: [...draft.files, ...chips] }, unsupported ? m.feedback_attachment_unsupported({ name: unsupported.name }) : null)
  for (const chip of chips) { sources.set(chip.key, sourceKey(chip.file)); stage(chip.key, chip.file, limits, true) }
}

function removeFile(key: string): void {
  forget(key)
  edit({ files: current().draft.files.filter((f) => f.key !== key) }, null)
}

/** A failed upload runs again with the already compressed file; its new staged id makes it a new request. */
function retryFile(key: string, limits: FeedbackLimits): void {
  const chip = current().draft.files.find((f) => f.key === key)
  if (!chip) return
  edit({ files: current().draft.files.map((f) => f.key === key ? { ...f, status: 'uploading', error: undefined, feedback: undefined } : f) }, null)
  stage(key, chip.file, limits, false)
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

const sentToast = (text: string) => { showRichToast({ id: SENT_TOAST, text, ttl: 2500, kind: 'info', dismissible: false, actions: [] }) }

/**
 * Optimistic send: the form empties and confirms at once, then sends once its attachments are staged; a refusal, or an
 * attachment that could not be staged, reopens it with that report, its attachments and the error.
 */
async function send(): Promise<void> {
  const sent = current().draft
  const { requestId, kind, title, body, includeDiagnostics } = sent
  inFlight.add(requestId)
  update({ open: false, draft: fresh(), held: [...current().held, sent], notice: null })
  sentToast(m.feedback_sent())
  const staged = await Promise.all(sent.files.map((f) => jobs.get(f.key)?.done ?? Promise.resolve<Settled>({ file: f })))
  const failed = staged.find((s): s is { error: string } => 'error' in s)
  const attachmentIds = staged.flatMap((s) => 'file' in s && s.file.feedback ? [s.file.feedback.attachmentId] : [])
  const input = { requestId, kind, title, body, includeDiagnostics, client: { platform: 'web' as const }, ...(attachmentIds.length ? { attachmentIds } : {}) }
  let refusal: { error: unknown } | null = null
  let refused = false
  if (!failed) {
    try {
      let result
      try {
        result = await api.submitFeedback(input)
      } catch (error) {
        if (!unknownOutcome(error)) throw error
        result = await api.submitFeedback(input)
      }
      refused = result.attachments.some((a) => a.status === 'refused')
    } catch (error) {
      refusal = { error }
    }
  }
  inFlight.delete(requestId)
  // Jobs patch held reports too, so this copy carries the latest state of every attachment.
  const latest = current().held.find((d) => d.requestId === requestId) ?? sent
  const held = current().held.filter((d) => d.requestId !== requestId)
  if (!failed && !refusal) {
    for (const f of latest.files) forget(f.key)
    update({ held })
    if (refused) sentToast(m.feedback_sent_without_attachments())
    return
  }
  // A report written meanwhile waits behind the refused one instead of being replaced.
  const { draft } = current()
  dismissToast(SENT_TOAST)
  update({ open: true, draft: { ...latest, sentAs: requestId }, held: blank(draft) ? held : [draft, ...held] })
  showErrorToast(new Error(failed ? failed.error : errorText(refusal?.error)))
}

const KINDS = [['bug', () => m.feedback_kind_bug()], ['feature', () => m.feedback_kind_feature()], ['other', () => m.feedback_kind_other()]] as const

function Diagnostics() {
  const diagnostics = useQuery({ queryKey: keys.feedbackDiagnostics, queryFn: api.fetchFeedbackDiagnostics, staleTime: 0 })
  if (diagnostics.isPending) return <LoadingState compact />
  if (diagnostics.isError) return <ErrorState error={diagnostics.error} onRetry={() => void diagnostics.refetch()} />
  return <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-input px-3 py-2 font-mono text-xs text-text [overflow-wrap:anywhere]" data-feedback-diagnostics>{diagnostics.data.text}</pre>
}

export function FeedbackDialog() {
  const { open, draft, notice } = useSyncExternalStore(subscribe, current, current)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const options = useQuery({ queryKey: keys.feedbackOptions, queryFn: api.fetchFeedbackOptions, enabled: open, staleTime: 60_000 })
  const limits = options.data?.attachments.enabled && options.data.attachments.maxCount > 0 ? options.data.attachments : null
  const accept = limits?.acceptedTypes.filter((type) => limits.videoAllowed || !type.startsWith('video/')).join(',')
  const ready = /\S/.test(draft.title) && /\S/.test(draft.body) && !draft.files.some((f) => f.status === 'error')
  const onPaste = (e: ClipboardEvent<HTMLFormElement>) => {
    const files = Array.from(e.clipboardData.items).filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f)
    if (!limits || !files.length) return
    if (!e.clipboardData.getData('text/plain')) e.preventDefault()
    addFiles(files, limits)
  }
  const onDrop = (e: DragEvent<HTMLFormElement>) => { if (!limits || !e.dataTransfer.files.length) return; e.preventDefault(); addFiles(e.dataTransfer.files, limits) }
  return (
    <Dialog open={open} onOpenChange={(next) => update({ open: next })} title={m.feedback_send_open()} className="max-h-[90dvh] overflow-y-auto">
      <form className="flex flex-col gap-3 text-sm" onSubmit={(e) => { e.preventDefault(); if (ready) void send() }} onPaste={onPaste} onDragOver={(e) => { if (limits) e.preventDefault() }} onDrop={onDrop}>
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
        {limits && <AttachmentTray files={draft.files} placement="inline" onRemove={removeFile} onRetry={(key) => retryFile(key, limits)} />}
        {notice && <p role="alert" className="text-xs text-error">{notice}</p>}
        <div className="mt-1 flex items-center gap-2">
          {limits && (
            <>
              <input ref={picker} type="file" multiple hidden accept={accept} data-feedback-picker onChange={(e) => { if (e.target.files) addFiles(e.target.files, limits); e.target.value = '' }} />
              <Button onClick={() => picker.current?.click()}><Paperclip size={14} aria-hidden="true" />{m.feedback_attach()}</Button>
            </>
          )}
          <Button className="ml-auto" onClick={() => update({ open: false })}>{m.cancel()}</Button>
          <Button type="submit" variant="primary" disabled={!ready}>{m.feedback_send()}</Button>
        </div>
      </form>
    </Dialog>
  )
}
