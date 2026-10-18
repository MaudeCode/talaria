/** Revision-owned transcript summaries and coordinates. No derived transcript is retained. */
import { createHash } from 'node:crypto'
import { str } from '../util.js'
import { assistantAnchorSceneMessageRef, messageTurnId } from './anchor.js'
import { anchorMessageKey, isAnchorCandidate, keyMatches, type CompressionReference } from './compress.js'
import { isConversationalAssistant, agentSteerText, ApiMessageSummary, isContextCompressionMarker, messageText, normalizeAssistantDisplay, normalizeUserDisplay, withAttachmentObjects } from './merge.js'
import { isEmptyPartialActivityMessage, messageTimestamp, type Message, type Session } from './session.js'
import { messageTodoSnapshot, tsFloat } from './todo.js'
import { stateDbIdentityKeys, stateDbMessageKey } from './state-db-identity.js'

interface Snapshot { maxTimestamp: number; maxTodoTimestamp: number; todo: Record<string, unknown> | null; userCount: number; lastTimestamp: number | null }
interface Candidate { index: number; key: Record<string, unknown> | null }
const upperBound = (rows: number[], value: number): number => {
  let lo = 0, hi = rows.length
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid]! <= value) lo = mid + 1; else hi = mid }
  return lo
}

// ponytail: one in-memory pass per file revision; persist this index only if cold JSON loads become a bottleneck.
export class SessionPrefixIndex {
  readonly turnStarts: number[] = []
  private readonly replyRows: number[] = []
  readonly dependencies = new Map<string, { first: number; last: number }>()
  private readonly declarations = new Map<string, number[]>()
  readonly turns = new Map<string, { first: number; last: number }>()
  readonly prompts = new Map<string, number>()
  readonly refCounts = new Map<string, number>()
  readonly identities = [new Set<string>(), new Set<string>()] as const
  readonly unidentified = [new Map<string, number>(), new Map<string, number>()] as const
  readonly markerSummaries: { index: number; text: string }[] = []
  readonly anchorCandidates: Candidate[] = []
  private readonly candidatesByKey = new Map<string, Candidate[]>()
  private readonly snapshots: Snapshot[] = [{ maxTimestamp: 0, maxTodoTimestamp: 0, todo: null, userCount: 0, lastTimestamp: null }]
  private readonly rowHashes: string[] = []
  private readonly toolCallsHash: string
  private readonly ids: string[] = []
  private readonly refs = new Map<string, number[]>()
  private readonly callIndices: number[] = []
  private readonly calls = new Map<number, Record<string, unknown>[]>()
  private current: string
  readonly model = new ApiMessageSummary()
  length = 0

  readonly baseIndex: number
  private readonly parent: { index: SessionPrefixIndex; end: number } | undefined
  constructor(public rows: Message[], public revision: string | null, readonly generation: string | null, opts: { baseIndex?: number; initialTurn?: string; toolCalls?: unknown[]; timestampFloor?: number; todoFloor?: number; parent?: { index: SessionPrefixIndex; end: number } } = {}) {
    this.baseIndex = opts.baseIndex ?? 0
    this.parent = opts.parent
    const toolCalls = opts.toolCalls ?? []
    this.toolCallsHash = this.hash(toolCalls)
    for (const call of toolCalls) {
      if (!call || typeof call !== 'object') continue
      const row = call as Record<string, unknown>, at = row.assistant_msg_idx
      if (typeof at !== 'number' || !Number.isInteger(at)) continue
      const entries = this.calls.get(at) ?? []; entries.push(row); this.calls.set(at, entries)
    }
    this.callIndices = [...this.calls.keys()].sort((a, b) => a - b)
    this.snapshots[0]!.maxTimestamp = opts.timestampFloor ?? 0
    this.snapshots[0]!.maxTodoTimestamp = opts.todoFloor ?? 0
    this.current = opts.initialTurn ?? 'legacy:start'
    this.extend()
  }

