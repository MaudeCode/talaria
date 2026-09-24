/**
 * Anchor activity scenes: the compacted worklog the browser settles onto an
 * assistant message (Python `_handle_session_anchor_scene`,
 * `_hydrate_anchor_activity_scenes`). Scene bodies stay in the sidecar under
 * `anchor_activity_scenes`; responses carry a tail-only transport preview.
 */
import { str } from '../util.js'
import { createHash } from 'node:crypto'
import { agentSteerText, isContextCompressionMarker, messageText, splitThinkingFromContent } from './merge.js'
import type { Session } from './session.js'
import { toolMessageForLimitedPayload } from './window.js'

const isDict = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

export const ANCHOR_SCENE_MAX_BYTES = 18 * 1024 * 1024
export const ANCHOR_SCENE_MAX_ROWS = 20_000
export const ANCHOR_SCENE_PREVIEW_ROWS = 80

export function anchorSceneMessageText(message: unknown): string {
  if (!isDict(message)) return ''
  const content = message.content ?? ''
  if (Array.isArray(content)) return content.map((part) => (isDict(part) ? str(part.text || part.content || part.input_text) : str(part))).join('\n')
  return str(content)
}

export function anchorSceneCleanText(value: unknown): string {
  return str(value).split(/\s+/).filter(Boolean).join(' ').trim()
}

export function anchorSceneTextKey(value: unknown): string {
  return anchorSceneCleanText(value).toLowerCase()
}

