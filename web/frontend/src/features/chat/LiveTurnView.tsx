import { useMemo, type ReactElement } from 'react'
import { Link } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import type { LiveTurn } from '../../stream/reducer'
import { Markdown } from './render/Markdown'
import { extractInlineThinking } from './render/text'
import { ReasoningBlock } from './blocks/ReasoningBlock'
import { ToolCard, type ToolCardData } from './blocks/ToolCard'
import { Worklog, type ActivityMode } from './blocks/Worklog'

/** The in-flight assistant turn: reasoning, tools and prose projected from the reducer, in event order. */
export function LiveTurnView({ turn, name, mode, userVisible }: { turn: LiveTurn; name: string; mode: ActivityMode; userVisible: boolean }) {
  const calls: ToolCardData[] = useMemo(() => turn.toolOrder.map((id) => turn.tools[id]).filter((t): t is NonNullable<typeof t> => !!t).map((t) => ({ id: t.id, name: t.name, args: t.args, preview: t.preview, done: t.done, isError: t.isError, duration: t.duration, costUsd: t.costUsd, result: t.result })), [turn.toolOrder, turn.tools])
  const streaming = turn.status === 'streaming' || turn.status === 'connecting' || turn.status === 'reconnecting' || turn.status === 'starting'
  const blocks: ReactElement[] = []
  let textBuffer = ''
  const flushText = (key: string, last: boolean) => {
    if (!textBuffer.trim()) { textBuffer = ''; return }
    const split = extractInlineThinking(textBuffer, streaming && last)
    if (split.reasoning) blocks.push(<ReasoningBlock key={`${key}-think`} text={split.reasoning} live={split.inThinking} />)
    if (split.content.trim()) blocks.push(<div key={key} className="msg-body"><Markdown text={split.content} streaming={streaming && last} /></div>)
    textBuffer = ''
  }
  const toolBlocks: ReactElement[] = []
  turn.segments.forEach((seg, i) => {
    const last = i === turn.segments.length - 1
    if (seg.kind === 'text') { textBuffer += seg.text; if (last) flushText(`t${i}`, true); return }
    flushText(`t${i}`, false)
    if (seg.kind === 'reasoning') { blocks.push(<ReasoningBlock key={`r${i}`} text={seg.text} titles={seg.titles} live={streaming && last} />); return }
    const call = turn.tools[seg.toolId]
    if (call) toolBlocks.push(<ToolCard key={call.id} call={call} />)
  })
  const worklog = calls.length > 0 ? <Worklog key="worklog" mode={mode} calls={calls} live={streaming} defaultOpen={mode !== 'compact_worklog'}>{toolBlocks}</Worklog> : null
  return (
    <div className="msg-row assistant-turn live-turn" data-role="assistant" data-live="1" data-stream-id={turn.streamId} data-status={turn.status} aria-busy={streaming}>
      <div className="msg-role assistant"><span className="msg-role-name">{name}</span></div>
      <div className="assistant-turn-blocks">
        {worklog}
        {blocks}
        {streaming && blocks.length === 0 && calls.length === 0 && (
          <div className="live-run-status flex items-center gap-2 text-[13px] text-muted" role="status" aria-live="polite">
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden="true" />
            {turn.status === 'reconnecting' ? m.live_reconnecting() : m.live_streaming()}
          </div>
        )}
        {streaming && turn.tps !== null && <div className="mt-1 font-mono text-[11px] tabular-nums text-muted opacity-75" title="Tokens per second">{turn.tps.toFixed(1)} tok/s</div>}
        {turn.status === 'reconnecting' && blocks.length > 0 && <div className="mt-1 text-[12px] text-muted" role="status">{m.live_reconnecting()}</div>}
        {turn.warning && <div className="mt-1 text-[12px] text-warning" role="status">{turn.warning}</div>}
        {turn.steerConsumed.map((s) => <div key={s.id} className="anchor-steering-message mt-1 text-[12px] text-muted">{m.live_steer_consumed({ text: s.text })}</div>)}
        {turn.compression && <div className="compression-card mt-2 rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-muted" role="status">{turn.compression.state === 'compressing' ? m.live_compressing() : m.live_compressed()}{turn.compression.newSessionId && turn.compression.state === 'compressed' && <> <Link to="/session/$sessionId" params={{ sessionId: turn.compression.newSessionId }} className="text-accent-text underline">{m.live_continuation()}</Link></>}</div>}
        {turn.status === 'cancelled' && <div className="status-card mt-2 text-[13px] text-muted" role="status">{turn.cancelledMessage || m.live_cancelled()}</div>}
        {turn.status === 'error' && turn.error && (
          <div className="status-card mt-2 rounded-md border border-error/40 bg-surface px-3 py-2 text-[13px]" role="alert">
            <div className="font-medium text-error">{m.live_error()}</div>
            {turn.error.message && <div className="mt-0.5 break-words text-muted">{turn.error.message}</div>}
            {turn.error.hint && <div className="mt-0.5 text-muted">{turn.error.hint}</div>}
            {turn.error.continuationSessionId && <Link to="/session/$sessionId" params={{ sessionId: turn.error.continuationSessionId }} className="mt-1 inline-block text-accent-text underline">{m.live_continuation()}</Link>}
          </div>
        )}
        {!userVisible && turn.status === 'done' && <span className="sr-only" role="status">{m.done()}</span>}
      </div>
    </div>
  )
}
