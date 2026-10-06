import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import type { ComposerNotice } from './ComposerTab'

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

  const run = useCallback(async (command: string) => {
    const gen = ++generation.current
    setCurrent({ sessionId, command, output: '', state: 'running' })
    const settle = (output: string, state: Run['state']): void => { if (generation.current === gen) setCurrent((r) => (r ? { ...r, output, state } : r)) }
    try {
      settle((await api.execCommand(command, sessionId ?? undefined)).output, 'done')
    } catch (e) {
      settle(`${m.command_failed()}${e instanceof Error ? e.message : String(e)}`, 'failed')
    }
  }, [sessionId])

  const notice: ComposerNotice | null = current?.sessionId === sessionId ? {
    id: 'command',
    tone: current.state === 'failed' ? 'error' : undefined,
    content: (
      <span className="flex min-w-0 flex-1 flex-col gap-1" role="region" aria-label={m.command_output_label()} aria-live="polite" aria-busy={current.state === 'running'}>
        <span className="truncate font-mono" title={current.command}>{current.command}</span>
        <span className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-surface-subtle px-2 py-1 font-mono text-[13px]">
          {current.state === 'running'
            ? <span className="inline-flex items-center gap-1.5 font-sans text-muted"><Loader2 size={12} className="animate-spin" aria-hidden="true" />{m.command_running()}</span>
            : current.output}
        </span>
      </span>
    ),
    onDismiss: () => { generation.current += 1; setCurrent(null) },
  } : null
  return { run, notice }
}
