import type { Message } from '../../contracts'
import { TalariaActivitySchema } from '@maudecode/talaria-web-contracts'
import type { LiveTurn, Segment } from '../../stream/reducer'
import { isTerminal } from '../../stream/reducer'
import type { ToolCardData } from './blocks/ToolCard'
import { ActivityGroupSchema, TurnSummaryPartSchema, type ActivityGroup, type TurnSummaryPart, ApprovalAnsweredBySchema, BackgroundLinkSchema, DisplayMediaSchema, ToolFieldSchema, ToolKindSchema, ToolProgressSchema, ToolAppSchema, ToolResultViewSchema, ToolVerbSchema, type DisplayMedia, type ToolKind, type ToolResultView } from '@maudecode/talaria-web-contracts'
import { extractInlineThinking, rowText, stripToolCallXml } from './render/text'
import type { VisibleMessage } from './useTranscript'

/** TAL-186: the server's display text for a body, with its media references rewritten, and the media it references. */
export interface DisplayBody { display?: string; media?: DisplayMedia[] }

/**
 * `createdAt`: the server's `created_at` (epoch seconds) on a scene row; live rows have none. TAL-2332: `groupId` is the
 * server's activity group of a reasoning or tool item; a tool item's `mergedCount` heads a merged run of that many calls,
 * which the items with `mergedInto` its key join. A steer's `phaseActivity` is the work phase it ends.
 */
export type ActivityItem = (
  | ({ key: string; kind: 'text'; text: string } & DisplayBody)
  | { key: string; kind: 'reasoning'; text: string; titles?: string[]; disclosureKey?: string }
  | { key: string; kind: 'tool'; call: ToolCardData; mergedCount?: number; mergedInto?: string }
  | { key: string; kind: 'steering'; text: string; consumed: boolean; activity?: import('@maudecode/talaria-web-contracts').TalariaActivity | undefined; phaseActivity?: ActivityGroup }
) & { createdAt?: number; groupId?: string }

export interface TurnActivity {
  key: string
  items: ActivityItem[]
  finalAnswer: string
  /** TAL-186: what renders for `finalAnswer`; `finalAnswer` stays as written for copy and speech. */
  finalAnswerDisplay?: DisplayBody
  /** The server's collapsed excerpt of a long final answer (TAL-456); `finalAnswer` stays whole for copy and speech. */
  finalAnswerExcerpt?: string
  status: string
  /** Server-decided initial state of the turn's "Worked" disclosure. */
  expandedByDefault?: boolean
  /** Projected from the live stream: no server scene yet, so nothing folds and no answer is split out. */
  live?: boolean
  /** A running scene the live turn's rows continue (TAL-374): its last row is no longer the newest, so it is not active. */
  continued?: boolean
  sceneRows?: unknown[]
  history?: { ref: string; index: number; before: number }
  /** TAL-2332: the server's activity groups by `group_id`, on owned and native gateway turns alike (TAL-2481). */
  groups?: Record<string, ActivityGroup>
  /** TAL-2332: the work phase after the last consumed steer, which the turn's last "Worked" header words. */
  finalPhase?: ActivityGroup
  /** TAL-2339: what the settled turn changed, which its reply's footer words; empty or absent when it changed nothing. */
  summary?: TurnSummaryPart[]
}

