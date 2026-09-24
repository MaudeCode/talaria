import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { fetchAnchorScene } from '../../api/endpoints'
import { m } from '../../paraglide/messages.js'
import { Button } from '../../ui/Button'
import { sceneItems } from './turnActivity'
import { Markdown } from './render/Markdown'
import { ReasoningBlock } from './blocks/ReasoningBlock'
import { ToolCard } from './blocks/ToolCard'
import { DisclosureTurnContext, terminalOutcomeLabel, Worklog, type ActivityMode } from './blocks/Worklog'
import type { ActivityItem, TurnActivity } from './turnActivity'

// The live turn's last rendered height, so the settled row that replaces it can fold from that height.
let lastLiveTurn: { key: string; height: number } | null = null
export function rememberLiveTurnHeight(key: string, height: number) { lastLiveTurn = { key, height } }

const FOLD = { duration: 320, easing: 'ease-out', fill: 'forwards' } as const

/**
 * Folds a just-settled turn from its live height: the collapsed "Worked" body is shown open and animated
 * shut, and a spacer holds any remaining height the live turn lost and shrinks with it, so the work
 * visibly folds into its summary and history glides instead of snapping.
 */
function SettleSpacer({ turnKey }: { turnKey: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const live = lastLiveTurn
    const el = ref.current
    const row = el?.closest('.assistant-turn')
    if (live?.key !== turnKey || !el || !row) return
    lastLiveTurn = null
    if (typeof el.animate !== 'function' || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)) return
    // Grow before measuring: a layout forced while the row is shorter than the live turn would clamp the scroll first.
    el.style.height = `${live.height}px`
    const body = row.querySelector<HTMLElement>(':scope > .assistant-turn-blocks > .activity:not(.open) > .activity-body')
    if (body) body.hidden = false
    const bodyHeight = body?.scrollHeight ?? 0
    if (body && bodyHeight > 0) Object.assign(body.style, { maxHeight: `${bodyHeight}px`, opacity: '1', marginTop: '10px' })
    else if (body) body.hidden = true
    const gap = Math.max(0, live.height - (row.getBoundingClientRect().height - live.height))
    el.style.height = `${gap}px`
    const done = () => { el.style.height = '' }
    if (gap > 1) void el.animate([{ height: `${gap}px` }, { height: '0px' }], FOLD).finished.then(done, () => undefined)
    else done()
    if (body && bodyHeight > 0) {
      const fold = body.animate([{ maxHeight: `${bodyHeight}px`, opacity: 1, marginTop: '10px' }, { maxHeight: '0px', opacity: 0, marginTop: '0px' }], FOLD)
      void fold.finished.then(() => {
        // Hand the body back to the disclosure; a click during the fold may already have reopened it.
        if (!body.parentElement?.classList.contains('open')) body.hidden = true
        Object.assign(body.style, { maxHeight: '', opacity: '', marginTop: '' })
        fold.cancel()
      }, () => undefined)
    }
  }, [turnKey])
  return <div ref={ref} aria-hidden="true" />
}

/** Live events and persisted history share ordering, nesting and final-answer boundaries. */
export function TurnActivityView({ activity, mode, sessionId, scope }: { activity: TurnActivity; mode: ActivityMode; sessionId?: string | undefined; scope?: string | undefined }) {
  if (activity.history && sessionId && mode !== 'hide_all_activity') return <ActivityHistory key={JSON.stringify([scope, sessionId, activity.history])} activity={activity} history={activity.history} mode={mode} sessionId={sessionId} scope={scope} />
  return <ActivityBody activity={activity} mode={mode} />
}

