/** Durable cross-chat runs; session queues and cron jobs keep their existing lifetimes. */
import { createHash } from 'node:crypto'
import { PromptQueueRunSchema, type PromptQueueAction, type PromptQueueCard, type PromptQueueCardInput, type PromptQueueRun } from '@maudecode/talaria-web-contracts'
import type { UpdateNotificationScope } from '../tools/update-notifications.js'
import type { AppDeps } from '../http/context.js'
import type { DocumentBackend } from './storage/backend.js'
import { updateDocument } from './storage/document.js'
import { HttpFailure } from './service.js'
import { startSessionChat } from './admission.js'
import { isSafeSessionId } from './session.js'
import { str } from '../util.js'

type Scope = Pick<UpdateNotificationScope, 'profile' | 'owner'>
interface Stored { owner: string; run: PromptQueueRun }
const namespace = 'prompt-queues'
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const terminal = new Set(['completed', 'failed', 'refused'])

function view(run: PromptQueueRun): PromptQueueRun {
  const actions: PromptQueueAction[] = run.phase === 'draft' ? ['start', 'cancel'] : run.phase === 'running' ? ['pause', 'cancel']
    : run.phase === 'paused' ? ['resume', 'cancel'] : run.phase === 'unknown' ? ['reconcile', 'cancel'] : []
  return { ...run, title: run.cards[0]?.text.split('\n')[0]?.slice(0, 80) || 'Prompt queue', actions, editable: run.phase === 'draft' }
}

export class PromptQueues {
  private readonly active = new Set<string>()
  private readonly workers = new Map<string, Promise<void>>()
  private timer: ReturnType<typeof setInterval> | undefined
  private stopped = false
  constructor(private readonly documents: DocumentBackend, private readonly deps: () => AppDeps) {}

  scope(): Scope {
    const deps = this.deps()
    const profile = deps.activeProfile()
    return { profile: deps.isRootProfile(profile) ? 'default' : profile, owner: deps.requestScope.getStore()?.notificationOwner ?? 'local-owner' }
  }