const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const text = (v: unknown): string => typeof v === 'string' ? v : ''
/** The server's kind as sent; the contract keeps it optional, so a missing value reads as `unknown`. */
const toolKindOf = (v: unknown): ToolKind => ToolKindSchema.safeParse(v).data ?? 'unknown'
/** TAL-186: the server's display text and media, when it sent them. */
function displayBody(display: unknown, media: unknown): DisplayBody {
  const items = DisplayMediaSchema.array().safeParse(media).data
  return { ...(typeof display === 'string' ? { display } : {}), ...(items?.length ? { media: items } : {}) }
}
/** TAL-2327: the verb a `kanban` call shows, when the server sent a valid one. */
const verbOf = (v: unknown): Pick<ToolCardData, 'verb'> => { const verb = ToolVerbSchema.safeParse(v).data; return verb ? { verb } : {} }
/** TAL-2330: an `mcp` or `connector` call's app, when the server sent a valid one. */
const appOf = (v: unknown): Pick<ToolCardData, 'app'> => { const app = ToolAppSchema.safeParse(v).data; return app ? { app } : {} }
/** TAL-315: the server's result sections, when it sent valid ones. */
const resultViewOf = (v: unknown): ToolResultView | null => ToolResultViewSchema.safeParse(v).data ?? null
/** TAL-2318: the server's argument rows, when it sent valid ones. */
const argsFieldsOf = (v: unknown): Pick<ToolCardData, 'argsFields'> => { const fields = ToolFieldSchema.array().safeParse(v).data; return fields ? { argsFields: fields } : {} }
/** TAL-372: a delegation row's link to the work it started, when the server sent a valid one. */
const backgroundOf = (v: unknown): Pick<ToolCardData, 'background'> => { const link = BackgroundLinkSchema.safeParse(v).data; return link ? { background: link } : {} }
/** TAL-1169: the other session whose agent answered this call's approval, when the server sent a valid one. */
const answeredByOf = (v: unknown): Pick<ToolCardData, 'approvalAnsweredBy'> => { const by = ApprovalAnsweredBySchema.safeParse(v).data; return by ? { approvalAnsweredBy: by } : {} }

/** The server stamps every row with its turn; clients group by equality and never infer turn boundaries. */
export function turnIdOf(message: Message): string | undefined {
  return typeof message._turn_id === 'string' && message._turn_id ? message._turn_id : undefined
}

/** An assistant row of a reply: a marker card (`_marker_kind`) or a notice (`_notice_kind`, TAL-815) renders on its own. */
export function isReplyRow(message: Message): boolean {
  return message.role === 'assistant' && !message._marker_kind && !message._notice_kind && !message._talaria_activity
}

/**
 * Consecutive assistant rows with one `_turn_id` form a turn; the final row retains its original mutation index. A marker
 * or notice row is a row of its own, never part of a turn.
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
    if (!isReplyRow(row.message)) { flush(); out.push(row); continue }
    const previous = group.at(-1)
    if (previous && turnIdOf(previous.message) !== turnIdOf(row.message)) flush()
    group.push(row)
  }
  flush()
  return out
}

const processedSegments = new WeakMap<Segment, { content: string; reasoning: string | null }>()

/** Reducer segments are immutable; only the trailing segment is still growing. Keys stay outside the cache because steers can shift positions. */
function processedSegment(segment: Extract<Segment, { kind: 'text' | 'reasoning' }>, sealed: boolean) {
  const cached = processedSegments.get(segment)
  if (cached) return cached
  const split = segment.kind === 'text' ? extractInlineThinking(segment.text) : { content: segment.text, reasoning: '' }
  const processed = { content: stripToolCallXml(split.content), reasoning: split.reasoning ? stripToolCallXml(split.reasoning) : null }
  if (sealed) processedSegments.set(segment, processed)
  return processed
}

/** TAL-2332: the server's activity groups by id, when it sent valid ones. */
export function groupsById(value: unknown): Record<string, ActivityGroup> | undefined {
  const groups = ActivityGroupSchema.array().safeParse(value).data
  return groups && Object.fromEntries(groups.map((group) => [group.group_id, group]))
}

