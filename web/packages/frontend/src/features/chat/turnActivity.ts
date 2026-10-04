import type { Message } from '../../contracts'
import type { LiveTurn } from '../../stream/reducer'
import { isTerminal } from '../../stream/reducer'
import type { ToolCardData } from './blocks/ToolCard'
import { BackgroundLinkSchema, ToolKindSchema, type ToolKind } from '@maudecode/talaria-web-contracts'
import { extractInlineThinking, messageText, stripToolCallXml } from './render/text'
import type { VisibleMessage } from './useTranscript'

export type ActivityItem =
  | { key: string; kind: 'text'; text: string }
  | { key: string; kind: 'reasoning'; text: string; titles?: string[] }
  | { key: string; kind: 'tool'; call: ToolCardData }
  | { key: string; kind: 'steering'; text: string; consumed: boolean }

export interface TurnActivity {
  key: string
  items: ActivityItem[]
  finalAnswer: string
  /** The server's collapsed excerpt of a long final answer (TAL-456); `finalAnswer` stays whole for copy and speech. */
  finalAnswerExcerpt?: string
  status: string
  /** Server-decided initial state of the turn's "Worked" disclosure. */
  expandedByDefault?: boolean
  /** Projected from the live stream: no server scene yet, so nothing folds and no answer is split out. */
  live?: boolean
  sceneRows?: unknown[]
  history?: { ref: string; index: number; before: number }
}

const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const text = (v: unknown): string => typeof v === 'string' ? v : ''
/** The server's kind as sent; an older server's missing or unrecognized value shows as `unknown`. */
const toolKindOf = (v: unknown): ToolKind => ToolKindSchema.safeParse(v).data ?? 'unknown'
/** TAL-372: a delegation row's link to the work it started, when the server sent a valid one. */
const backgroundOf = (v: unknown): Pick<ToolCardData, 'background'> => { const link = BackgroundLinkSchema.safeParse(v).data; return link ? { background: link } : {} }

/** The server stamps every row with its turn; clients group by equality and never infer turn boundaries. */
export function turnIdOf(message: Message): string | undefined {
  return typeof message._turn_id === 'string' && message._turn_id ? message._turn_id : undefined
}

/**
 * Consecutive assistant rows with one `_turn_id` form a turn; the final row retains its original mutation index. A marker
 * row (`_marker_kind`) is a card of its own, never part of a turn.
 */
export function groupAssistantTurns(rows: VisibleMessage[]): VisibleMessage[] {
  const out: VisibleMessage[] = []
  let group: VisibleMessage[] = []
  const flush = () => {
    const last = group.at(-1)
    const first = group[0]
    if (last && first) out.push({ ...last, key: first.key, assistantRows: group, turnKey: turnIdOf(first.message) ?? first.key })
    group = []
  }
  for (const row of rows) {
    if (row.message.role !== 'assistant' || row.message._marker_kind) { flush(); out.push(row); continue }
    const previous = group.at(-1)
    if (previous && turnIdOf(previous.message) !== turnIdOf(row.message)) flush()
    group.push(row)
  }
  flush()
  return out
}

/** Live tokens only, before the server has a value: settled rows arrive with their prose and reasoning already split. */
function appendProse(items: ActivityItem[], key: string, raw: string) {
  const split = extractInlineThinking(raw)
  if (split.reasoning) items.push({ key: `${key}:thinking`, kind: 'reasoning', text: stripToolCallXml(split.reasoning) })
  const content = stripToolCallXml(split.content)
  if (content.trim()) items.push({ key, kind: 'text', text: content })
}

/** Server-normalized scene rows map one-to-one onto activity items; the server owns order, roles, and states. */
export function sceneItems(value: unknown): ActivityItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw): ActivityItem[] => {
    const row = record(raw)
    const key = text(row.row_id)
    if (row.role === 'prose') return [{ key, kind: 'text', text: text(row.text) }]
    if (row.role === 'reasoning') return [{ key, kind: 'reasoning', text: text(row.text), titles: Array.isArray(row.titles) ? row.titles.map(text) : [] }]
    if (row.role === 'steering') return [{ key, kind: 'steering', text: text(row.text), consumed: record(row.steering).consumed === true }]
    if (row.role !== 'tool') return []
    const tool = record(row.tool)
    return [{ key, kind: 'tool', call: {
      id: text(tool.id), name: text(tool.name), kind: toolKindOf(tool.kind), target: text(tool.target), args: tool.args, preview: typeof tool.preview === 'string' ? tool.preview : null, result: tool.result ?? null,
      done: tool.done === true, isError: tool.is_error === true, duration: typeof tool.duration === 'number' ? tool.duration : null, costUsd: typeof tool.cost_usd === 'number' ? tool.cost_usd : null,
      ...backgroundOf(tool.background),
    } }]
  })
}

/**
 * A completed turn renders its server scene exactly: the rows under "Worked", the final answer, the outcome, and the
 * default disclosure. A row without a scene (an older server) shows its text with no worklog.
 */
export function persistedActivity(row: VisibleMessage): TurnActivity {
  const parts = row.assistantRows ?? [row]
  const last = parts.at(-1) ?? row
  const scene = record(last.message._anchor_activity_scene)
  const key = row.turnKey ?? row.key
  if (scene.version !== 'activity_scene_v1' || !Array.isArray(scene.activity_rows)) {
    return { key, items: [], finalAnswer: parts.map((part) => messageText(part.message.content)).filter((part) => part.trim()).join('\n\n'), status: 'completed' }
  }
  return {
    key, items: sceneItems(scene.activity_rows), finalAnswer: text(scene.final_answer), ...(text(scene.final_answer_excerpt) ? { finalAnswerExcerpt: text(scene.final_answer_excerpt) } : {}), status: text(scene.terminal_state) || 'completed', expandedByDefault: scene.expanded_by_default === true,
    sceneRows: scene.activity_rows,
    ...(typeof scene.activity_rows_offset === 'number' && scene.activity_rows_offset > 0 ? { history: { ref: text(scene.activity_scene_ref), index: row.index, before: scene.activity_rows_offset } } : {}),
  }
}

export function liveActivity(turn: LiveTurn): TurnActivity {
  const items: ActivityItem[] = []
  const seen = new Set<string>()
  turn.segments.forEach((segment, i) => {
    if (segment.kind === 'text') appendProse(items, `text:${i}`, segment.text)
    else if (segment.kind === 'reasoning') items.push({ key: `reasoning:${i}`, ...segment, text: stripToolCallXml(segment.text) })
    else if (segment.kind === 'steering') items.push({ key: `steering:${segment.steerId}`, kind: 'steering', text: segment.text, consumed: true })
    else if (!seen.has(segment.toolId)) {
      seen.add(segment.toolId)
      const call = turn.tools[segment.toolId]
      if (call) items.push({ key: `tool:${call.id}`, kind: 'tool', call })
    }
  })
  // Live rendering only: the server's scene decides the settled answer, outcome and fold. Until it replaces this view,
  // a finished turn stays as it streamed, labelled with the outcome the server's terminal event reported.
  const status = isTerminal(turn.status) ? (turn.terminalState ?? turn.status) : 'running'
  return { key: turn.turnId ?? turn.streamId, items, finalAnswer: '', status, live: true }
}