/** Canonical JSON digest identical to Python's `json.dumps(sort_keys=True, separators=(',', ':'))`. */
export function anchorSceneMessageRefDigest(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(Object.fromEntries(Object.keys(payload).sort().map((k) => [k, payload[k]])))
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export function assistantAnchorSceneMessageRef(message: unknown): string {
  if (!isDict(message)) return ''
  const payload = {
    role: str(message.role),
    content: anchorSceneMessageText(message).split(/\s+/).filter(Boolean).join(' '),
    timestamp: message._ts ?? message.timestamp ?? '',
  }
  return anchorSceneMessageRefDigest(payload)
}

export function normalizeAnchorSceneMessageRef(ref: unknown): string {
  const text = str(ref).trim()
  if (!text) return ''
  if (/^[0-9a-fA-F]{64}$/.test(text)) return text.toLowerCase()
  let payload: unknown
  try { payload = JSON.parse(text) } catch { return text }
  if (!isDict(payload)) return text
  return anchorSceneMessageRefDigest({ role: str(payload.role), content: str(payload.content).split(/\s+/).filter(Boolean).join(' '), timestamp: payload.timestamp || '' })
}

export function anchorSceneIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

function textHasLongOverlap(textKey: string, finalKey: string): boolean {
  if (textKey.length < 80 || finalKey.length < 80) return false
  const [shorter, longer] = textKey.length <= finalKey.length ? [textKey, finalKey] : [finalKey, textKey]
  const window = 64
  const scanLimit = Math.min(shorter.length, 1400)
  if (scanLimit < window) return false
  for (let start = 0; start <= scanLimit - window; start += 24) {
    const chunk = shorter.slice(start, start + window).trim()
    if (chunk.length >= 48 && longer.includes(chunk)) return true
  }
  const tokens = (s: string) => new Set(s.match(/[a-z0-9_./:-]{3,}/g) ?? [])
  const a = tokens(textKey)
  const b = tokens(finalKey)
  if (a.size && b.size) {
    const common = [...a].filter((t) => b.has(t)).length
    const shorterCount = Math.min(a.size, b.size)
    if (shorterCount >= 3 && common >= Math.min(5, shorterCount) && common / shorterCount >= 0.5) return true
  }
  const compact = (s: string) => s.replace(/[\s`*_#|[\](){}<>.,;:!?，。；：！？、/\\-]+/g, '')
  const tc = compact(textKey)
  const fc = compact(finalKey)
  if (tc.length >= 40 && fc.length >= 40) {
    const grams = (s: string) => { const g = new Set<string>(); for (let i = 0; i < s.length - 3; i += 1) g.add(s.slice(i, i + 4)); return g }
    const tg = grams(tc)
    const fg = grams(fc)
    const common = [...tg].filter((g) => fg.has(g)).length
    const shorterGrams = Math.min(tg.size, fg.size)
    if (shorterGrams && common >= 12 && common / shorterGrams >= 0.35) return true
  }
  return false
}

export function anchorSceneCandidateMatchesScene(candidate: unknown, scene: unknown): boolean {
  if (!isDict(scene)) return true
  const finalKey = anchorSceneTextKey(scene.final_answer ?? '')
  if (!finalKey) return true
  const candidateKey = anchorSceneTextKey(anchorSceneMessageText(candidate))
  if (!candidateKey) return false
  if (candidateKey === finalKey) return true
  if (finalKey.length >= 16 && candidateKey.includes(finalKey)) return true
  if (candidateKey.length >= 16 && finalKey.includes(candidateKey)) return true
  return textHasLongOverlap(candidateKey, finalKey)
}

export function sanitizeAnchorActivityScene(scene: unknown): Record<string, unknown> {
  if (!isDict(scene)) throw new Error('scene must be an object')
  if (str(scene.version) !== 'activity_scene_v1') throw new Error('scene.version must be activity_scene_v1')
  if (!Array.isArray(scene.activity_rows)) throw new Error('scene.activity_rows must be a list')
  if (scene.activity_rows.length > ANCHOR_SCENE_MAX_ROWS) throw new Error('scene.activity_rows is too large')
  const encoded = JSON.stringify(scene)
  if (Buffer.byteLength(encoded, 'utf8') > ANCHOR_SCENE_MAX_BYTES) throw new Error('scene payload is too large')
  return JSON.parse(encoded) as Record<string, unknown>
}

export function anchorSceneMessageIndexFromRequest(body: Record<string, unknown>): number | null {
  const messageIndex = anchorSceneIntOrNull(body.message_index)
  const offset = anchorSceneIntOrNull(body.message_offset)
  const windowIndex = anchorSceneIntOrNull(body.message_window_index)
  if (windowIndex !== null && offset !== null && offset > 0 && (messageIndex === null || messageIndex === windowIndex)) return windowIndex + offset
  return messageIndex
}

/** Locate the assistant message a scene belongs to: unique ref first, then the explicit index, then the last assistant. */
export function findAnchorSceneMessage(messages: unknown[], opts: { messageIndex?: number | null; messageRef?: string; scene?: unknown }): [number, Record<string, unknown>] | [null, null] {
  const normalizedRef = normalizeAnchorSceneMessageRef(opts.messageRef ?? '')
  let candidate: Record<string, unknown> | null = null
  const idx = opts.messageIndex ?? null
  if (idx !== null && idx >= 0 && idx < messages.length) {
    const maybe = messages[idx]
    if (isDict(maybe) && maybe.role === 'assistant') candidate = maybe
  }
  if (normalizedRef) {
    const matches: [number, Record<string, unknown>][] = []
    messages.forEach((m, i) => { if (isDict(m) && m.role === 'assistant' && assistantAnchorSceneMessageRef(m) === normalizedRef) matches.push([i, m]) })
    if (matches.length === 1 && matches[0] !== undefined) return matches[0]
    if (matches.length > 1) return [null, null]
    if (candidate === null) return [null, null]
  }
  if (candidate !== null && idx !== null) {
    if (normalizedRef && !anchorSceneCandidateMatchesScene(candidate, opts.scene)) return [null, null]
    return [idx, candidate]
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (isDict(m) && m.role === 'assistant') return [i, m]
  }
  return [null, null]
}

export function anchorSceneMessageTurnDuration(message: unknown): number | null {
  if (!isDict(message)) return null
  for (const key of ['_turnDuration', '_turn_duration', 'turn_duration']) {
    const v = message[key]
    if (typeof v === 'number' && v >= 0) return v
  }
  return null
}

export function anchorSceneRecords(session: Session): Record<string, unknown> {
  return isDict(session.anchor_activity_scenes) ? session.anchor_activity_scenes : {}
}

export interface SceneTool { id: string; name: string; args: unknown; preview: string | null; result: unknown; done: boolean; is_error: boolean; duration: number | null; cost_usd: number | null }
export interface SceneSteering { steer_id: string; consumed: boolean; submitted_at: number | null; consumed_at: number | null; phase_duration?: number | null }
/** The one scene row shape both clients render: every decoding decision is made here. */
export interface SceneRow {
  row_id: string
  order_index: number
  role: 'prose' | 'reasoning' | 'tool' | 'steering'
  created_at?: number
  text?: string
  titles?: string[]
  tool?: SceneTool
  steering?: SceneSteering
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Stored rows in durable order (numeric `order_index`, else source position), malformed rows dropped, and one explicit
 * shape per role: legacy `thinking` is `reasoning`, a tool is `done` unless still `running`, `failed`/`error` statuses
 * are errors, and steering is consumed only when marked so. A repeated row id keeps its first position, last content.
 */
export function normalizeSceneRows(value: unknown): SceneRow[] {
  if (!Array.isArray(value)) return []
  const ordered = value.map((raw, index) => {
    const row = isDict(raw) ? raw : {}
    const order = typeof row.order_index === 'number' || (typeof row.order_index === 'string' && /^-?\d+$/.test(row.order_index.trim())) ? Number(row.order_index) : NaN
    return { row, index, order: Number.isFinite(order) ? order : index }
  }).sort((a, b) => a.order - b.order || a.index - b.index)
  const rows: SceneRow[] = []
  const positions = new Map<string, number>()
  const put = (row: Omit<SceneRow, 'order_index'>) => {
    const at = positions.get(row.row_id)
    const next = { ...row, order_index: 0 }
    if (at === undefined) { positions.set(row.row_id, rows.length); rows.push(next) } else rows[at] = next
  }
  for (const { row, index } of ordered) {
    const tool = isDict(row.tool) ? row.tool : {}
    const payload = isDict(row.payload) ? row.payload : {}
    const steering = isDict(row.steering) ? row.steering : {}
    const toolId = str(row.tool_call_id) || str(tool.id)
    const steerId = str(payload.steer_id) || str(steering.steer_id)
    const rowId = row.role === 'tool' && toolId ? `tool:${toolId}` : row.role === 'steering' && steerId ? `steering:${steerId}` : str(row.row_id) || `scene:${String(index)}`
    const createdAt = finite(row.created_at)
    const base = createdAt === null ? { row_id: rowId } : { row_id: rowId, created_at: createdAt }
    if (row.role === 'prose') {
      const [content, reasoning] = splitThinkingFromContent(str(row.text))
      if (reasoning) put({ ...base, row_id: `${rowId}:thinking`, role: 'reasoning', text: reasoning, titles: [] })
      if (content.trim()) put({ ...base, role: 'prose', text: content })
    } else if (row.role === 'reasoning' || row.role === 'thinking') {
      const thinking = isDict(row.thinking) ? row.thinking : {}
      const rawTitles = Array.isArray(thinking.titles) ? thinking.titles : row.titles
      const titles = Array.isArray(rawTitles) ? rawTitles.filter((t): t is string => typeof t === 'string' && Boolean(t.trim())) : []
      const text = str(thinking.text) || str(row.text)
      if (text.trim() || titles.length) put({ ...base, role: 'reasoning', text, titles })
    } else if (row.role === 'steering' && str(row.text).trim()) {
      // Already-normalized rows (built or re-read scenes) keep their fields: normalizing is idempotent.
      const consumed = row.status === 'consumed' || steering.consumed === true
      put({ ...base, role: 'steering', text: str(row.text), steering: { steer_id: steerId || rowId, consumed, submitted_at: finite(payload.created_at) ?? finite(steering.submitted_at), consumed_at: consumed ? finite(payload.consumed_at) ?? finite(steering.consumed_at) ?? createdAt : null, phase_duration: finite(steering.phase_duration) } })
    } else if (row.role === 'tool') {
      const status = str(row.status).toLowerCase()
      put({ ...base, role: 'tool', tool: {
        id: toolId || rowId, name: str(tool.name) || 'tool', args: tool.args ?? null, preview: str(tool.snippet) || str(tool.preview) || null,
        result: tool.result ?? tool.output ?? tool.snippet ?? null,
        done: typeof tool.done === 'boolean' ? tool.done : status !== 'running',
        is_error: tool.is_error === true || tool.error === true || status === 'error' || status === 'failed',
        duration: finite(tool.duration), cost_usd: finite(tool.cost_usd),
      } })
    }
  }
  return rows.map((row, i) => ({ ...row, order_index: i }))
}

/** The rows a client shows under "Worked": normalized, without the final answer's own prose row (it renders below). */
function transportRows(scene: Record<string, unknown>): SceneRow[] {
  const rows = normalizeSceneRows(scene.activity_rows)
  const finalKey = anchorSceneCleanText(scene.final_answer)
  const at = finalKey ? rows.findLastIndex((row) => row.role === 'prose' && anchorSceneCleanText(row.text) === finalKey) : -1
  return at === -1 ? rows : rows.filter((_, i) => i !== at).map((row, i) => ({ ...row, order_index: i }))
}

/** Tail-only transport preview of a durable scene. */
export function anchorActivitySceneTransportPreview(scene: Record<string, unknown>, sceneRef = ''): Record<string, unknown> {
  const preview: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(scene)) if (k !== 'activity_rows') preview[k] = structuredClone(v)
  if ('final_answer' in scene) preview.final_answer = str(scene.final_answer)
  if ('turn_duration' in scene) preview.turn_duration = finite(Number(scene.turn_duration ?? NaN))
  const rows = transportRows(scene)
  const total = rows.length
  const offset = Math.max(0, total - ANCHOR_SCENE_PREVIEW_ROWS)
  preview.activity_rows = rows.slice(offset)
  preview.activity_rows_total = total
  preview.activity_rows_offset = offset
  preview.activity_rows_complete = offset === 0
  preview.activity_rows_omitted = offset
  if (sceneRef) preview.activity_scene_ref = sceneRef
  return preview
}

/** Terminal outcomes whose "Worked" disclosure opens by default, so readable partial work is not hidden. */
const EXPANDED_OUTCOMES = new Set(['error', 'no_response', 'degraded', 'connection_lost', 'tool_limit_reached', 'compression_exhausted'])

/**
 * Codex (Responses API) narration between tool calls: `phase: 'commentary'` message items. The Agent routes that text
 * into `reasoning` and leaves `content` empty, so the scene reads it here (`analysis` stays hidden).
 */
function codexCommentary(message: Record<string, unknown>): string[] {
  if (!Array.isArray(message.codex_message_items)) return []
  return message.codex_message_items.flatMap((item) => isDict(item) && item.type === 'message' && str(item.phase).trim().toLowerCase() === 'commentary' && Array.isArray(item.content)
    ? [item.content.map((part) => (isDict(part) && part.type === 'output_text' ? str(part.text) : '')).join('').trim()]
    : []).filter(Boolean)
}

/** Anthropic-style tool calls: `tool_use` blocks in the content array, interleaved with the text around them. */
function hasToolUseBlocks(message: Record<string, unknown>): boolean {
  return Array.isArray(message.content) && message.content.some((part) => isDict(part) && part.type === 'tool_use')
}

/** The final answer rule: the turn's last assistant row, with visible content, no tool calls, not interim or partial. */
function finalAnswerOf(last: Record<string, unknown>): string {
  if ((Array.isArray(last.tool_calls) && last.tool_calls.length > 0) || hasToolUseBlocks(last) || last._interim === true || last._partial === true) return ''
  return splitThinkingFromContent(messageText(last.content))[0]
}

/** The turn's outcome: an explicit terminal state, else its error row's kind, else whether it answered. */
function terminalStateOf(last: Record<string, unknown>, finalAnswer: string): string {
  const label = str(last.provider_details_label)
  const errorState = last._error === true ? (label === 'Cancellation details' ? 'cancelled' : label === 'Interruption details' ? 'interrupted' : 'error') : ''
  return str(last.terminal_state) || str(last._terminal_state) || (last._max_iteration_summary_fallback === true ? 'tool_limit_reached' : '') || errorState || (finalAnswer.trim() ? 'completed' : 'no_response')
}

function toolArgs(call: Record<string, unknown>): unknown {
  if (call.args !== undefined) return call.args
  const raw = isDict(call.function) ? call.function.arguments : undefined
  if (typeof raw !== 'string') return raw ?? null
  try { return JSON.parse(raw) as unknown } catch { return raw }
}

/**
 * One completed turn's presentation, built from its rows: ordered reasoning / prose / tool rows (the work that folds
 * under "Worked"), the visible final answer, the outcome, and whether "Worked" opens by default. Every decision a
 * client used to make about a settled turn is made here.
 */
export function buildTurnScene(turn: [Record<string, unknown>, number][], opts: { clipToolResults?: boolean } = {}): Record<string, unknown> | null {
  const assistants = turn.filter(([m]) => m.role === 'assistant')
  const last = assistants.at(-1)?.[0]
  if (!last) return null
  const finalAnswer = finalAnswerOf(last)
  const results = new Map<string, Record<string, unknown>>()
  for (const [m] of turn) if (m.role === 'tool') results.set(str(m.tool_call_id) || str(m.tool_use_id), m)
  const rows: SceneRow[] = []
  const seenTools = new Set<string>()
  const push = (row: Omit<SceneRow, 'order_index'>) => rows.push({ ...row, order_index: rows.length })
  for (const [m, index] of turn) {
    const steer = isDict(m._steer) ? m._steer : null
    if (m.role === 'user' && steer) {
      // A persisted steer sits at its causal place; it ends one work phase and starts the next.
      const steerId = str(steer.steer_id) || `i${String(index)}`
      const createdAt = finite(m.timestamp)
      push({ row_id: `steering:${steerId}`, role: 'steering', text: messageText(m.content), ...(createdAt === null ? {} : { created_at: createdAt }),
        steering: { steer_id: steerId, consumed: true, submitted_at: finite(steer.submitted_at), consumed_at: finite(steer.consumed_at), phase_duration: finite(steer.phase_duration) } })
      continue
    }
    if (m.role !== 'assistant') continue
    const ref = str(m.message_id ?? m.id) || `i${String(index)}`
    const createdAt = finite(m.timestamp)
    const at = createdAt === null ? {} : { created_at: createdAt }
    const commentary = codexCommentary(m)
    let reasoning = [str(m.reasoning_content), typeof m.reasoning === 'string' ? m.reasoning : '', str(m.thinking)].filter(Boolean).join('\n')
    for (const part of commentary) reasoning = reasoning.replace(part, '')
    reasoning = reasoning.replace(/\n{3,}/g, '\n\n').trim()
    const titles = Array.isArray(m.reasoning_titles) ? m.reasoning_titles.filter((t): t is string => typeof t === 'string' && Boolean(t.trim())) : []
    if (reasoning || titles.length) push({ row_id: `${ref}:reasoning`, role: 'reasoning', text: reasoning, titles, ...at })
    const [prose, inlineThinking] = splitThinkingFromContent(messageText(m.content))
    if (inlineThinking) push({ row_id: `${ref}:thinking`, role: 'reasoning', text: inlineThinking, titles: [], ...at })
    const pushTool = (raw: unknown, i: number) => {
      const call = isDict(raw) ? raw : {}
      const id = str(call.id) || str(call.call_id) || str(call.tool_call_id) || `${ref}-${String(i)}`
      if (seenTools.has(id)) return
      seenTools.add(id)
      const reply = results.get(id)
      // Full results, except in a limited response, which clips them like its raw tool rows (the full detail keeps them).
      const result = reply ? messageText((opts.clipToolResults ? toolMessageForLimitedPayload(reply) as Record<string, unknown> : reply).content) : call.result ?? call.output ?? null
      push({ row_id: `tool:${id}`, role: 'tool', ...at, tool: {
        id, name: str(call.name) || str(isDict(call.function) ? call.function.name : '') || 'tool', args: toolArgs(call),
        preview: str(call.preview) || null, result, done: typeof call.done === 'boolean' ? call.done : true,
        is_error: call.is_error === true || reply?.is_error === true, duration: finite(call.duration), cost_usd: finite(call.cost_usd),
      } })
    }
    if (hasToolUseBlocks(m)) {
      // Text and tool_use blocks stay in the order the model wrote them; such a row is never the final answer.
      let chunk: unknown[] = []
      const flush = () => {
        const text = splitThinkingFromContent(messageText(chunk))[0]
        if (text.trim()) push({ row_id: rows.some((r) => r.row_id === `${ref}:prose`) ? `${ref}:prose:${String(rows.length)}` : `${ref}:prose`, role: 'prose', text, ...at })
        chunk = []
      }
      for (const [i, part] of (m.content as unknown[]).entries()) {
        if (!isDict(part) || part.type !== 'tool_use') { chunk.push(part); continue }
        flush()
        pushTool({ id: part.id, name: part.name, args: part.input ?? null }, i)
      }
      flush()
      continue
    }
    const text = prose.trim() ? prose : commentary.join('\n\n')
    if (m !== last || !finalAnswer.trim()) { if (text.trim()) push({ row_id: `${ref}:prose`, role: 'prose', text, ...at }) }
    for (const [i, call] of (Array.isArray(m.tool_calls) ? m.tool_calls : []).entries()) pushTool(call, i)
  }
  const terminalState = terminalStateOf(last, finalAnswer)
  return {
    version: 'activity_scene_v1', activity_rows: rows, final_answer: finalAnswer, terminal_state: terminalState,
    expanded_by_default: EXPANDED_OUTCOMES.has(terminalState) && rows.length > 0, turn_duration: anchorSceneMessageTurnDuration(last),
    ...(typeof last._final_phase_duration === 'number' ? { final_phase_duration: last._final_phase_duration } : {}),
  }
}

/**
 * A stored scene keeps its rows; the final answer it predates comes from its turn by the same rule, except after a
 * consumed steer (the reply then answers the steer, so the last row is not promoted).
 */
function withStoredFinalAnswer(scene: Record<string, unknown>, built: Record<string, unknown> | null): Record<string, unknown> {
  if (!built || str(scene.final_answer).trim()) return scene
  if (normalizeSceneRows(scene.activity_rows).some((row) => row.steering?.consumed === true)) return scene
  return { ...scene, final_answer: built.final_answer }
}

/** The outcome fields a stored scene predates, from its turn by the same rules as a built one. */
function withStoredOutcome(preview: Record<string, unknown>, built: Record<string, unknown> | null): Record<string, unknown> {
  const next = { ...preview }
  // Only an explicit outcome carries over from the turn; answered or not follows the scene's own final answer.
  const explicit = str(built?.terminal_state)
  if (!str(next.terminal_state)) next.terminal_state = explicit && explicit !== 'completed' && explicit !== 'no_response' ? explicit : str(next.final_answer).trim() ? 'completed' : 'no_response'
  if (typeof next.expanded_by_default !== 'boolean') next.expanded_by_default = EXPANDED_OUTCOMES.has(str(next.terminal_state)) && Number(next.activity_rows_total) > 0
  return next
}

/** Rows of the full transcript grouped by `_turn_id` (see withTurnIds), with their absolute indexes. */
function turnsOf(messages: unknown[]): Map<string, [Record<string, unknown>, number][]> {
  const turns = new Map<string, [Record<string, unknown>, number][]>()
  messages.forEach((m, index) => {
    if (!isDict(m)) return
    const id = str(m._turn_id)
    if (!id) return
    const rows = turns.get(id) ?? []
    rows.push([m, index])
    turns.set(id, rows)
  })
  return turns
}

/** The stored record for a message: a unique content ref first, then its absolute index when the content agrees. */
function storedRecordFor(message: Record<string, unknown>, index: number, lookup: { byRef: Map<string, Record<string, unknown>>; byIndex: Map<number, Record<string, unknown>>; refCounts: Map<string, number> }): Record<string, unknown> | undefined {
  const ref = assistantAnchorSceneMessageRef(message)
  const record = (lookup.refCounts.get(ref) ?? 0) <= 1 ? lookup.byRef.get(ref) : undefined
  if (record) return record
  const candidate = lookup.byIndex.get(index)
  return candidate && anchorSceneCandidateMatchesScene(message, candidate.scene ?? {}) ? candidate : undefined
}

function sceneLookup(messages: unknown[], records: Record<string, unknown>) {
  const byRef = new Map<string, Record<string, unknown>>()
  const byIndex = new Map<number, Record<string, unknown>>()
  for (const [key, record] of Object.entries(records)) {
    if (!isDict(record) || !isDict(record.scene)) continue
    const ref = str(record.message_ref || key)
    if (ref) byRef.set(ref, record)
    const idx = anchorSceneIntOrNull(record.message_index)
    if (idx !== null) byIndex.set(idx, record)
  }
  const refCounts = new Map<string, number>()
  for (const m of messages) {
    if (isDict(m) && m.role === 'assistant') {
      const r = assistantAnchorSceneMessageRef(m)
      if (r) refCounts.set(r, (refCounts.get(r) ?? 0) + 1)
    }
  }
  return { byRef, byIndex, refCounts }
}

/**
 * Attach every completed turn's scene preview to its last assistant row, over the full `_turn_id`-stamped transcript
 * (before any window, so every window agrees). A stored scene wins and is completed with the turn's outcome fields; a
 * turn without one gets a built scene. The running turn (`activeTurnId`) gets none: the live stream renders it.
 */
export function hydrateAnchorActivityScenes(messages: unknown[], records: Record<string, unknown>, opts: { activeTurnId?: string | null; clipToolResults?: boolean } = {}): unknown[] {
  if (!messages.length) return messages
  const lookup = sceneLookup(messages, records)
  // Any scene carried inline leaves in the one normalized shape, even off a turn's last row.
  const out = messages.map((m) => (isDict(m) && isDict(m._anchor_activity_scene) ? { ...m, _anchor_activity_scene: anchorActivitySceneTransportPreview(m._anchor_activity_scene, str(m._anchor_activity_scene.activity_scene_ref)) } : m))
  for (const [turnId, turn] of turnsOf(messages)) {
    if (opts.activeTurnId && turnId === opts.activeTurnId) continue
    const lastEntry = turn.filter(([m]) => m.role === 'assistant').at(-1)
    if (!lastEntry) continue
    const [message, index] = lastEntry
    const built = buildTurnScene(turn, { clipToolResults: opts.clipToolResults === true })
    const record = storedRecordFor(message, index, lookup)
    const inline = message._anchor_activity_scene
    const next: Record<string, unknown> = { ...message }
    if (record && isDict(record.scene)) {
      next._anchor_activity_scene = withStoredOutcome(anchorActivitySceneTransportPreview(withStoredFinalAnswer(record.scene, built), str(record.message_ref) || assistantAnchorSceneMessageRef(message)), built)
      if (record.stream_id) next._anchor_stream_id = str(record.stream_id)
    } else if (isDict(inline)) {
      next._anchor_activity_scene = withStoredOutcome(anchorActivitySceneTransportPreview(withStoredFinalAnswer(inline, built), str(inline.activity_scene_ref)), built)
    } else if (built) {
      next._anchor_activity_scene = anchorActivitySceneTransportPreview(built, assistantAnchorSceneMessageRef(message))
    }
    out[index] = next
  }
  return out
}

/** Persist a settled scene onto a session (the POST body semantics). Returns the placement. */
export function storeAnchorScene(session: Session, body: Record<string, unknown>, now: number): { message_index: number; message_ref: string } | null {
  const scene = sanitizeAnchorActivityScene(body.scene)
  const [idx, message] = findAnchorSceneMessage(session.messages, { messageIndex: anchorSceneMessageIndexFromRequest(body), messageRef: str(body.message_ref), scene })
  if (message === null || idx === null) return null
  if (scene.turn_duration === null || scene.turn_duration === undefined) {
    const duration = anchorSceneMessageTurnDuration(message)
    if (duration !== null) scene.turn_duration = duration
  }
  const ref = assistantAnchorSceneMessageRef(message)
  let records: Record<string, unknown> = { ...anchorSceneRecords(session) }
  records[ref || `index:${idx}`] = { version: 'anchor_activity_scene_record_v1', message_index: idx, message_ref: ref, stream_id: str(body.stream_id), scene, updated_at: now }
  if (Object.keys(records).length > 256) {
    const ordered = Object.entries(records).sort((a, b) => Number((isDict(a[1]) ? a[1].updated_at : 0) ?? 0) - Number((isDict(b[1]) ? b[1].updated_at : 0) ?? 0))
    records = Object.fromEntries(ordered.slice(-256))
  }
  session.anchor_activity_scenes = records
  return { message_index: idx, message_ref: ref }
}

/** Page through one stored scene's rows (the GET semantics). */
export function readAnchorSceneRows(session: Session, query: { messageRef: string; messageIndex: number | null; before: number | null; limit: number | null }, transcript: unknown[] = []): Record<string, unknown> | null {
  const records = anchorSceneRecords(session)
  let record: Record<string, unknown> | null = null
  if (query.messageRef) {
    const direct = records[query.messageRef]
    if (isDict(direct)) record = direct
    else {
      for (const [key, candidate] of Object.entries(records)) {
        if (isDict(candidate) && normalizeAnchorSceneMessageRef(candidate.message_ref || key) === query.messageRef) { record = candidate; break }
      }
    }
  }
  if (!record && query.messageIndex !== null) {
    for (const candidate of Object.values(records)) {
      if (isDict(candidate) && anchorSceneIntOrNull(candidate.message_index) === query.messageIndex) { record = candidate; break }
    }
  }
  // The turn that ends at the requested message: its built scene, or the one that completes a stored scene.
  const matches = transcript.map((m, i) => [m, i] as const).filter(([m, i]) => isDict(m) && m.role === 'assistant' && (query.messageRef ? assistantAnchorSceneMessageRef(m) === query.messageRef : i === query.messageIndex))
  const target = matches.length === 1 ? matches[0] : matches.find(([, i]) => i === query.messageIndex)
  const turn = target && isDict(target[0]) ? turnsOf(transcript).get(str(target[0]._turn_id)) : undefined
  const built = turn ? buildTurnScene(turn) : null
  const stored = record && isDict(record.scene) ? withStoredFinalAnswer(record.scene, built) : null
  const scene = stored ?? built
  const sceneRef = record ? str(record.message_ref || query.messageRef) : query.messageRef
  if (!scene || !Array.isArray(scene.activity_rows)) return null
  const rows = transportRows(scene)
  const total = rows.length
  const before = Math.max(0, Math.min(total, query.before ?? total))
  const limit = Math.max(1, Math.min(200, query.limit ?? 80))
  const start = Math.max(0, before - limit)
  return { scene_ref: sceneRef, rows: rows.slice(start, before), start, end: before, total, complete: start === 0 }
}

/** A turn opens at a user message the reader sees (text or attachments); hidden prompts and compaction markers do not. */
function opensTurn(m: Record<string, unknown>): boolean {
  if (m.role !== 'user' || isContextCompressionMarker(m) || isDict(m._steer)) return false
  return messageText(m.content).trim() !== '' || (Array.isArray(m.attachments) && m.attachments.length > 0)
}

/**
 * Every message leaves the server with a `_turn_id`. A turn stamps its rows with its stream id; rows written before
 * that (older files, state.db/CLI rows) take `legacy:<index of their opening user row>`, or `legacy:start`, computed
 * over the full transcript so a window boundary never changes a key. Returns copies; stored rows are untouched.
 */
export function withTurnIds<T>(messages: T[]): T[] {
  let current = 'legacy:start'
  return messages.map((raw, index) => {
    if (!isDict(raw)) return raw
    // The Agent's own record of a delivered steer shows as the steer it is, inside its turn, never as a prompt.
    const agentSteer = agentSteerText(raw)
    const m = agentSteer === null ? raw : { ...raw, content: agentSteer, _steer: { steer_id: `agent:${String(index)}` } }
    const own = str(m._turn_id)
    if (own) { current = own; return m }
    if (opensTurn(m)) current = `legacy:${String(index)}`
    return { ...m, _turn_id: current }
  })
}
