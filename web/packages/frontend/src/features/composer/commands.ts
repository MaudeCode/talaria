/**
 * Slash commands. The server publishes the canonical catalog (`GET /api/commands`, TAL-314): which commands exist,
 * their aliases, order, and which clients run them. What submitted text does is the server's decision (TAL-1927); the
 * browser keeps only the handlers, keyed by each entry's `name`.
 */
import { useEffect } from 'react'
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Command, CommandDecision } from '../../contracts'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'

const TEXT: CommandDecision = { kind: 'text' }

const decisionQuery = (text: string, sessionId: string | null) => queryOptions({
  queryKey: keys.commandDecision(text, sessionId),
  queryFn: ({ signal }) => api.classifyCommand(text, sessionId, signal),
  staleTime: 5 * 60_000,
})

/**
 * The server's decision for composer text (TAL-1927). The draft is classified once typing pauses, without rendering;
 * `shownClient` is the client command the draft runs, for presentation, and changes only when that name does. `decide`
 * answers for submitted text from the draft's cached decision, or asks the server. Classifying runs nothing, so it may retry.
 */
export function useCommandDecision(text: string, sessionId: string | null, enabled: boolean): { shownClient: string | null; decide: (value: string) => Promise<CommandDecision> } {
  const qc = useQueryClient()
  const draft = text.trim()
  useEffect(() => {
    if (!enabled || !draft) return
    const timer = window.setTimeout(() => { qc.query(decisionQuery(draft, sessionId)).catch(() => undefined) }, 150)
    return () => window.clearTimeout(timer)
  }, [qc, draft, sessionId, enabled])
  const shown = useQuery({ ...decisionQuery(draft, sessionId), enabled: false, placeholderData: (previous) => previous ?? TEXT, select: (d) => d.kind === 'client' ? d.name : null }).data
  return { shownClient: draft ? shown ?? null : null, decide: (value) => qc.query(decisionQuery(value, sessionId)) }
}

export interface CommandSuggestion { name: string; desc: string; args?: string | undefined; category?: string | undefined }

export const toSuggestion = (c: Command): CommandSuggestion => ({ name: c.name, desc: c.description ?? '', args: c.args_hint, category: c.category })
