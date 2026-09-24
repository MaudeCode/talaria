import type { Message } from '../../contracts'
import type { LiveTurn } from '../../stream/reducer'
import { isTerminal } from '../../stream/reducer'
import type { ToolCardData } from './blocks/ToolCard'
import { extractInlineThinking, messageText } from './render/text'
import { messageKey, toolCallArgs, toolCallId, toolCallName, type VisibleMessage } from './useTranscript'

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
  sceneRows?: unknown[]
  history?: { ref: string; index: number; before: number }
}

const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const text = (v: unknown): string => typeof v === 'string' ? v : ''

/** Explicit run identity wins; message text is never a turn identity. */
export function messageOwner(message: Message): string | undefined {
  for (const value of [message._anchor_stream_id, message.run_id, message.stream_id, message.turn_id]) {
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

export function toolCardsFor(message: Message, toolResults: Record<string, Message>): ToolCardData[] {
  return (message.tool_calls ?? []).map((tc, i) => {
    const id = toolCallId(tc, `${messageKey(message) ?? 'm'}-${i}`)
    const result = toolResults[id]
    return { id, name: toolCallName(tc) ?? 'tool', args: toolCallArgs(tc), preview: tc.preview ?? null, done: tc.done ?? true, isError: !!tc.is_error || result?.is_error === true, duration: tc.duration ?? null, costUsd: tc.cost_usd ?? null, result: result ? messageText(result.content) : tc.result ?? tc.output ?? null }
  })
}

/** Group only presentation rows; the final row retains its original mutation index. */
export function groupAssistantTurns(rows: VisibleMessage[]): VisibleMessage[] {
  const out: VisibleMessage[] = []
  let group: VisibleMessage[] = []
  let userKey: string | undefined
  let owner: string | undefined
  const flush = () => {
    const last = group.at(-1)
    const first = group[0]
    if (last && first) out.push({ ...last, key: first.key, assistantRows: group, turnKey: userKey ?? owner ?? first.key })
    group = []
    owner = undefined
  }
  for (const row of rows) {
    if (row.message.role !== 'assistant') {
      flush()
      out.push(row)
      userKey = row.message.role === 'user' ? `user:${row.key}` : undefined
      continue
    }
    const nextOwner = messageOwner(row.message)
    const previous = group.at(-1)?.message
    // Legacy transcripts use tool_calls/finish_reason as continuation boundaries.
    // Without continuation or matching explicit ownership, keep distinct replies apart.
    const continues = previous && ((previous.tool_calls?.length ?? 0) > 0 || previous.finish_reason === 'tool_calls' || previous._interim === true || previous._partial === true || (userKey && previous.finish_reason !== 'stop' && previous.finish_reason !== 'length' && previous._error !== true))
    if (group.length && ((owner && nextOwner && owner !== nextOwner) || (!continues && !(owner && owner === nextOwner)))) { flush(); userKey = undefined }
    owner ??= nextOwner
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

/** A scene can include its final prose row; render that answer only outside the Worklog. */
export function sceneWorkItems(rows: unknown, finalAnswer: string): ActivityItem[] {
  const items = sceneItems(rows)
  const normalizedFinal = finalAnswer.trim().replace(/\s+/g, ' ')
  const finalIndex = items.findLastIndex((item) => item.kind === 'text' && item.text.trim().replace(/\s+/g, ' ') === normalizedFinal)
  if (finalIndex !== -1) items.splice(finalIndex, 1)
  return items
}

/** Bind a terminal event to its completed snapshot, never to the currently last reply. */
export function settledTerminalState(row: VisibleMessage, turn: LiveTurn | null): string | undefined {
  if (turn?.status !== 'done' || !turn.doneSession || !turn.terminalState || turn.terminalState === 'completed') return undefined
  const messages = turn.doneSession.messages ?? []
  const index = messages.findLastIndex((message) => message.role === 'assistant')
  const saved = messages[index]
  if (!saved) return undefined
  const id = messageKey(saved)
  const matches = id !== undefined ? messageKey(row.message) === id
    : row.index === (turn.doneSession._messages_offset ?? 0) + index && JSON.stringify(row.message) === JSON.stringify(saved)
  return matches ? turn.terminalState : undefined
}

export function persistedActivity(row: VisibleMessage, terminalState?: string): TurnActivity {
  const parts = row.assistantRows ?? [row]
  const items: ActivityItem[] = []
  const last = parts.at(-1) ?? row
  const scene = record(last.message._anchor_activity_scene)
  const errorStatus = last.message._error === true ? (last.message.provider_details_label === 'Cancellation details' ? 'cancelled' : last.message.provider_details_label === 'Interruption details' ? 'interrupted' : 'error') : ''
  const status = terminalState || text(scene.terminal_state) || text(last.message.terminal_state) || text(last.message._terminal_state) || errorStatus
  const consumedSteering = scene.version === 'activity_scene_v1' && Array.isArray(scene.activity_rows) && scene.activity_rows.some((value) => { const entry = record(value); return entry.role === 'steering' && record(entry.steering).consumed === true })
  const finalAnswer = scene.version === 'activity_scene_v1' && text(scene.final_answer).trim() ? text(scene.final_answer) : !consumedSteering && !last.message.tool_calls?.length && last.message._interim !== true && last.message._partial !== true
    ? extractInlineThinking(messageText(last.message.content)).content : ''
  if (scene.version === 'activity_scene_v1' && Array.isArray(scene.activity_rows)) {
    items.push(...sceneWorkItems(scene.activity_rows, finalAnswer))
  } else {
    const seenTools = new Set<string>()
    for (const part of parts) {
      const m = part.message
      const reasoning = [m.reasoning_content, text(m.reasoning), m.thinking].filter(Boolean).join('\n')
      if (reasoning) items.push({ key: `${part.key}:reasoning`, kind: 'reasoning', text: reasoning })
      if (part !== last || !finalAnswer) appendProse(items, `${part.key}:prose`, messageText(m.content))
      else {
        const split = extractInlineThinking(messageText(m.content))
        if (split.reasoning) items.push({ key: `${part.key}:thinking`, kind: 'reasoning', text: split.reasoning })
      }
      for (const call of toolCardsFor(m, part.toolResults)) {
        if (seenTools.has(call.id)) continue
        seenTools.add(call.id)
        items.push({ key: `tool:${call.id}`, kind: 'tool', call })
      }
    }
  }
  return { key: row.turnKey ?? messageOwner(last.message) ?? row.key, items, finalAnswer, status: status || (finalAnswer.trim() ? 'completed' : 'no_response'),
    ...(scene.version === 'activity_scene_v1' && Array.isArray(scene.activity_rows) ? { sceneRows: scene.activity_rows } : {}),
    ...(typeof scene.activity_rows_offset === 'number' && scene.activity_rows_offset > 0 ? { history: { ref: text(scene.activity_scene_ref), index: row.index, before: scene.activity_rows_offset } } : {}),
  }
}

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
  return { key: turn.userMessageId ? `user:${turn.userMessageId}` : turn.streamId, items, finalAnswer, status: !isTerminal(turn.status) ? 'running' : turn.status === 'done' ? (turn.terminalState && turn.terminalState !== 'completed' ? turn.terminalState : finalAnswer ? 'completed' : 'no_response') : turn.terminalState === 'interrupted' ? 'interrupted' : turn.status }
}