  private parse(raw: unknown): Stored {
    if (!raw || typeof raw !== 'object' || typeof (raw as Stored).owner !== 'string') throw new Error('Invalid prompt queue document')
    const saved = raw as Stored
    return { owner: saved.owner, run: PromptQueueRunSchema.parse(saved.run) }
  }
  private owned(saved: Stored, scope: Scope): void {
    if (saved.owner !== scope.owner || saved.run.profile !== scope.profile) throw new HttpFailure(404, 'Queue not found')
  }
  private async load(id: string): Promise<Stored> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new HttpFailure(404, 'Queue not found')
    const doc = await this.documents.get(namespace, id)
    if (!doc) throw new HttpFailure(404, 'Queue not found')
    return this.parse(doc.value)
  }
  private async edit(id: string, fn: (saved: Stored) => void, controlWrite = false): Promise<PromptQueueRun> {
    return updateDocument(this.documents, namespace, id, (raw) => {
      const saved = this.parse(raw)
      const before = JSON.stringify(saved)
      const phase = saved.run.phase
      fn(saved)
      saved.run = view(saved.run)
      // Runtime receipts do not invalidate a still-permitted Pause/Cancel from the last read.
      if (before !== JSON.stringify(saved) && (controlWrite || saved.run.phase !== phase)) saved.run.revision += 1
      return { value: saved, result: saved.run }
    })
  }

  async list(): Promise<{ runs: PromptQueueRun[] }> {
    const scope = this.scope()
    const runs: PromptQueueRun[] = []
    for (const { key } of await this.documents.list(namespace)) {
      const saved = await this.load(key)
      if (saved.owner === scope.owner && saved.run.profile === scope.profile) runs.push(view(saved.run))
    }
    return { runs }
  }

  /** Revalidate the exact profile/project/backend at creation AND immediately before each admission. */
  private async target(input: PromptQueueCardInput): Promise<Pick<PromptQueueCard, 'session_id' | 'title' | 'backend' | 'authority_epoch'>> {
    const deps = this.deps()
    if (!isSafeSessionId(input.session_id) || !(await deps.sessions.sessionIdVisible(input.session_id))) throw new HttpFailure(404, 'Session not found')
    const sid = await deps.sessions.resolveSessionId(input.session_id)
    const detail = await deps.sessions.detail(sid, { messages: '0', resolve_model: '0' })
    if (!deps.profilesMatch(str(detail.profile) || null, deps.activeProfile())) throw new HttpFailure(404, 'Session not found')
    if ((str(detail.project_id) || null) !== input.project_id || detail.archived === true) throw new HttpFailure(409, 'The queue target changed project or was archived')
    const owner = await deps.sessions.owner?.queueReceipt(sid)
    if (owner) {
      if (owner.state !== 'attached' || !owner.snapshot || owner.restarting || owner.snapshot.pending.some((p) => p.status === 'unknown')) throw new HttpFailure(409, 'The owning Agent is unavailable or needs recovery')
      return { session_id: sid, title: str(detail.title) || sid, backend: 'owner', authority_epoch: owner.snapshot.authority_epoch }
    }
    await deps.sessions.assertWritable(sid)
    return { session_id: sid, title: str(detail.title) || sid, backend: 'direct', authority_epoch: null }
  }
  private async cards(inputs: PromptQueueCardInput[], id: string, revision = 0): Promise<PromptQueueCard[]> {
    const cards: PromptQueueCard[] = []
    for (const [index, input] of inputs.entries()) cards.push({ ...input, ...await this.target(input), request_id: `queue-${digest(`${id}:${revision}:${index}`)}`, status: 'waiting', stream_id: null, admission_id: null, outcome: null })
    return cards
  }

  async create(requestId: string, inputs: PromptQueueCardInput[]): Promise<PromptQueueRun> {
    const scope = this.scope()
    const id = digest(JSON.stringify([scope, requestId]))
    const existing = await this.documents.get(namespace, id)
    if (existing) {
      const saved = this.parse(existing.value)
      this.owned(saved, scope)
      // A creation identity can recover a lost response but cannot replace a run's content.
      const original = saved.run.cards.map(({ session_id, project_id, text }) => ({ session_id, project_id, text }))
      if (JSON.stringify(original) !== JSON.stringify(inputs)) throw new HttpFailure(409, 'This queue creation identity was already used')
      return view(saved.run)
    }
    const cards = await this.cards(inputs, id)
    const run = view({ id, title: '', revision: 0, profile: scope.profile, phase: 'draft', current_step: 0, cards, actions: [], editable: true, error: null })
    return updateDocument(this.documents, namespace, id, (raw) => {
      if (raw) {
        const saved = this.parse(raw)
        this.owned(saved, scope)
        if (JSON.stringify(saved.run.cards.map(({ session_id, project_id, text }) => ({ session_id, project_id, text }))) !== JSON.stringify(inputs)) throw new HttpFailure(409, 'This queue creation identity was already used')
        return { value: saved, result: view(saved.run), skip: true }
      }
      return { value: { owner: scope.owner, run }, result: run }
    })
  }

  async replace(id: string, revision: number, inputs: PromptQueueCardInput[]): Promise<PromptQueueRun> {
    const scope = this.scope()
    this.owned(await this.load(id), scope)
    const cards = await this.cards(inputs, id, revision + 1)
    return this.edit(id, (saved) => {
      this.owned(saved, scope)
      if (saved.run.revision !== revision || saved.run.phase !== 'draft') throw new HttpFailure(409, 'Queue changed; refresh before editing')
      saved.run.cards = cards
    }, true)
  }

  async action(id: string, revision: number, action: PromptQueueAction): Promise<PromptQueueRun> {
    const scope = this.scope()
    this.owned(await this.load(id), scope)
    const run = await this.edit(id, (saved) => {
      this.owned(saved, scope)
      if (saved.run.revision !== revision || !view(saved.run).actions.includes(action)) throw new HttpFailure(409, 'Queue changed; refresh before acting')
      if (action === 'start' || action === 'resume') saved.run.phase = 'running'
      if (action === 'pause') saved.run.phase = 'paused'
      if (action === 'cancel') saved.run.phase = 'cancelled'
    }, true)
    this.active.add(id)
    this.wake(id)
    return run
  }

  async initialize(): Promise<void> {
    for (const { key } of await this.documents.list(namespace)) {
      const { run } = await this.load(key)
      if (run.phase === 'running' || run.cards.some((c) => ['dispatching', 'running', 'unknown'].includes(c.status))) this.active.add(key)
    }
    this.timer = setInterval(() => { for (const id of this.active) this.wake(id) }, 2000)
    this.timer.unref()
    for (const id of this.active) this.wake(id)
  }
  wake(id: string): void {
    if (this.stopped || this.workers.has(id)) return
    const worker = this.tick(id).catch((error: unknown) => { this.deps().log(`[webui] prompt queue reconciliation failed: ${error instanceof Error ? error.message : 'unknown error'}`) })
    this.workers.set(id, worker)
    void worker.finally(() => { this.workers.delete(id) })
  }
  /** Deterministic seam used by synthetic tests and the server's lifecycle worker. */
  async settled(): Promise<void> { await Promise.all([...this.workers.values()]) }
  async close(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    await this.settled()
  }

  private async tick(id: string): Promise<void> {
    const saved = await this.load(id)
    await this.deps().requestScope.run({ requestProfile: saved.run.profile, notificationOwner: saved.owner }, async () => {
      for (let count = 0; count <= saved.run.cards.length && !this.stopped; count += 1) {
        const { run } = await this.load(id)
        const card = run.cards[run.current_step]
        if (!card) { this.active.delete(id); return }
        if (card.status !== 'waiting') {
          if (terminal.has(card.status)) { this.active.delete(id); return }
          const status = await this.receipt(card).catch(() => ({ status: 'unknown' as const, outcome: null }))
          await this.edit(id, ({ run: latest }) => {
            const current = latest.cards[latest.current_step]!
            if (current.request_id !== card.request_id) return
            current.status = status.status
            current.outcome = status.outcome
            if (current.status === 'completed') {
              latest.error = null
              latest.current_step += 1
              if (latest.phase !== 'cancelled' && latest.current_step === latest.cards.length) latest.phase = 'completed'
              else if (latest.phase === 'unknown') latest.phase = 'paused'
            } else if (current.status === 'unknown' && latest.phase === 'running') latest.phase = 'unknown'
            else if (current.status === 'failed' && latest.phase !== 'cancelled') latest.phase = 'failed'
          })
          if (status.status === 'completed') continue
          return
        }
        if (run.phase !== 'running') { this.active.delete(id); return }
        // Validate outside the transaction; CAS below rejects a concurrent pause/cancel before dispatch.
        let target: Awaited<ReturnType<PromptQueues['target']>>
        try {
          target = await this.target(card)
          if (target.session_id !== card.session_id || target.backend !== card.backend || target.authority_epoch !== card.authority_epoch) throw new HttpFailure(409, 'Queue target authority changed')
          if (await this.deps().sessions.activeRunBlocking(card.session_id)) throw new HttpFailure(409, 'Queue target is busy')
          if (card.backend === 'owner') {
            const snapshot = await this.deps().sessions.owner!.queueReceipt(card.session_id)
            if (!snapshot?.snapshot || snapshot.snapshot.running || snapshot.snapshot.pending.some((p) => p.status !== 'terminal')) throw new HttpFailure(409, 'Queue target is busy')
          }
        } catch (error) {
          await this.edit(id, ({ run: latest }) => {
            if (latest.revision !== run.revision) return
            latest.cards[latest.current_step]!.status = 'refused'
            latest.phase = 'refused'
            latest.error = error instanceof HttpFailure ? error.message : 'Queue target could not be verified'
          })
          return
        }
        let claimed = false
        await this.edit(id, ({ run: latest }) => {
          claimed = false
          if (latest.revision !== run.revision || latest.phase !== 'running') return
          latest.cards[latest.current_step]!.status = 'dispatching'
          claimed = true
        })
        if (!claimed || this.stopped) return
        // The durable claim is the linearization point. Pause/cancel after it hold successors, never resend this step.
        try {
          const lease = await this.deps().profiles.beginWrite(run.profile)
          if (typeof lease !== 'function') throw new HttpFailure(409, 'Queue target profile is unavailable')
          let response: Record<string, unknown>
          try { response = await startSessionChat(this.deps(), { session_id: card.session_id, message: card.text, submission_id: card.request_id }, {}, undefined, { ...card, profile: run.profile }) } finally { lease() }
          await this.edit(id, ({ run: latest }) => {
            const current = latest.cards[latest.current_step]!
            current.stream_id = str(response.stream_id) || null
            current.admission_id = str(response.admission_id) || null
            current.status = current.stream_id || current.admission_id ? 'running' : 'unknown'
            if (current.status === 'unknown' && latest.phase === 'running') latest.phase = 'unknown'
          })
        } catch (error) {
          await this.edit(id, ({ run: latest }) => {
            const current = latest.cards[latest.current_step]!
            // Admission errors after a side effect can be ambiguous; only typed definite refusals are terminal.
            const refused = error instanceof HttpFailure && error.status < 500 && error.extra.outcome_unknown !== true
            current.status = refused ? 'refused' : 'unknown'
            if (latest.phase !== 'cancelled' && latest.phase !== 'paused') latest.phase = current.status
            latest.error = refused ? (error as Error).message : 'Admission outcome is unknown; reconcile before continuing'
          })
          return
        }
      }
    })
  }

  private async receipt(card: PromptQueueCard): Promise<{ status: PromptQueueCard['status']; outcome: string | null }> {
    const deps = this.deps()
    if (card.backend === 'owner') {
      if (!card.admission_id) return { status: 'unknown', outcome: null }
      const result = await deps.sessions.owner?.queueReceipt(card.session_id, card.admission_id)
      const receipt = result?.receipt
      if (result?.state !== 'attached' || !receipt || !('admission_id' in receipt) || receipt.authority_epoch !== card.authority_epoch || card.admission_id && card.admission_id !== receipt.admission_id) return { status: 'unknown', outcome: null }
      if (receipt.status === 'terminal') return { status: receipt.outcome === 'completed' ? 'completed' : 'failed', outcome: str(receipt.outcome) || null }
      return { status: receipt.status === 'unknown' ? 'unknown' : 'running', outcome: null }
    }
    if (!card.stream_id) return { status: 'unknown', outcome: null }
    if (deps.registry.activeRuns.has(card.stream_id)) return { status: 'running', outcome: null }
    const summary = await deps.journal.summary(card.session_id, card.stream_id)
    if (!summary?.terminal) return { status: 'unknown', outcome: null }
    return { status: summary.terminal_state === 'completed' ? 'completed' : 'failed', outcome: summary.terminal_state }
  }
}