  extend(): void {
    if (this.length === this.rows.length) return
    for (let local = this.length; local < this.rows.length; local += 1) {
      const index = this.baseIndex + local
      const raw = this.rows[local]!
      this.rowHashes.push(this.hash(raw))
      this.model.add(raw)
      const id = messageTurnId(raw, index, this.current)
      if (!local || id !== this.current) this.turnStarts.push(index)
      this.current = id
      this.ids.push(id)
      const callId = (call: unknown): string => call && typeof call === 'object' ? str((call as Message).id || (call as Message).call_id || (call as Message).tool_call_id) : ''
      const declare = (call: string) => { if (call) { const entries = this.declarations.get(call) ?? []; entries.push(index); this.declarations.set(call, entries) } }
      const answer = (call: string) => {
        const own = this.declarations.get(call)?.at(-1)
        const earlier = own ?? this.parent?.index.declarationBefore(call, this.parent.end)
        if (earlier === undefined) return
        const priorTurn = own === undefined ? this.parent!.index.turnId(earlier) : this.turnId(earlier)
        for (const turn of [id, priorTurn]) {
          const span = this.dependencies.get(turn)
          this.dependencies.set(turn, { first: Math.min(span?.first ?? earlier, earlier), last: Math.max(span?.last ?? index, index) })
        }
      }
      if (raw.role === 'assistant') {
        for (const call of Array.isArray(raw.tool_calls) ? raw.tool_calls : []) declare(callId(call))
        for (const part of Array.isArray(raw.content) ? raw.content : []) if (part && typeof part === 'object' && (part as Message).type === 'tool_use') declare(str((part as Message).id))
      } else if (raw.role === 'tool') answer(str(raw.tool_call_id || raw.tool_use_id))
      else if (raw.role === 'user' && Array.isArray(raw.content)) for (const part of raw.content) if (part && typeof part === 'object' && (part as Message).type === 'tool_result') answer(str((part as Message).tool_use_id))
      const span = this.turns.get(id)
      this.turns.set(id, { first: span?.first ?? index, last: index })
      if (raw.role === 'user' && typeof raw._active_turn_token === 'string' && !this.prompts.has(raw._active_turn_token)) this.prompts.set(raw._active_turn_token, index)
      const ref = raw.role === 'assistant' ? assistantAnchorSceneMessageRef(raw) : ''
      if (ref) { this.refCounts.set(ref, (this.refCounts.get(ref) ?? 0) + 1); const positions = this.refs.get(ref) ?? []; positions.push(index); this.refs.set(ref, positions) }
      for (const [mode, includeUids] of [false, true].entries()) {
        const keys = stateDbIdentityKeys(raw, includeUids, this.generation)
        for (const key of keys) this.identities[mode]!.add(key)
        if (!keys.length) { const key = stateDbMessageKey(raw); this.unidentified[mode]!.set(key, (this.unidentified[mode]!.get(key) ?? 0) + 1) }
      }
      const previous = this.snapshots.at(-1)!
      const timestamp = Number(raw.timestamp ?? 0) || 0
      const maxTimestamp = Math.max(previous.maxTimestamp, timestamp)
      const maxTodoTimestamp = Math.max(previous.maxTodoTimestamp, tsFloat(raw.timestamp))
      const todo = messageTodoSnapshot(raw, maxTodoTimestamp) ?? previous.todo
      const lastTimestamp = raw.role !== 'tool' && !isEmptyPartialActivityMessage(raw) ? messageTimestamp(raw) || previous.lastTimestamp : previous.lastTimestamp
      this.snapshots.push({ maxTimestamp, maxTodoTimestamp, todo, userCount: previous.userCount + (raw.role === 'user' ? 1 : 0), lastTimestamp })
      const steer = agentSteerText(raw)
      const projected = steer === null ? raw : { ...raw, content: steer }
      const display = normalizeUserDisplay(normalizeAssistantDisplay(withAttachmentObjects([projected])[0]!))
      if (isConversationalAssistant(display)) this.replyRows.push(index)
      const normalized = display.role === 'assistant' && this.calls.has(index) && (!Array.isArray(display.tool_calls) || !display.tool_calls.length) ? { ...display, tool_calls: this.calls.get(index) } : display
      if (isContextCompressionMarker(normalized)) this.markerSummaries.push({ index, text: messageText(normalized.content).split(/\s+/).join(' ').trim() })
      if (isAnchorCandidate(normalized)) {
        const candidate = { index, key: anchorMessageKey(normalized) }
        this.anchorCandidates.push(candidate)
        const key = candidate.key && this.candidateKey(candidate.key)
        if (key) { const entries = this.candidatesByKey.get(key) ?? []; entries.push(candidate); this.candidatesByKey.set(key, entries) }
      }
      this.length += 1
    }
    this.model.finish()
  }

