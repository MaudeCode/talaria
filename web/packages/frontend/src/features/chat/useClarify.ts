import { useEffect, useState } from 'react'
import { useIsMutating, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ClarifyPending, ClarifyStep } from '../../contracts'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { isTerminal, type LiveTurn } from '../../stream/reducer'
import { usePromptAnswer } from './usePromptAnswer'

type Answer = string | string[]
/** One clarify prompt as its answer owner tracks it; the vault card answers the same prompts. */
export const clarifyResource = (sessionId: string, clarifyId: string) => `clarify:${sessionId}:${clarifyId}`
interface Progress { id: string; index: number; answers: Record<string, Answer>; inputRevision: number; selected: string[] }

/** The active clarification and the composer's temporary answer for its current step. */
export interface Clarify {
  pending: ClarifyPending
  step: ClarifyStep
  index: number
  total: number
  /** Changes only when a choice or step replaces the composer's local typed answer. */
  inputRevision: number
  clearSelection: () => void
  selected: string[]
  /** A choice button: answers a single-select step, toggles a multi-select one. */
  choose: (choice: string) => void
  /** The composer's send: answers the current step with the typed text, else the pressed choices. */
  send: (text: string) => void
}

/** The session's clarify queue head while a turn or command runs; every reader shares one query. */
export function useClarifyHead(sessionId: string | null, live: LiveTurn | null) {
  const commands = useIsMutating({ mutationKey: keys.commandExec(sessionId) })
  const running = !!sessionId && (commands > 0 || (!!live && !isTerminal(live.status)))
  const query = useQuery({
    queryKey: keys.clarify(sessionId ?? ''),
    queryFn: () => api.fetchClarifyPending(sessionId ?? ''),
    enabled: running,
    refetchInterval: live?.status === 'streaming' ? 15_000 : 1_500,
  })
  return { running, query }
}

/**
 * While the session's turn or command runs, reads the canonical queue head
 * from `/api/clarify/pending` (docs/sse-streams.md: re-read on every chat-stream `clarify` frame and (re)attach,
 * 1.5 s polls while the stream is unhealthy, a 15 s safety poll otherwise), so a refresh, cold attach, reconnect, or
 * expiry converges on the server's queue. It walks the head's server-ordered steps. Answers stay local until the last step, then go
 * to `/api/clarify/respond` keyed by step id; a failed relay keeps them for retry. A new queue head starts over.
 */
export function useClarify(sessionId: string | null, live: LiveTurn | null): Clarify | null {
  const qc = useQueryClient()
  const { running, query } = useClarifyHead(sessionId, live)
  const frame = live?.clarify
  useEffect(() => {
    if (!frame || !sessionId) return
    // Cancel first: a read already in flight may predate this frame, and a first fetch would otherwise absorb the re-read.
    const queryKey = keys.clarify(sessionId)
    void qc.cancelQueries({ queryKey }).then(() => qc.invalidateQueries({ queryKey }))
  }, [frame, sessionId, qc])
  const pending: ClarifyPending | null = running ? (query.data?.pending ?? null) : null
  const [progress, setProgress] = useState<Progress | null>(null)

  const id = pending?.clarify_id ?? ''
  const steps = pending?.steps ?? []
  const current: Progress = progress?.id === id ? progress : { id, index: 0, answers: {}, inputRevision: 0, selected: [] }
  const step = steps[current.index]

  // The card leaves on the last answer; a refused relay brings it back with the answers kept for a retry.
  const { answer: respond, answered } = usePromptAnswer({
    resource: ({ sid, clarifyId }: { sid: string; clarifyId: string; answers: Record<string, Answer> }) => clarifyResource(sid, clarifyId),
    queryKey: keys.clarify(sessionId ?? ''),
    send: ({ sid, clarifyId, answers }) => api.respondClarify({ session_id: sid, clarify_id: clarifyId, answers }),
    waiting: async ({ sid, clarifyId }) => (await api.fetchClarifyPending(sid)).pending?.clarify_id === clarifyId,
  })
  const submit = (answers: Record<string, Answer>) => { if (sessionId) respond({ sid: sessionId, clarifyId: id, answers }) }

  /** `picked`: a single-select choice, which clears typed text and stays pressed so a failed last submit can be retried. */
  const answer = (value: Answer, picked = false) => {
    if (!step) return
    const answers = { ...current.answers, [step.qid]: value }
    if (current.index < steps.length - 1) setProgress({ id, index: current.index + 1, answers, inputRevision: current.inputRevision + 1, selected: [] })
    else { setProgress({ ...current, answers, ...(picked ? { inputRevision: current.inputRevision + 1, selected: [value as string] } : {}) }); submit(answers) }
  }

  if (!pending || !step || answered(clarifyResource(sessionId ?? '', id))) return null
  return {
    pending,
    step,
    index: current.index,
    total: steps.length,
    inputRevision: current.inputRevision,
    clearSelection: () => { if (current.selected.length) setProgress({ ...current, selected: [] }) },
    selected: current.selected,
    choose: (choice) => {
      if (!step.multi_select) { answer(choice, true); return }
      const selected = current.selected.includes(choice) ? current.selected.filter((c) => c !== choice) : [...current.selected, choice]
      setProgress({ ...current, selected, inputRevision: current.inputRevision + 1 })
    },
    send: (text) => {
      // Typed text wins over pressed choices; typing itself belongs to the composer.
      const typed = text.trim()
      const value: Answer = step.multi_select && !typed ? current.selected : typed || current.selected[0] || ''
      if (value.length) answer(value)
    },
  }
}
