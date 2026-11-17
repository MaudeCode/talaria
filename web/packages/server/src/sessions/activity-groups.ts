import type { ActivityGroup, ToolKind } from '@maudecode/talaria-web-contracts'
import type { SceneRow } from './anchor.js'
import { hiddenLookup, toolGrouping } from './tool-display.js'

/**
 * TAL-2332: the server's one activity-grouping rule, for settled scenes and live frames alike. Reasoning and tool rows run
 * together into one group until prose or a steer ends it; a call whose card stands alone (`shows_card`) is a group of its
 * own. A hidden lookup (TAL-2331) joins the open group without opening one and is never counted. Groups are numbered in
 * turn order (`group:<n>`), so a live turn and its settled scene name them alike.
 */
interface GroupCall { kind: ToolKind; hidden: boolean; failed: boolean; running: boolean }

const groupId = (n: number) => `group:${String(n)}`

/** A group's record: its counted calls by kind in first-seen order, its failures, and whether any call still runs. */
function groupRecord(id: string, calls: GroupCall[]): ActivityGroup {
  const parts = new Map<ToolKind, { kind: ToolKind; count: number; failed: number }>()
  for (const call of calls) {
    if (call.hidden) continue
    const part = parts.get(call.kind) ?? { kind: call.kind, count: 0, failed: 0 }
    part.count += 1
    if (call.failed) part.failed += 1
    parts.set(call.kind, part)
  }
  const shown = calls.filter((call) => !call.hidden)
  return { group_id: id, parts: [...parts.values()], failed: shown.filter((call) => call.failed).length, running: shown.some((call) => call.running) }
}

/**
 * A scene's rows with their `group_id`s and merged runs, and the record of every group. Two or more consecutive completed,
 * successful calls of one kind and presentation in a group merge: the first carries `merged_count`, the rest `merged_into`
 * its row id. Reasoning between calls ends a run; a hidden lookup is skipped. Rows are copied, never changed in place.
 */
export function withActivityGroups(rows: readonly SceneRow[]): { rows: SceneRow[]; groups: ActivityGroup[]; finalPhase: ActivityGroup } {
  const out: SceneRow[] = []
  const calls = new Map<string, GroupCall[]>()
  // The calls of each work phase a consumed steer ends, for the phase's own header (`phase_activity`).
  let phase: GroupCall[] = []
  let phases = 0
  let next = 0
  let open: string | null = null
  const openGroup = () => {
    open ??= groupId(next++)
    if (!calls.has(open)) calls.set(open, [])
    return open
  }
  for (const source of rows) {
    const row: SceneRow = { ...source }
    delete row.group_id
    delete row.merged_count
    delete row.merged_into
    delete row.phase_activity
    out.push(row)
    if (row.role === 'steering' && row.steering?.consumed) { row.phase_activity = groupRecord(`phase:${String(phases++)}`, phase); phase = [] }
    if (row.role === 'prose' || row.role === 'steering') { open = null; continue }
    if (row.role === 'reasoning') { row.group_id = openGroup(); continue }
    const tool = row.tool
    if (!tool) continue
    const hidden = hiddenLookup(tool.name, tool.is_error)
    if (hidden) { if (open) row.group_id = open; continue }
    const { kind, card } = toolGrouping(tool.name)
    if (card) open = null
    row.group_id = openGroup()
    const counted = { kind, hidden: false, failed: tool.is_error, running: !tool.done }
    calls.get(row.group_id)?.push(counted)
    phase.push(counted)
    if (card) open = null
  }
  mergeRuns(out)
  return { rows: out, groups: [...calls].map(([id, list]) => groupRecord(id, list)), finalPhase: groupRecord(`phase:${String(phases)}`, phase) }
}

