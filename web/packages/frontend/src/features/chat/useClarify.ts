import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ClarifyPending, ClarifyStep } from '../../contracts'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { isTerminal, type LiveTurn } from '../../stream/reducer'
import { isApiError } from '../../contracts/common'
import { showToast } from '../toast/toast'

type Answer = string | string[]
interface Progress { id: string; index: number; answers: Record<string, Answer>; text: string; selected: string[] }

/** The active clarification and the composer's temporary answer for its current step. */
export interface Clarify {
  pending: ClarifyPending
  step: ClarifyStep
  index: number
  total: number
  text: string
  setText: (text: string) => void
  selected: string[]
  busy: boolean
  canSend: boolean
  /** A choice button: answers a single-select step, toggles a multi-select one. */
  choose: (choice: string) => void
  /** The composer's send: answers the current step with the typed text, else the pressed choices. */
  send: () => void
}

/**
 * While the session's turn runs (the only time the Agent can park on a question), reads the canonical queue head
 * from `/api/clarify/pending` (docs/sse-streams.md: re-read on every chat-stream `clarify` frame and (re)attach,
 * 1.5 s polls while the stream is unhealthy, a 15 s safety poll otherwise), so a refresh, cold attach, reconnect, or
 * expiry converges on the server's queue. It walks the head's server-ordered steps. Answers stay local until the last step, then go
 * to `/api/clarify/respond` keyed by step id; a failed relay keeps them for retry. A new queue head starts over.
 */
export function useClarify(sessionId: string | null, live: LiveTurn | null): Clarify | null {
  const qc = useQueryClient()
  const running = !!sessionId && !!live && !isTerminal(live.status)
  const query = useQuery({
    queryKey: keys.clarify(sessionId ?? ''),
    queryFn: () => api.fetchClarifyPending(sessionId ?? ''),
    enabled: running,
    refetchInterval: live?.status === 'streaming' ? 15_000 : 1_500,
  })
  const frame = live?.clarify
  useEffect(() => {
    if (!frame || !sessionId) return
    // Cancel first: a read already in flight may predate this frame, and a first fetch would otherwise absorb the re-read.
    const queryKey = keys.clarify(sessionId)
    void qc.cancelQueries({ queryKey }).then(() => qc.invalidateQueries({ queryKey }))
  }, [frame, sessionId, qc])
  const pending: ClarifyPending | null = running ? (query.data?.pending ?? null) : null
  const [progress, setProgress] = useState<Progress | null>(null)
  const [resolved, setResolved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const id = pending?.clarify_id ?? ''
  const steps = pending?.steps ?? []
  const current: Progress = progress?.id === id ? progress : { id, index: 0, answers: {}, text: '', selected: [] }
  const step = steps[current.index]

  const submit = async (answers: Record<string, Answer>) => {
    if (!sessionId) return
    setBusy(true)
    try {
      await api.respondClarify({ session_id: sessionId, clarify_id: id, answers })
      setResolved(id)
    } catch (e) {
      // 409: the prompt already expired or was answered elsewhere; anything else keeps the answers for a retry.
      if (isApiError(e) && e.status === 409) setResolved(id)
      showToast(e instanceof Error ? e.message : String(e), 4000, 'error')
    } finally {
      setBusy(false)
      void qc.invalidateQueries({ queryKey: keys.clarify(sessionId) })
    }
  }

  /** `picked`: a single-select choice, which clears typed text and stays pressed so a failed last submit can be retried. */
  const answer = (value: Answer, picked = false) => {
    if (!step || busy) return
    const answers = { ...current.answers, [step.qid]: value }
    if (current.index < steps.length - 1) setProgress({ id, index: current.index + 1, answers, text: '', selected: [] })
    else { setProgress({ ...current, answers, ...(picked ? { text: '', selected: [value as string] } : {}) }); void submit(answers) }
  }

  // Typed text wins over pressed choices (docs/ui-ux clarify-progress): what is submitted is what is on screen.
  const typed = current.text.trim()
  const value: Answer = step?.multi_select && !typed ? current.selected : typed
  const canSend = !busy && value.length > 0

  if (!pending || !step || resolved === id) return null
  return {
    pending,
    step,
    index: current.index,
    total: steps.length,
    text: current.text,
    setText: (text) => setProgress({ ...current, text, selected: text.trim() ? [] : current.selected }),
    selected: current.selected,
    busy,
    canSend,
    choose: (choice) => {
      if (!step.multi_select) { answer(choice, true); return }
      const selected = current.selected.includes(choice) ? current.selected.filter((c) => c !== choice) : [...current.selected, choice]
      setProgress({ ...current, selected, text: '' })
    },
    send: () => { if (canSend) answer(value) },
  }
}
