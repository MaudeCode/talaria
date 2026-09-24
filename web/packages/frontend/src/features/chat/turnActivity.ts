import type { Message } from '../../contracts'
import type { LiveTurn } from '../../stream/reducer'
import { isTerminal } from '../../stream/reducer'
import type { ToolCardData } from './blocks/ToolCard'
import { extractInlineThinking, messageText } from './render/text'
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
  status: string
  /** Server-decided initial state of the turn's "Worked" disclosure. */
  expandedByDefault?: boolean
  sceneRows?: unknown[]
  history?: { ref: string; index: number; before: number }
}

const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const text = (v: unknown): string => typeof v === 'string' ? v : ''

/** The server stamps every row with its turn; clients group by equality and never infer turn boundaries. */
export function turnIdOf(message: Message): string | undefined {
  return typeof message._turn_id === 'string' && message._turn_id ? message._turn_id : undefined
}

/** Consecutive assistant rows with one `_turn_id` form a turn; the final row retains its original mutation index. */
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
    if (row.message.role !== 'assistant') { flush(); out.push(row); continue }
    const previous = group.at(-1)
    if (previous && turnIdOf(previous.message) !== turnIdOf(row.message)) flush()
    group.push(row)
  }
  flush()
  return out
}

function appendProse(items: ActivityItem[], key: string, raw: string) {
  const split = extractInlineThinking(raw)
  if (split.reasoning) items.push({ key: `${key}:thinking`, kind: 'reasoning', text: split.reasoning })
  if (split.content.trim()) items.push({ key, kind: 'text', text: split.content })
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
      id: text(tool.id), name: text(tool.name), args: tool.args, preview: typeof tool.preview === 'string' ? tool.preview : null, result: tool.result ?? null,
      done: tool.done === true, isError: tool.is_error === true, duration: typeof tool.duration === 'number' ? tool.duration : null, costUsd: typeof tool.cost_usd === 'number' ? tool.cost_usd : null,
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
    key, items: sceneItems(scene.activity_rows), finalAnswer: text(scene.final_answer), status: text(scene.terminal_state) || 'completed', expandedByDefault: scene.expanded_by_default === true,
    sceneRows: scene.activity_rows,
    ...(typeof scene.activity_rows_offset === 'number' && scene.activity_rows_offset > 0 ? { history: { ref: text(scene.activity_scene_ref), index: row.index, before: scene.activity_rows_offset } } : {}),
  }
}

const LIVE_EXPANDED_OUTCOMES = new Set(['error', 'no_response', 'degraded', 'connection_lost', 'tool_limit_reached', 'compression_exhausted'])

export function liveActivity(turn: LiveTurn): TurnActivity {
  const items: ActivityItem[] = []
  const seen = new Set<string>()
  turn.segments.forEach((segment, i) => {
    if (segment.kind === 'text') appendProse(items, `text:${i}`, segment.text)
    else if (segment.kind === 'reasoning') items.push({ key: `reasoning:${i}`, ...segment })
    else if (!seen.has(segment.toolId)) {
      seen.add(segment.toolId)
      const call = turn.tools[segment.toolId]
      if (call) items.push({ key: `tool:${call.id}`, kind: 'tool', call })
    }
  })
  let finalAnswer = ''
  const tail = items.at(-1)
  const lastSegment = turn.segments.at(-1)
  if (lastSegment?.kind === 'text' && !lastSegment.interim && turn.status === 'done' && (!turn.terminalState || turn.terminalState === 'completed') && tail?.kind === 'text') { finalAnswer = tail.text; items.pop() }
  const status = !isTerminal(turn.status) ? 'running' : turn.status === 'done' ? (turn.terminalState && turn.terminalState !== 'completed' ? turn.terminalState : finalAnswer ? 'completed' : 'no_response') : turn.terminalState === 'interrupted' ? 'interrupted' : turn.status
  // Live rendering until the server's scene arrives: a failed live turn keeps its partial work open.
  return { key: turn.turnId ?? turn.streamId, items, finalAnswer, status, expandedByDefault: LIVE_EXPANDED_OUTCOMES.has(status) }
}