/** Server-normalized scene rows map one-to-one onto activity items; the server owns order, roles, and states. */
export function sceneItems(value: unknown): ActivityItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw): ActivityItem[] => {
    const row = record(raw)
    const key = text(row.row_id)
    const at = { ...(typeof row.created_at === 'number' ? { createdAt: row.created_at } : {}), ...(text(row.group_id) ? { groupId: text(row.group_id) } : {}) }
    if (row.role === 'prose') return [{ key, kind: 'text', text: text(row.text), ...displayBody(row.display_text, row.media), ...at }]
    if (row.role === 'reasoning') return [{ key, kind: 'reasoning', text: text(row.text), titles: Array.isArray(row.titles) ? row.titles.map(text) : [], ...(text(row.disclosure_key) ? { disclosureKey: text(row.disclosure_key) } : {}), ...at }]
    if (row.role === 'steering') {
      const phase = ActivityGroupSchema.safeParse(row.phase_activity).data
      return [{ key, kind: 'steering', text: text(row.text), consumed: record(row.steering).consumed === true, activity: TalariaActivitySchema.safeParse(row.talaria_activity).data, ...(phase ? { phaseActivity: phase } : {}), ...at }]
    }
    const tool = record(row.tool)
    // TAL-2331: a call the server hides is left out of the turn and its tool group.
    if (row.role !== 'tool' || tool.hidden === true) return []
    const merged = { ...(typeof row.merged_count === 'number' ? { mergedCount: row.merged_count } : {}), ...(text(row.merged_into) ? { mergedInto: text(row.merged_into) } : {}) }
    return [{ key, kind: 'tool', ...at, ...merged, call: {
      progress: ToolProgressSchema.safeParse(tool.progress).data ?? null, id: text(tool.id), name: text(tool.name), kind: toolKindOf(tool.kind), ...verbOf(tool.verb), ...appOf(tool.app), target: text(tool.target), args: tool.args, ...argsFieldsOf(tool.args_fields), ...(typeof tool.raw_args === 'string' ? { rawArgs: tool.raw_args } : {}), ...(typeof tool.raw_result === 'string' ? { rawResult: tool.raw_result } : {}), preview: typeof tool.preview === 'string' ? tool.preview : null, resultView: resultViewOf(tool.result_view), ...(tool.shows_card === true ? { showsCard: true as const } : {}),
      ...(tool.opens_raw === true ? { opensRaw: true as const } : {}), ...(tool.media_in_details === true ? { mediaInDetails: true as const } : {}),
      done: tool.done === true, isError: tool.is_error === true, duration: typeof tool.duration === 'number' ? tool.duration : null, costUsd: typeof tool.cost_usd === 'number' ? tool.cost_usd : null,
      ...backgroundOf(tool.background), ...answeredByOf(tool.approval_answered_by), ...(tool.result_truncated === true ? { resultTruncated: true } : {}), ...(text(tool.process_id) ? { processId: text(tool.process_id) } : {}),
    } }]
  })
}

/**
 * A completed turn renders its server scene exactly: the rows under "Worked", the final answer, the outcome, and the
 * default disclosure. A row without a scene (the running turn's, which the live stream renders) shows its text with no worklog.
 */
export function persistedActivity(row: VisibleMessage): TurnActivity {
  const parts = row.assistantRows ?? [row]
  const last = parts.at(-1) ?? row
  const scene = record(last.message._anchor_activity_scene)
  const key = row.turnKey ?? row.key
  if (scene.version !== 'activity_scene_v1' || !Array.isArray(scene.activity_rows)) {
    const bodies = parts.filter((part) => rowText(part.message).trim())
    const display = bodies.some((part) => part.message._display_content !== undefined) ? bodies.map((part) => part.message._display_content ?? rowText(part.message)).join('\n\n') : undefined
    return { key, items: [], finalAnswer: bodies.map((part) => rowText(part.message)).join('\n\n'), finalAnswerDisplay: displayBody(display, bodies.flatMap((part) => part.message._media ?? [])), status: 'completed' }
  }
  return {
    key, items: sceneItems(scene.activity_rows), ...serverGroups(scene), finalAnswer: text(scene.final_answer), finalAnswerDisplay: displayBody(scene.final_answer_display, scene.final_answer_media), ...(text(scene.final_answer_excerpt) ? { finalAnswerExcerpt: text(scene.final_answer_excerpt) } : {}), status: text(scene.terminal_state) || 'completed', expandedByDefault: scene.expanded_by_default === true,
    sceneRows: scene.activity_rows, summary: summaryParts(scene.turn_summary),
    ...(typeof scene.activity_rows_offset === 'number' && scene.activity_rows_offset > 0 ? { history: { ref: text(scene.activity_scene_ref), index: row.index, before: scene.activity_rows_offset } } : {}),
  }
}

/** TAL-2339: the scene's summary parts; a part a newer server adds drops alone. */
const summaryParts = (parts: unknown): TurnSummaryPart[] => (Array.isArray(parts) ? parts.flatMap((part) => TurnSummaryPartSchema.safeParse(part).data ?? []) : [])