  private hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('base64') }
  matchesRow(index: number, row: unknown): boolean { return this.rowHashes[index] === this.hash(row) }
  matchesToolCalls(calls: unknown[]): boolean { return this.toolCallsHash === this.hash(calls) }
  /** Called only after save verified every indexed row during its existing serialization pass. */
  savedAppend(rows: Message[], revision: string | null): void { this.rows = rows; this.revision = revision; this.extend() }

  private declarationBefore(call: string, end: number): number | undefined {
    const entries = this.declarations.get(call) ?? []
    return entries[upperBound(entries, end - 1) - 1]
  }
  refCountBefore(ref: string, end: number): number { return upperBound(this.refs.get(ref) ?? [], end - 1) }
  toolCalls(start: number, count: number, rebase = false): Record<string, unknown>[] {
    const calls: Record<string, unknown>[] = []
    for (let i = upperBound(this.callIndices, start - 1); i < this.callIndices.length && this.callIndices[i]! < start + count; i += 1) {
      for (const call of this.calls.get(this.callIndices[i]!)!) calls.push(rebase ? { ...call, assistant_msg_idx: Number(call.assistant_msg_idx) - start } : call)
    }
    return calls
  }

  private candidateKey(key: Record<string, unknown>): string { return JSON.stringify([str(key.role), str(key.text), Number(key.attachments) || 0]) }
  turnId(index: number): string { return this.ids[index - this.baseIndex] ?? 'legacy:start' }
  turnStart(index: number): number { return this.turns.get(this.turnId(index))?.first ?? this.baseIndex }
  turnEnd(index: number): number { return (this.turns.get(this.turnId(index))?.last ?? index) + 1 }
  previousTurn(index: number): number { return this.turnStarts[Math.max(0, upperBound(this.turnStarts, index - 1) - 1)] ?? this.baseIndex }
  summary(end = this.baseIndex + this.length): Snapshot { return this.snapshots[Math.max(0, Math.min(this.length, end - this.baseIndex))]! }

  /** One candidate per turn, newest first, without reading or deriving the cached prefix. */
  *replyTurns(end: number, excluded: Set<string>): Generator<number> {
    for (let i = upperBound(this.replyRows, end - 1) - 1; i >= 0; i -= 1) {
      const at = this.replyRows[i]!, turn = this.turnId(at)
      if (excluded.has(turn)) continue
      excluded.add(turn)
      yield at
    }
  }

  compressionReference(s: Session, end: number, tail: SessionPrefixIndex): CompressionReference | null {
    const text = str(s.compression_anchor_summary).split(/\s+/).join(' ').trim()
    if (!text) return null
    if (this.markerSummaries.some((m) => m.index < end && m.text.includes(text)) || tail.markerSummaries.some((m) => m.text.includes(text))) return null
    const key = s.compression_anchor_message_key
    if (key && typeof key === 'object' && !Array.isArray(key)) {
      const stored = key as Record<string, unknown>
      const matches = (index: SessionPrefixIndex, bound: number) => (index.candidatesByKey.get(this.candidateKey(stored)) ?? []).findLast((entry) => entry.index < bound && entry.key !== null && keyMatches(stored, entry.key))
      const match = matches(tail, Infinity) ?? matches(this, end)
      if (match) return { text, after_message_index: match.index }
    }
    // Binary search by absolute position; do not copy the prefix candidates for each tail read.
    let lo = 0, hi = this.anchorCandidates.length
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.anchorCandidates[mid]!.index < end) lo = mid + 1; else hi = mid }
    const count = lo + tail.anchorCandidates.length
    const visible = s.compression_anchor_visible_idx
    if (typeof visible === 'number' && Number.isInteger(visible) && visible >= 0 && count) {
      const at = Math.min(visible, count - 1)
      return { text, after_message_index: (at < lo ? this.anchorCandidates[at] : tail.anchorCandidates[at - lo])!.index }
    }
    return { text, after_message_index: null }
  }
}
