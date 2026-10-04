/**
 * Pending approval and clarify prompts per session (Python
 * `api/route_approvals.py`, `api/clarify.py`). The sidecar owns the parked
 * Agent thread; these queues are what `/api/approval/pending`,
 * `/api/clarify/pending`, and their SSE streams read.
 */
import { randomUUID } from 'node:crypto'
import type { SessionEventBus } from './events.js'
import { str } from '../util.js'
import type { ClarifyAnswers, ClarifyStep } from '@maudecode/talaria-web-contracts'

export interface PendingSubscriber { queue: Record<string, unknown>[]; wake: (() => void) | null; closed: boolean }

export const CLARIFY_DEFAULT_TIMEOUT_SECONDS = 3600
export const CLARIFY_MAX_CHOICES = 4

function choiceText(choice: unknown): string {
  if (typeof choice === 'string') return choice.trim()
  if (choice && typeof choice === 'object' && !Array.isArray(choice)) {
    for (const key of ['label', 'description', 'text', 'title']) {
      const value = (choice as Record<string, unknown>)[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
  }
  return str(choice).trim()
}

function normalizedChoices(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const choices = raw.map(choiceText).filter(Boolean).slice(0, CLARIFY_MAX_CHOICES)
  return choices.length ? choices : null
}

/**
 * Python `clarify.normalize_questions`, without its question cap: the Agent enforces its own batch limit before it
 * parks, so any non-empty list it sends stays a batch (dropping the shape would leave it waiting on an envelope).
 */
export function normalizeQuestions(questions: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(questions) || !questions.length) return null
  return questions.map((raw, index) => {
    let item: Record<string, unknown>
    if (typeof raw === 'string') item = { question: raw }
    else if (raw && typeof raw === 'object' && !Array.isArray(raw)) item = raw as Record<string, unknown>
    else item = { question: JSON.stringify(raw) }
    let text = str(item.question).trim()
    if (!text) text = JSON.stringify(item)
    const offered = normalizedChoices(item.choices_offered)
    const choices = normalizedChoices(item.choices) ?? offered
    return { qid: str(item.qid).trim() || `q${String(index)}`, id: str(item.id).trim() || null, question: text, choices, choices_offered: offered ?? choices, multi_select: Boolean(item.multi_select) && Boolean(choices) }
  })
}


/** The ordered questions a client asks, one per step; a single-question prompt is one `q0` step. */
function clarifySteps(data: Record<string, unknown>): ClarifyStep[] {
  const batch = data.questions as Record<string, unknown>[] | undefined
  if (batch) return batch.map((q) => ({ qid: str(q.qid), question: str(q.question), choices: (q.choices as string[] | null) ?? [], multi_select: Boolean(q.multi_select) }))
  const choices = normalizedChoices(data.choices_offered) ?? normalizedChoices(data.choices) ?? []
  return [{ qid: 'q0', question: str(data.question).trim(), choices, multi_select: Boolean(data.multi_select) && choices.length > 0 }]
}

/**
 * The reply string the parked Agent callback expects for keyed step answers: the batch envelope
 * (`clarify_tool._run_batch`) or the single answer (a JSON array for multi-select). Null when an answer
 * is missing, empty, keyed to an unknown step, or a list for a single-select step.
 */
export function clarifyReply(entry: Record<string, unknown>, answers: ClarifyAnswers): string | null {
  const steps = entry.steps as ClarifyStep[]
  if (Object.keys(answers).some((qid) => !steps.some((step) => step.qid === qid))) return null
  const cleaned: ClarifyAnswers = {}
  for (const step of steps) {
    const raw = answers[step.qid]
    if (Array.isArray(raw)) {
      if (!step.multi_select) return null
      const list = raw.map((v) => v.trim()).filter(Boolean)
      if (!list.length) return null
      cleaned[step.qid] = list
    } else {
      const text = str(raw).trim()
      if (!text) return null
      cleaned[step.qid] = step.multi_select ? [text] : text
    }
  }
  if (entry.questions) return JSON.stringify({ answers: cleaned })
  const only = cleaned.q0
  return Array.isArray(only) ? JSON.stringify(only) : str(only)
}

function withTimeoutMetadata(data: Record<string, unknown>, now: number): Record<string, unknown> {
  const item = { ...data }
  const requestedAt = Number(item.requested_at) || now
  const timeoutRaw = item.timeout_seconds
  // The sidecar stamps the resolved Agent timeout; only a frame without one falls back to the Python default (3600).
  const timeout = timeoutRaw === null || timeoutRaw === undefined ? CLARIFY_DEFAULT_TIMEOUT_SECONDS : Math.trunc(Number(timeoutRaw)) || 0
  item.requested_at = requestedAt
  item.timeout_seconds = timeout
  item.expires_at = timeout <= 0 ? 0 : Number(item.expires_at) || requestedAt + timeout
  return item
}

function dedupeIdentity(data: Record<string, unknown>): string {
  const questions = data.questions
  if (Array.isArray(questions) && questions.length) return JSON.stringify(questions.map((q) => { const item = q as Record<string, unknown>; return [str(item.qid), str(item.question), (item.choices as unknown[] | undefined ?? []).map(String), Boolean(item.multi_select)] }))
  return JSON.stringify([str(data.question), ((data.choices_offered as unknown[] | undefined) ?? []).map(String)])
}

class Queue {
  readonly entries: Record<string, unknown>[] = []
  readonly subscribers = new Set<PendingSubscriber>()
}

export class PendingPrompts {
  private readonly approvals = new Map<string, Queue>()
  private readonly clarifies = new Map<string, Queue>()

  constructor(private readonly events: SessionEventBus, private readonly now: () => number = () => Date.now() / 1000) {}

  private queue(map: Map<string, Queue>, sid: string): Queue {
    let q = map.get(sid)
    if (!q) {
      q = new Queue()
      map.set(sid, q)
    }
    return q
  }

  /** Forget an emptied queue only once no stream watches it: a later prompt must reach the same subscribers. */
  private prune(map: Map<string, Queue>, sid: string, q: Queue): void {
    if (!q.entries.length && !q.subscribers.size && map.get(sid) === q) map.delete(sid)
  }

  private notify(q: Queue): void {
    const payload = { pending: q.entries[0] ? { ...q.entries[0] } : null, pending_count: q.entries.length }
    for (const sub of q.subscribers) {
      if (sub.queue.length >= 16) sub.queue.shift()
      sub.queue.push(payload)
      sub.wake?.()
    }
  }

  // ── approvals ──
  submitApproval(sid: string, approval: Record<string, unknown>): Record<string, unknown> {
    const entry = { ...approval }
    entry.approval_id ??= str(entry.request_id) || randomUUID().replace(/-/g, '')
    const q = this.queue(this.approvals, sid)
    if (q.entries.some((e) => e.approval_id === entry.approval_id)) return entry
    q.entries.push(entry)
    this.notify(q)
    this.events.publish('attention_pending')
    return entry
  }

  approvalPending(sid: string): { pending: Record<string, unknown> | null; pending_count: number } {
    const q = this.approvals.get(sid)
    return { pending: q?.entries[0] ? { ...q.entries[0] } : null, pending_count: q?.entries.length ?? 0 }
  }

  /** The targeted (or oldest) approval without removing it; `found` is false only for a stale id. */
  peekApproval(sid: string, approvalId: string): { entry: Record<string, unknown> | null; found: boolean } {
    const entries = this.approvals.get(sid)?.entries ?? []
    if (!entries.length) return { entry: null, found: !approvalId }
    const entry = approvalId ? entries.find((e) => e.approval_id === approvalId) : entries[0]
    return { entry: entry ?? null, found: Boolean(entry) }
  }

  peekClarify(sid: string, clarifyId: string): Record<string, unknown> | null {
    const entries = this.clarifies.get(sid)?.entries ?? []
    return (clarifyId ? entries.find((e) => e.clarify_id === clarifyId) : entries[0]) ?? null
  }

  /** Pop the targeted (or oldest) approval; returns it or null when a stale id was given. */
  resolveApproval(sid: string, approvalId: string): { entry: Record<string, unknown> | null; found: boolean } {
    const q = this.approvals.get(sid)
    if (!q?.entries.length) return { entry: null, found: !approvalId }
    let index = 0
    if (approvalId) {
      index = q.entries.findIndex((e) => e.approval_id === approvalId)
      if (index < 0) return { entry: null, found: false }
    }
    const [entry] = q.entries.splice(index, 1)
    this.prune(this.approvals, sid, q)
    this.notify(q)
    this.events.publish('attention_resolved')
    return { entry: entry ?? null, found: true }
  }

  clearApprovals(sid: string): Record<string, unknown>[] {
    const q = this.approvals.get(sid)
    if (!q) return []
    const entries = q.entries.splice(0)
    this.prune(this.approvals, sid, q)
    this.notify(q)
    if (entries.length) this.events.publish('attention_resolved')
    return entries
  }

  /** TAL-514: drop approvals whose `request_id` the Agent no longer holds; returns the dropped entries. */
  retainApprovals(sid: string, live: ReadonlySet<string>): Record<string, unknown>[] {
    const q = this.approvals.get(sid)
    if (!q) return []
    const dropped = q.entries.filter((e) => str(e.request_id) && !live.has(str(e.request_id)))
    if (!dropped.length) return []
    q.entries.splice(0, q.entries.length, ...q.entries.filter((e) => !dropped.includes(e)))
    this.prune(this.approvals, sid, q)
    this.notify(q)
    this.events.publish('attention_resolved')
    return dropped
  }

  hasApprovalId(sid: string, approvalId: string): boolean {
    return (this.approvals.get(sid)?.entries ?? []).some((e) => e.approval_id === approvalId)
  }

  hasPendingApproval(sid: string): boolean {
    return (this.approvals.get(sid)?.entries.length ?? 0) > 0
  }

  subscribeApprovals(sid: string): [PendingSubscriber, { pending: Record<string, unknown> | null; pending_count: number }] {
    const q = this.queue(this.approvals, sid)
    const sub: PendingSubscriber = { queue: [], wake: null, closed: false }
    q.subscribers.add(sub)
    return [sub, this.approvalPending(sid)]
  }

  unsubscribeApprovals(sid: string, sub: PendingSubscriber): void {
    sub.closed = true
    const q = this.approvals.get(sid)
    q?.subscribers.delete(sub)
    if (q) this.prune(this.approvals, sid, q)
  }

  // ── clarify ──
  submitClarify(sid: string, data: Record<string, unknown>): Record<string, unknown> {
    const item = withTimeoutMetadata(data, this.now())
    // The server owns the batch shape: the normalized list (iOS reads it) and the steps every client renders.
    const batch = normalizeQuestions(item.questions)
    if (batch) item.questions = batch
    else delete item.questions
    item.steps = clarifySteps(item)
    const q = this.queue(this.clarifies, sid)
    const last = q.entries[q.entries.length - 1]
    let entry: Record<string, unknown>
    if (last && dedupeIdentity(last) === dedupeIdentity(item)) entry = last
    else {
      entry = item
      entry.clarify_id = str(item.clarify_id) || randomUUID().replace(/-/g, '')
      q.entries.push(entry)
    }
    this.notify(q)
    this.events.publish('attention_pending')
    return entry
  }

  clarifyPending(sid: string): { pending: Record<string, unknown> | null; pending_count: number } {
    const q = this.clarifies.get(sid)
    return { pending: q?.entries[0] ? { ...q.entries[0] } : null, pending_count: q?.entries.length ?? 0 }
  }

  /** Queue head plus depth: what the live chat stream carries on every head change (Python `_callback_head_payload_locked`). */
  clarifyHeadFrame(sid: string): Record<string, unknown> | null {
    const { pending, pending_count } = this.clarifyPending(sid)
    return pending ? { ...pending, pending_count } : null
  }

  /**
   * Pop a clarify by id (or the oldest). `head` is the new queue head frame when the
   * resolved entry was the head and others remain — Python re-emits it on the chat stream.
   */
  resolveClarify(sid: string, clarifyId: string): { entry: Record<string, unknown> | null; head: Record<string, unknown> | null } {
    const q = this.clarifies.get(sid)
    if (!q?.entries.length) return { entry: null, head: null }
    const index = clarifyId ? q.entries.findIndex((e) => e.clarify_id === clarifyId) : 0
    if (index < 0) return { entry: null, head: null }
    const [entry] = q.entries.splice(index, 1)
    this.prune(this.clarifies, sid, q)
    this.notify(q)
    this.events.publish('attention_resolved')
    return { entry: entry ?? null, head: index === 0 ? this.clarifyHeadFrame(sid) : null }
  }

  clearClarifies(sid: string): number {
    const q = this.clarifies.get(sid)
    if (!q) return 0
    const n = q.entries.length
    q.entries.length = 0
    this.prune(this.clarifies, sid, q)
    this.notify(q)
    if (n) this.events.publish('attention_resolved')
    return n
  }

  hasPendingClarify(sid: string): boolean {
    return (this.clarifies.get(sid)?.entries.length ?? 0) > 0
  }

  subscribeClarifies(sid: string): [PendingSubscriber, { pending: Record<string, unknown> | null; pending_count: number }] {
    const q = this.queue(this.clarifies, sid)
    const sub: PendingSubscriber = { queue: [], wake: null, closed: false }
    q.subscribers.add(sub)
    return [sub, this.clarifyPending(sid)]
  }

  unsubscribeClarifies(sid: string, sub: PendingSubscriber): void {
    sub.closed = true
    const q = this.clarifies.get(sid)
    q?.subscribers.delete(sub)
    if (q) this.prune(this.clarifies, sid, q)
  }

  /** Session ids with any outstanding prompt (sidebar attention). */
  pendingSessionKeys(): Set<string> {
    const keys = new Set<string>()
    for (const [sid, q] of this.approvals) if (q.entries.length) keys.add(sid)
    for (const [sid, q] of this.clarifies) if (q.entries.length) keys.add(sid)
    return keys
  }
}

export function nextPendingItem(sub: PendingSubscriber, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const ready = sub.queue.shift()
  if (ready) return Promise.resolve(ready)
  return new Promise((resolve) => {
    const timer = setTimeout(() => { sub.wake = null; resolve(null) }, timeoutMs)
    sub.wake = () => {
      clearTimeout(timer)
      sub.wake = null
      resolve(sub.queue.shift() ?? null)
    }
  })
}