/** TAL-2332: a scene's activity groups and last work phase, when the server sent them. */
function serverGroups(scene: Record<string, unknown>): Pick<TurnActivity, 'groups' | 'finalPhase'> {
  const groups = groupsById(scene.activity_groups)
  const finalPhase = ActivityGroupSchema.safeParse(scene.final_phase_activity).data
  return { ...(groups ? { groups } : {}), ...(finalPhase ? { finalPhase } : {}) }
}

/** The text a turn copies and reads aloud: its final answer, or its text items when it has none. */
export function activityText(activity: TurnActivity): string {
  return activity.finalAnswer || activity.items.flatMap((item) => item.kind === 'text' ? [item.text] : []).join('\n\n')
}

/** `omitToolIds`: tools a running scene already shows (TAL-374); their live state updates that card (`continuedActivity`). */
export function liveActivity(turn: Pick<LiveTurn, 'segments' | 'tools' | 'groups' | 'status' | 'terminalState' | 'turnId' | 'streamId'>, omitToolIds?: ReadonlySet<string>): TurnActivity {
  const items: ActivityItem[] = []
  const seen = new Set<string>()
  turn.segments.forEach((segment, i) => {
    if (segment.kind === 'text' || segment.kind === 'reasoning') {
      const processed = processedSegment(segment, i < turn.segments.length - 1)
      if (segment.kind === 'reasoning') items.push({ key: `reasoning:${i}`, ...segment, text: processed.content })
      else {
        if (processed.reasoning !== null) items.push({ key: `text:${i}:thinking`, kind: 'reasoning', text: processed.reasoning })
        if (processed.content.trim()) items.push({ key: `text:${i}`, kind: 'text', text: processed.content })
      }
    }
    else if (segment.kind === 'steering') items.push({ key: `steering:${segment.steerId}`, kind: 'steering', text: segment.text, consumed: true, activity: segment.activity })
    else if (!seen.has(segment.toolId) && !omitToolIds?.has(segment.toolId)) {
      seen.add(segment.toolId)
      const call = turn.tools[segment.toolId]
      if (call && !call.hidden) items.push({ key: `tool:${call.id}`, kind: 'tool', call, ...(call.groupId ? { groupId: call.groupId } : {}) })
    }
  })
  // Live rendering only: the server's scene decides the settled answer, outcome and fold. Until it replaces this view,
  // a finished turn stays as it streamed, labelled with the outcome the server's terminal event reported.
  const status = isTerminal(turn.status) ? (turn.terminalState ?? turn.status) : 'running'
  return { key: turn.turnId ?? turn.streamId, items, finalAnswer: '', status, live: true, groups: turn.groups }
}

/** The ids of the tools a turn's items show. */
export function toolIdsOf(activity: TurnActivity): Set<string> {
  return new Set(activity.items.flatMap((item) => (item.kind === 'tool' ? [item.call.id] : [])))
}

/**
 * A running scene the live turn continues (TAL-374): a scene tool the stream reports on takes its live state in place,
 * and once the live turn shows rows of its own, its tail rather than the scene's is the active one.
 */
export function continuedActivity(activity: TurnActivity, turn: LiveTurn): TurnActivity {
  const items = activity.items.map((item): ActivityItem => {
    const live = item.kind === 'tool' ? turn.tools[item.call.id] : undefined
    if (!live || item.kind !== 'tool') return item
    const call = item.call
    return { ...item, call: { ...call, progress: live.progress ?? null, done: call.done || live.done, isError: live.isError, preview: live.preview ?? call.preview, duration: live.duration ?? call.duration, costUsd: live.costUsd ?? call.costUsd, resultView: live.resultView ?? call.resultView, approvalOutcome: live.approvalOutcome, approvalAnsweredBy: live.approvalAnsweredBy ?? call.approvalAnsweredBy } }
  })
  return { ...activity, items, groups: { ...activity.groups, ...turn.groups }, continued: liveActivity(turn, toolIdsOf(activity)).items.length > 0 }
}
