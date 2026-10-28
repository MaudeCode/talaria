import { useEffect, useRef, useState } from 'react'
import { Loader2, SquareTerminal } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { Markdown } from '../chat/render/Markdown'
import type { ComposerNotice } from './ComposerNotices'

interface Run { sessionId: string | null; command: string; output: string; state: 'running' | 'done' | 'failed' }

/**
 * TAL-561: a catalog entry marked `exec` runs through `POST /api/commands/exec`; its output shows in the composer tab,
 * never the transcript, and no chat turn starts. One output per chat; a newer run replaces it.
 */
export function useCommandOutput(sessionId: string | null): { run: (command: string) => Promise<void>; notice: ComposerNotice | null } {
  const [current, setCurrent] = useState<Run | null>(null)
  // Each run (and each dismissal or chat switch) starts a new generation; a late response from an older one is dropped.
  const generation = useRef(0)
  useEffect(() => () => { generation.current += 1; setCurrent(null) }, [sessionId])

  const run = async (command: string) => {
    const gen = ++generation.current
    setCurrent({ sessionId, command, output: '', state: 'running' })
    const settle = (output: string, state: Run['state']): void => { if (generation.current === gen) setCurrent((r) => (r ? { ...r, output, state } : r)) }
    try {
      settle((await api.execCommand(command, sessionId ?? undefined)).output, 'done')
    } catch (e) {
      settle(`${m.command_failed()}${e instanceof Error ? e.message : String(e)}`, 'failed')
    }
  }

  const notice: ComposerNotice | null = current?.sessionId === sessionId ? {
    id: 'command',
    tone: current.state === 'failed' ? 'error' : undefined,
    content: (
      <>
        {current.state === 'running' ? <Loader2 size={13} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <SquareTerminal size={13} className="shrink-0" aria-hidden="true" />}
        <span className="truncate font-mono"><span className="sr-only">{m.command_output_label()}:</span> {current.command}</span>
      </>
    ),
    detail: {
      title: m.command_output_label(),
      content: (
        <span className="flex min-w-0 flex-col gap-2" role="region" aria-label={m.command_output_label()} aria-live="polite" aria-busy={current.state === 'running'}>
          <span className="font-mono [overflow-wrap:anywhere]">{current.command}</span>
          <span className="rounded-md bg-surface-subtle px-2 py-1 text-[13px]">
            {current.state === 'running'
              ? <span className="inline-flex items-center gap-1.5 text-muted"><Loader2 size={12} className="animate-spin" aria-hidden="true" />{m.command_running()}</span>
              // Command output is line-oriented: a single newline stays a line break.
              : <Markdown text={current.output} className="hermes-prose [&_p]:whitespace-pre-wrap" />}
          </span>
        </span>
      ),
    },
    announcement: current.state === 'running' ? m.command_running() : current.output,
    onDismiss: () => { generation.current += 1; setCurrent(null) },
  } : null
  return { run, notice }
}
