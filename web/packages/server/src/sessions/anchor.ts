/**
 * Anchor activity scenes: the compacted worklog the browser settles onto an
 * assistant message (Python `_handle_session_anchor_scene`,
 * `_hydrate_anchor_activity_scenes`). Scene bodies stay in the sidecar under
 * `anchor_activity_scenes`; responses carry a tail-only transport preview.
 */
import { str } from '../util.js'
import { createHash } from 'node:crypto'
import { isContextCompressionMarker, messageText, splitThinkingFromContent } from './merge.js'
import type { Session } from './session.js'

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
export interface SceneSteering { steer_id: string; consumed: boolean; submitted_at: number | null; consumed_at: number | null }
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
    const toolId = str(row.tool_call_id) || str(tool.id)
    const steerId = str(payload.steer_id)
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
      const consumed = row.status === 'consumed'
      put({ ...base, role: 'steering', text: str(row.text), steering: { steer_id: steerId || rowId, consumed, submitted_at: finite(payload.created_at), consumed_at: consumed ? finite(payload.consumed_at) ?? createdAt : null } })
    } else if (row.role === 'tool') {
      const status = str(row.status).toLowerCase()
      put({ ...base, role: 'tool', tool: {
        id: toolId || rowId, name: str(tool.name) || 'tool', args: tool.args ?? null, preview: str(tool.snippet) || null,
        result: tool.result ?? tool.output ?? tool.snippet ?? null,
        done: typeof tool.done === 'boolean' ? tool.done : status !== 'running',
        is_error: tool.is_error === true || tool.error === true || status === 'error' || status === 'failed',
        duration: finite(tool.duration), cost_usd: finite(tool.cost_usd),
      } })
    }
  }
  return rows.map((row, i) => ({ ...row, order_index: i }))
}

/** Tail-only transport preview of a durable scene. */
export function anchorActivitySceneTransportPreview(scene: Record<string, unknown>, sceneRef = ''): Record<string, unknown> {
  const preview: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(scene)) if (k !== 'activity_rows') preview[k] = structuredClone(v)
  if ('final_answer' in scene) preview.final_answer = str(scene.final_answer)
  if ('turn_duration' in scene) preview.turn_duration = finite(Number(scene.turn_duration ?? NaN))
  const rows = normalizeSceneRows(scene.activity_rows)
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

/**
 * Attach each assistant message's scene preview for a window of messages.
 * ponytail: the durable scene is served as stored; the Python
 * `_complete_hydrated_anchor_scene` tool-body backfill is not reproduced.
 */
export function hydrateAnchorActivityScenes(messages: unknown[], records: Record<string, unknown>, messageOffset = 0): unknown[] {
  if (!messages.length) return messages
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
  const out = [...messages]
  messages.forEach((message, localIdx) => {
    if (!isDict(message) || message.role !== 'assistant') return
    const absoluteIdx = messageOffset + localIdx
    const ref = assistantAnchorSceneMessageRef(message)
    let record = (refCounts.get(ref) ?? 0) <= 1 ? byRef.get(ref) : undefined
    if (!record) {
      const candidate = byIndex.get(absoluteIdx)
      if (candidate && anchorSceneCandidateMatchesScene(message, candidate.scene ?? {})) record = candidate
    }
    if (!record || !isDict(record.scene)) {
      // A scene carried inline on the message still leaves in the one normalized shape.
      const inline = message._anchor_activity_scene
      if (isDict(inline)) out[localIdx] = { ...message, _anchor_activity_scene: anchorActivitySceneTransportPreview(inline, str(inline.activity_scene_ref)) }
      return
    }
    const next: Record<string, unknown> = { ...message }
    next._anchor_activity_scene = anchorActivitySceneTransportPreview(record.scene, str(record.message_ref || ref))
    if (record.stream_id) next._anchor_stream_id = str(record.stream_id)
    out[localIdx] = next
  })
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
export function readAnchorSceneRows(session: Session, query: { messageRef: string; messageIndex: number | null; before: number | null; limit: number | null }): Record<string, unknown> | null {
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
  const scene = record && isDict(record.scene) ? record.scene : null
  const rows = scene && Array.isArray(scene.activity_rows) ? normalizeSceneRows(scene.activity_rows) : null
  if (!rows || !record) return null
  const total = rows.length
  const before = Math.max(0, Math.min(total, query.before ?? total))
  const limit = Math.max(1, Math.min(200, query.limit ?? 80))
  const start = Math.max(0, before - limit)
  return { scene_ref: str(record.message_ref || query.messageRef), rows: rows.slice(start, before), start, end: before, total, complete: start === 0 }
}

/** A turn opens at a user message the reader sees (text or attachments); hidden prompts and compaction markers do not. */
function opensTurn(m: Record<string, unknown>): boolean {
  if (m.role !== 'user' || isContextCompressionMarker(m)) return false
  return messageText(m.content).trim() !== '' || (Array.isArray(m.attachments) && m.attachments.length > 0)
}

/**
 * Every message leaves the server with a `_turn_id`. A turn stamps its rows with its stream id; rows written before
 * that (older files, state.db/CLI rows) take `legacy:<index of their opening user row>`, or `legacy:start`, computed
 * over the full transcript so a window boundary never changes a key. Returns copies; stored rows are untouched.
 */
export function withTurnIds<T>(messages: T[]): T[] {
  let current = 'legacy:start'
  return messages.map((m, index) => {
    if (!isDict(m)) return m
    const own = str(m._turn_id)
    if (own) { current = own; return m }
    if (opensTurn(m)) current = `legacy:${String(index)}`
    return { ...m, _turn_id: current } as T
  })
}
