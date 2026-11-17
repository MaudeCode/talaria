/**
 * TAL-2339: a settled turn's summary (`turn_summary` on its activity scene): how many files, memories, skills, schedules,
 * tasks and messages its successful calls changed, which the reply's footer words. Counted from each call's outcome
 * (TAL-2335, `toolCallOutcome`), so a failed or unanswered call, a refusal or a write waiting for approval never counts.
 */
import type { ToolOutcome, ToolResultView, TurnSummaryKey, TurnSummaryPart } from '@maudecode/talaria-web-contracts'
import { TurnSummaryKeySchema } from '@maudecode/talaria-web-contracts'
import { turnFileChanges } from './file-changes.js'

interface SummaryRow { tool?: { name: string; args: unknown; done: boolean; is_error: boolean; result_view: ToolResultView | null } }

/** The summary part an outcome counts toward; `removed` names a skill or a scheduled job by its tool. */
function summaryKey(tool: string, outcome: ToolOutcome['key']): TurnSummaryKey | undefined {
  switch (outcome) {
    case 'memory_added': case 'memory_updated': return 'memories_saved'
    case 'skill_created': case 'skill_updated': return 'skills_updated'
    case 'job_created': case 'paused': case 'resumed': return 'schedules_changed'
    case 'removed': return tool === 'skill_manage' ? 'skills_updated' : tool === 'cronjob_manage' ? 'schedules_changed' : undefined
    case 'moved_to': case 'blocked': case 'completed': case 'commented': return 'tasks_updated'
    case 'sent': return 'messages_sent'
    default: return undefined
  }
}

/** The turn's summary from its scene rows, in `TurnSummaryKeySchema` order; empty when it changed nothing. */
export function turnSummary(rows: readonly SummaryRow[]): TurnSummaryPart[] {
  // Only a finished call with a result, and no error, happened: a write the turn ended before it returned may never have run.
  const succeeded = rows.filter((row) => row.tool?.done && row.tool.result_view && !row.tool.is_error)
  const counts = new Map<TurnSummaryKey, number>([['files_changed', turnFileChanges(succeeded).length]])
  for (const { tool } of succeeded) {
    const outcome = tool?.result_view?.outcome
    const key = outcome?.tone === 'neutral' ? summaryKey(tool!.name, outcome.key) : undefined
    // A memory write counts its entries; every other call counts once.
    if (key) counts.set(key, (counts.get(key) ?? 0) + (key === 'memories_saved' ? outcome?.count ?? 1 : 1))
  }
  return TurnSummaryKeySchema.options.flatMap((key) => ((counts.get(key) ?? 0) > 0 ? [{ key, count: counts.get(key)! }] : []))
}
