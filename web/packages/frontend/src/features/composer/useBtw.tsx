import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, MessageCircleQuestionMark } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { openChatStream, SSE_CLOSED, type SseHandle } from '../../api/sse'
import { Markdown } from '../chat/render/Markdown'
import type { ComposerNotice } from './ComposerNotices'

interface Side { sessionId: string; question: string; text: string; state: 'asking' | 'answered' | 'failed' }

/**
 * TAL-518: `/btw` asks the server's side-question route and streams its answer into the composer tab, never the
 * transcript. Tokens show as they arrive; the `done` frame's `answer` replaces them. One side question per chat.
 */
export function useBtw(sessionId: string | null): { ask: (question: string) => Promise<void>; notice: ComposerNotice | null } {
  const [side, setSide] = useState<Side | null>(null)
  const stream = useRef<SseHandle | null>(null)
  // Each ask (and each dismissal or chat switch) starts a new generation; a late frame from an older one is dropped.
  const generation = useRef(0)
  const stop = useCallback(() => {
    generation.current += 1
    stream.current?.close()
    stream.current = null
  }, [])
  // Leaving the chat drops its side question; the panel only shows for the chat that asked it.
  useEffect(() => () => { stop(); setSide(null) }, [sessionId, stop])

  const ask = useCallback(async (question: string) => {
    if (!sessionId) return
    stop()
    const gen = generation.current
    const update = (next: (s: Side) => Side): void => { if (generation.current === gen) setSide((s) => (s ? next(s) : s)) }
    const end = (): void => { if (generation.current === gen) stop() }
    const fail = (message?: string): void => { update((s) => ({ ...s, text: `${m.btw_failed()}${message ?? ''}`, state: 'failed' })); end() }
    setSide({ sessionId, question, text: '', state: 'asking' })
    let streamId: string
    try {
      streamId = (await api.askBtw(sessionId, question)).stream_id
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e))
      return
    }
    if (generation.current !== gen) return
    stream.current = openChatStream(streamId, null, {
      onEvent: (event) => {
        if (event.event === 'token') update((s) => ({ ...s, text: s.text + (event.data.text ?? '') }))
        else if (event.event === 'done') {
          const { answer, terminal_state: outcome } = event.data
          update((s) => ({ ...s, text: outcome === 'no_response' || !answer ? m.btw_no_answer() : answer, state: 'answered' }))
          end()
        } else if (event.event === 'apperror' || event.event === 'error' || event.event === 'cancel') fail(event.data.message)
        else if (event.event === 'stream_end') fail()
      },
      onError: (readyState) => { if (readyState === SSE_CLOSED) fail() },
    })
  }, [sessionId, stop])

  const notice: ComposerNotice | null = side?.sessionId === sessionId ? {
    id: 'btw',
    tone: side.state === 'failed' ? 'error' : undefined,
    content: (
      <>
        {side.state === 'asking' ? <Loader2 size={13} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <MessageCircleQuestionMark size={13} className="shrink-0" aria-hidden="true" />}
        <span className="truncate"><span className="sr-only">{m.btw_label()}:</span> {side.question}</span>
      </>
    ),
    detail: {
      title: m.btw_label(),
      content: (
        <span className="flex min-w-0 flex-col gap-2" role="region" aria-label={m.btw_label()} aria-live="polite" aria-busy={side.state === 'asking'}>
          <span className="font-medium [overflow-wrap:anywhere]">{side.question}</span>
          <span className="rounded-md bg-surface-subtle px-2 py-1 text-[13px]">
            {side.text
              ? <Markdown text={side.text} streaming={side.state === 'asking'} />
              : <span className="inline-flex items-center gap-1.5 text-muted"><Loader2 size={12} className="animate-spin" aria-hidden="true" />{m.btw_asking()}</span>}
          </span>
        </span>
      ),
    },
    onDismiss: () => { stop(); setSide(null) },
  } : null
  return { ask, notice }
}