function ActivityHistory({ activity, history, mode, sessionId, scope }: { activity: TurnActivity; history: NonNullable<TurnActivity["history"]>; mode: ActivityMode; sessionId: string; scope: string | undefined }) {
  const query = useInfiniteQuery({
    queryKey: ['worklog-history', scope, sessionId, history],
    initialPageParam: history.before,
    queryFn: ({ pageParam, signal }) => fetchAnchorScene(sessionId, history.ref, history.index, pageParam, signal),
    getNextPageParam: (page) => page.start > 0 && page.rows.length > 0 ? page.start : undefined,
    enabled: false,
  })
  const pages = query.data?.pages.slice().reverse() ?? []
  const items = pages.length ? sceneItems([...pages.flatMap((page) => page.rows), ...(activity.sceneRows ?? [])]) : activity.items
  const remaining = query.data?.pages.at(-1)?.start ?? history.before
  const control = remaining > 0 ? <Button variant="ghost" disabled={query.isFetching} onClick={() => { void query.fetchNextPage() }}>{query.isFetching ? m.loading() : query.isError ? m.retry() : m.show_earlier_steps({ a0: String(remaining) })}</Button> : null
  return <ActivityBody activity={{ ...activity, items }} mode={mode} earlier={control} />
}

function ActivityBody({ activity, mode, earlier }: { activity: TurnActivity; mode: ActivityMode; earlier?: ReactNode }) {
  const { items, finalAnswer, status } = activity
  const running = status === 'running'
  const outcome = terminalOutcomeLabel(status)
  const render = (item: ActivityItem, last: boolean): ReactNode => {
    switch (item.kind) {
      case 'text': return <div key={item.key} className="msg-body"><Markdown text={item.text} streaming={running && last} /></div>
      case 'reasoning': return <ReasoningBlock key={item.key} text={item.text} titles={item.titles} live={running && last} />
      case 'steering': return <div key={item.key} className="anchor-steering-message mt-1 text-[12px] text-muted" data-activity-steering="1">{item.consumed ? m.live_steer_consumed({ text: item.text }) : item.text}</div>
      case 'tool': return <ToolCard key={item.key} call={item.call} />
    }
  }
  const blocks: ReactNode[] = []
  for (let i = 0; i < items.length;) {
    const item = items[i]
    if (!item) break
    // Live work stays flat; tier-2 groups form once the turn settles, so rows never regroup while streaming.
    if (item.kind === 'text' || item.kind === 'steering' || mode !== 'compact_worklog' || running || activity.live) { blocks.push(render(item, i === items.length - 1)); i++; continue }
    const start = i
    while (i < items.length && items[i]?.kind !== 'text' && items[i]?.kind !== 'steering') i++
    const run = items.slice(start, i)
    const contents = run.map((entry, j) => render(entry, start + j === items.length - 1))
    blocks.push(run.length === 1 ? contents[0] : <Worklog key={item.key} sequenceKey={`sequence:${item.key}`} calls={run.flatMap((entry) => entry.kind === 'tool' ? [entry.call] : [])} status={status}>{contents}</Worklog>)
  }
  const calls = items.flatMap((item) => item.kind === 'tool' ? [item.call] : [])
  // A settled turn shows "Worked" whenever the server sent rows for it; live work keeps plain streamed text flat.
  const hasWork = !!earlier || (running ? items.some((item) => item.kind !== 'text') : items.length > 0)
  return (
    <DisclosureTurnContext value={activity.key}>
      {mode !== 'hide_all_activity' && (mode === 'compact_worklog' && hasWork && (running || !activity.live)
        ? <Worklog calls={calls} status={status} expandedByDefault={activity.expandedByDefault === true}>{earlier}{blocks}</Worklog>
        : <>{earlier}{blocks}</>)}
      {mode === 'hide_all_activity' && items.filter((item) => item.kind === 'steering').map((item) => render(item, false))}
      {!running && <SettleSpacer turnKey={activity.key} />}
      {outcome && <div role="status" className="text-muted">{outcome}</div>}
      {finalAnswer.trim() && <div className="msg-body" data-final-answer="1"><Markdown text={finalAnswer} /></div>}
    </DisclosureTurnContext>
  )
}