/** Marks each run of two or more consecutive mergeable calls with one key inside one group (see `withActivityGroups`). */
function mergeRuns(rows: SceneRow[]): void {
  let run: SceneRow[] = []
  let key = ''
  const flush = () => {
    const [head, ...rest] = run
    if (head && rest.length) {
      head.merged_count = run.length
      for (const row of rest) row.merged_into = head.row_id
    }
    run = []
    key = ''
  }
  for (const row of rows) {
    const tool = row.tool
    if (row.role === 'tool' && tool && hiddenLookup(tool.name, tool.is_error)) continue
    const grouping = tool && row.role === 'tool' ? toolGrouping(tool.name) : null
    const mergeable = grouping && tool && row.group_id && tool.done && !tool.is_error && !grouping.card
    const next = mergeable ? JSON.stringify([row.group_id, grouping.kind, grouping.presentation]) : ''
    if (!next || next !== key) flush()
    if (next) { run.push(row); key = next }
  }
  flush()
}

/** The groups among `groups` that `rows` show, so a scene page ships only the records it needs. */
export function groupsOf(rows: readonly SceneRow[], groups: readonly ActivityGroup[]): ActivityGroup[] {
  const shown = new Set(rows.flatMap((row) => (row.group_id ? [row.group_id] : [])))
  return groups.filter((group) => shown.has(group.group_id))
}

/**
 * The same rule over a running turn's live frames: `reasoning` and `tool` frames take the open group, `text` (visible prose)
 * and `close` (a consumed steer) end it, and `complete` settles a call. Each tool frame carries its group as it then stands.
 */
export class LiveActivityGroups {
  private next = 0
  private open: string | null = null
  private readonly groups = new Map<string, Map<string, GroupCall>>()
  private readonly callGroups = new Map<string, string>()
  /**
   * Hidden lookups that started with no group open, by call id: the group opened next takes them, in place, unless prose
   * or a steer came first (`closed`), as the settled scene places a failed lookup by where it started.
   */
  private readonly ungrouped = new Map<string, GroupCall & { closed: boolean }>()

  close(): void {
    this.open = null
    for (const call of this.ungrouped.values()) call.closed = true
  }

  private openGroup(): string {
    if (this.open) return this.open
    const id = groupId(this.next++)
    const calls = new Map<string, GroupCall>()
    for (const [callId, call] of this.ungrouped) {
      if (call.closed) continue
      calls.set(callId, { kind: call.kind, hidden: call.hidden, failed: call.failed, running: call.running })
      this.callGroups.set(callId, id)
      this.ungrouped.delete(callId)
    }
    this.groups.set(id, calls)
    this.open = id
    return id
  }

  /** A reasoning frame's `group_id`. */
  reasoning(): { group_id: string } {
    return { group_id: this.openGroup() }
  }

  /** A `tool` frame's `group_id` and `group`. */
  start(id: string, name: unknown): { group_id?: string; group?: ActivityGroup } {
    const hidden = hiddenLookup(name, false)
    const { kind, card } = toolGrouping(name)
    if (hidden && !this.open) { this.ungrouped.set(id, { kind, hidden, failed: false, running: true, closed: false }); return {} }
    if (card && !hidden) this.close()
    const group = this.openGroup()
    this.groups.get(group)?.set(id, { kind, hidden, failed: false, running: true })
    this.callGroups.set(id, group)
    if (card && !hidden) this.close()
    return this.frame(group)
  }

  /** A `tool_complete` frame's `group_id` and `group`; a failed lookup is counted from here on, as it shows again. */
  complete(id: string, name: unknown, isError: boolean): { group_id?: string; group?: ActivityGroup } {
    const waiting = this.ungrouped.get(id)
    if (waiting) {
      this.ungrouped.delete(id)
      // A lookup that stays hidden needs no group; one that failed shows, in the group open now or a new one.
      if (hiddenLookup(name, isError)) return {}
      const group = this.openGroup()
      this.groups.get(group)?.set(id, { kind: waiting.kind, hidden: false, failed: isError, running: false })
      this.callGroups.set(id, group)
      return this.frame(group)
    }
    const group = this.callGroups.get(id)
    const call = group ? this.groups.get(group)?.get(id) : undefined
    if (!group || !call) return {}
    Object.assign(call, { hidden: hiddenLookup(name, isError), failed: isError, running: false })
    return this.frame(group)
  }

  private frame(group: string): { group_id: string; group: ActivityGroup } {
    return { group_id: group, group: groupRecord(group, [...(this.groups.get(group)?.values() ?? [])]) }
  }
}
