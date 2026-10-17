import type { AgentRuntimeMetadata, ChatReadiness } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'

const CHAT_CONDITION: Record<NonNullable<ChatReadiness['condition']>, () => string> = {
  sidecar_unavailable: m.notice_agent_sidecar_unavailable,
  agent_incompatible: m.notice_agent_incompatible,
  agent_runtime_stale: m.notice_agent_runtime_stale,
}
const RUNTIME_REASON: Record<NonNullable<AgentRuntimeMetadata['agent_runtime_reason']>, () => string> = {
  update_active: m.notice_agent_update_active,
  recovery_incomplete: m.notice_agent_recovery_incomplete,
  source_changed: m.notice_agent_source_changed,
  unknown: m.notice_agent_runtime_stale,
}

/** Wording only: the server owns the condition and recovery classification. */
export function chatConditionText(condition: string | undefined, reason?: AgentRuntimeMetadata['agent_runtime_reason']): string | undefined {
  if (condition === 'agent_runtime_stale') return (reason ? RUNTIME_REASON[reason] : undefined)?.() ?? m.notice_agent_runtime_stale()
  return condition && Object.hasOwn(CHAT_CONDITION, condition) ? CHAT_CONDITION[condition as keyof typeof CHAT_CONDITION]() : undefined
}
