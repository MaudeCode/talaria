import { DecisionReviewResult, OutboundDraftResult, ProposalResult, TerminalResult } from './OutboundDraftResult'
import { ShowBlockResult } from './ShowBlockResult'
import { useApprovalFlash, useDisclosure } from './Worklog'
import { ChevronRight } from 'lucide-react'
import { cn } from '../../../ui/cn'
import { ToolKindIcon } from '../toolKind'
import type { ApprovalAnsweredBy, BackgroundLink, FileExcerpt, ResultLinks, ResultPage, SearchMatches, ToolApprovalOutcome, ToolField, ToolKind, ToolProgress, ToolResultView, ToolRow, ToolRows, ToolVerb } from '@maudecode/talaria-web-contracts'
import { agentsSummary, statusLabel } from '../../background/BackgroundWork'
import { toolText } from '../../../i18n/toolText'
import { useLocale } from '../../../i18n/useLocale'
import { m } from '../../../paraglide/messages.js'
import { useQuery } from '@tanstack/react-query'
import { fetchToolResult } from '../../../api/endpoints'
import { Button } from '../../../ui/Button'
import { SwapText } from '../../../ui/SwapText'
import { useArrival } from '../arrival'
import { lazy, Suspense } from 'react'
import { requestOpenFile } from '../../workspace/openFileRequest'
import { RowContextMenu, type RowAction } from '../../../ui/Menu'
import { copyWithToast } from '../../../lib/clipboard'
import { Markdown } from '../render/Markdown'
import { Link } from '@tanstack/react-router'
import { Dot, type DotState } from '../../../ui/Badge'
import { MediaTiles } from './MediaTiles'

export interface ToolCardData {
  id: string
  progress?: ToolProgress | null
  name: string
  kind: ToolKind
  /** TAL-2327: the verb a `kanban` call shows in place of its kind's own (server field). */
  verb?: ToolVerb | undefined
  target: string
  args: unknown
  /** TAL-2318: the server's argument rows; absent from an older server, which shows `args` as JSON. */
  argsFields?: ToolField[] | undefined
  preview: string | null
  done: boolean
  isError: boolean
  duration: number | null
  costUsd: number | null
  /** TAL-315: the server's result sections; `null` from a server without them, which shows `preview`. */
  resultView: ToolResultView | null
  /** TAL-372: the background work this call started, updated in place as it finishes (server scene field). */
  background?: BackgroundLink
  /** TAL-331: the server clipped or capped this result; the whole result is one request away. */
  resultTruncated?: boolean
  /** TAL-1783: the answer to the approval that held this call; the row lights once as it arrives. */
  approvalOutcome?: ToolApprovalOutcome | undefined
  /** TAL-1169: another session's agent answered that approval (server field). */
  approvalAnsweredBy?: ApprovalAnsweredBy | undefined
  /** TAL-1968: the call's card must stay in view, outside a folded run of calls (server field `shows_card`). */
  showsCard?: true
}

export function toolCardLabel(call: ToolCardData, locale: string): string {
  // TAL-2327: a call the server gave a verb reads with that verb's phrase of its kind (`kanban_create`).
  return toolText(locale).actionLabel(call.verb ? `${call.kind}_${call.verb}` : call.kind, call.done ? 'done' : 'running', call.target, call.name, call.isError)
}

// ponytail: older-server fallback; delete once every supported server sends `args_fields`.
function pretty(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return '[unserializable]'
  }
}

/** The server's result sections in their order, one after another: text, output, stderr, then the labelled error and exit code, then the approval note. */
function resultText(view: ToolResultView): string {
  return [view.text, view.stdout, view.stderr, view.error === undefined ? undefined : m.tool_result_error({ error: view.error }), view.exit_code === undefined ? undefined : m.tool_result_exit_code({ code: String(view.exit_code) }), view.approval_note]
    .filter((section) => section !== undefined).join('\n')
}

const MONO = 'font-mono text-[12px] text-pre-text'
const RESULT_PRE = `max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code-bg p-2 ${MONO}`
const LABEL = 'text-[11px] text-muted'

/** TAL-2318: the server's key/value rows: a one-line value beside its key, a multi-line one in a scrolling block under it. */
function FieldRows({ fields }: { fields: ToolField[] }) {
  return (
    <dl className="tool-card-fields grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1">
      {fields.map((field, i) => (
        <div key={i} className={field.multiline ? 'col-span-2' : 'contents'}>
          <dt className={cn(LABEL, 'break-words', field.multiline && 'mb-1')}>{field.key}</dt>
          <dd className="min-w-0">{field.multiline ? <pre className={RESULT_PRE}>{field.value}</pre> : <span className={cn('whitespace-pre-wrap break-words', MONO)}>{field.value}</span>}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * TAL-2323: a file path as the Agent wrote it; a button opening the file (at `line`) in the session's Files page when the
 * server located it inside the workspace (`focusPath`).
 */
function FilePath({ path, focusPath, line, sessionId, className }: { path: string; focusPath?: string | undefined; line?: number | undefined; sessionId?: string | undefined; className?: string }) {
  const style = cn('min-w-0 break-all text-left font-mono text-xs', className)
  const open = fileOpen(path, focusPath, line, sessionId)
  const actions = [...(open ? [open] : []), { label: m.copy_file_path(), run: () => { copyWithToast(path) } }]
  const trigger = open
    ? <button type="button" className={cn(style, 'text-accent-text hover:underline')} title={open.label} aria-label={open.label} onClick={open.run}>{path}</button>
    : <span className={cn(style, 'text-text')}>{path}</span>
  return <RowContextMenu label={path} actions={actions} trigger={trigger} />
}

/** TAL-2323: a located file's Open action (at `line`), for its button and its right-click and long-press menu alike. */
function fileOpen(path: string, focusPath: string | undefined, line: number | undefined, sessionId: string | undefined): RowAction | null {
  if (!focusPath || !sessionId) return null
  return { label: line ? m.tool_open_file_at_line({ path, line: String(line) }) : m.show_open(), run: () => { requestOpenFile({ sessionId, path: focusPath, line }) } }
}

/** The chat code block's body, from the renderer chunk the transcript's Markdown loads, so the layout bundle stays without Shiki. */
const CodeBlockBody = lazy(() => import('../render/MarkdownRenderer').then((module) => ({ default: module.CodeBlockBody })))

/** TAL-2323: a read's lines under its path, highlighted like a chat code block with their real numbers, and where a cut-short read stopped. */
function FileExcerptResult({ excerpt, sessionId }: { excerpt: FileExcerpt; sessionId?: string | undefined }) {
  const last = excerpt.lines.at(-1)?.n
  const code = excerpt.lines.map((line) => line.text).join('\n')
  return (
    <div className="tool-file-excerpt">
      {excerpt.path && <div className="mb-1"><FilePath path={excerpt.path} focusPath={excerpt.focus_path} line={excerpt.start_line} sessionId={sessionId} /></div>}
      {excerpt.lines.length > 0 && <div className="max-h-72 overflow-auto rounded-md text-xs"><Suspense fallback={<pre className={RESULT_PRE}>{code}</pre>}><CodeBlockBody code={code} language={excerpt.language ?? 'text'} incomplete={false} numbers={excerpt.lines.map((line) => line.n)} /></Suspense></div>}
      {excerpt.truncated && last !== undefined && <div className={cn(LABEL, 'mt-1')}>{excerpt.total_lines === null ? m.tool_read_stopped_at({ line: String(last) }) : m.tool_read_stopped({ line: String(last), total: String(excerpt.total_lines) })}</div>}
    </div>
  )
}

/** TAL-2323: a search's matches under each file's path, `line: text` rows that open the file at that line. */
function MatchesResult({ matches, sessionId }: { matches: SearchMatches; sessionId?: string | undefined }) {
  if (!matches.files.length) return <div className={cn(LABEL, 'tool-matches')}>{m.tool_matches_none()}</div>
  return (
    <div className="tool-matches max-h-72 space-y-2 overflow-auto">
      {matches.files.map((file, i) => (
        <div key={i}>
          <div className="flex items-baseline gap-2">
            <FilePath path={file.path} focusPath={file.focus_path} line={file.matches[0]?.line} sessionId={sessionId} className="flex-1" />
            {file.count !== undefined && <span className={cn(LABEL, 'shrink-0 tabular-nums')}>{m.tool_match_count({ count: String(file.count) })}</span>}
          </div>
          {file.matches.map((match, j) => {
            const row = <><span className="mr-3 inline-block min-w-[3ch] select-none text-right tabular-nums text-muted">{match.line}</span>{match.text}</>
            const open = fileOpen(file.path, file.focus_path, match.line, sessionId)
            const trigger = open
              ? <button type="button" className={cn('block w-full whitespace-pre-wrap break-words rounded px-1 text-left hover:bg-hover', MONO)} title={open.label} aria-label={open.label} onClick={open.run}>{row}</button>
              : <div className={cn('whitespace-pre-wrap break-words px-1', MONO)}>{row}</div>
            return <RowContextMenu key={j} label={`${file.path}:${String(match.line)}`} actions={[...(open ? [open] : []), { label: m.copy(), run: () => { copyWithToast(match.text) } }]} trigger={trigger} />
          })}
        </div>
      ))}
      {matches.truncated && <div className={LABEL}>{m.tool_matches_more()}</div>}
    </div>
  )
}

/** TAL-2324: a link's title opening its page in a new tab, beside the host it opens; text when the server sent no web URL. */
function ResultLinkTitle({ title, url, domain }: { title: string; url: string; domain: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      {url ? <a href={url} target="_blank" rel="noopener noreferrer" title={url} className="min-w-0 truncate text-accent-text hover:underline">{title}</a> : <span className="min-w-0 truncate text-text">{title}</span>}
      {domain && <span className={cn(LABEL, 'shrink-0')}>{domain}</span>}
    </div>
  )
}

/** TAL-2324: a search's links as title, domain and a one-line snippet; an X search's answer, formatted, above the links it cited. */
function LinksResult({ links }: { links: ResultLinks }) {
  return (
    <div className="tool-links max-h-72 space-y-2 overflow-auto">
      {links.answer && <Markdown text={links.answer} className="hermes-prose text-[13px]" />}
      {!links.answer && !links.items.length && <div className={LABEL}>{m.tool_links_none()}</div>}
      {links.items.map((item, i) => (
        <div key={i} className="tool-link min-w-0">
          <ResultLinkTitle title={item.title} url={item.url} domain={item.domain} />
          {item.snippet && <div className="truncate text-xs text-muted" title={item.snippet}>{item.snippet}</div>}
        </div>
      ))}
    </div>
  )
}

/** TAL-2324: each extracted page's title and domain over the start of its text; a page that failed as its error on one line. */
function PagesResult({ pages }: { pages: ResultPage[] }) {
  return (
    <div className="tool-pages max-h-72 space-y-3 overflow-auto">
      {pages.map((page, i) => (
        <div key={i} className="tool-page min-w-0">
          <ResultLinkTitle title={page.title} url={page.url} domain={page.domain} />
          {page.error ? <div className="truncate text-xs text-error" title={page.error}>{page.error}</div> : page.excerpt && <Markdown text={page.excerpt} className="hermes-prose text-[13px] text-muted" />}
        </div>
      ))}
    </div>
  )
}

const ROW_DOT: Record<NonNullable<ToolRow['status']>, DotState> = { ok: 'ok', warn: 'warning', error: 'error', pending: 'changed' }
const ROW_LINK = 'min-w-0 truncate text-accent-text hover:underline'

/** TAL-2326: a row's label, opening the Talaria page the server named: a chat, the scheduled jobs page, connections, a skill or (TAL-2327) a Kanban task. */
function ToolRowLabel({ row }: { row: ToolRow }) {
  const link = row.link
  if (link?.kind === 'session' && link.id) return <Link to="/session/$sessionId" params={{ sessionId: link.id }} className={ROW_LINK} title={row.label}>{row.label}</Link>
  if (link?.kind === 'crons') return <Link to="/tasks" search={link.id ? { job: link.id } : {}} className={ROW_LINK} title={row.label}>{row.label}</Link>
  if (link?.kind === 'connectors') return <Link to="/settings/$section" params={{ section: 'tools' }} search={{ tab: 'connectors' }} className={ROW_LINK} title={row.label}>{row.label}</Link>
  if (link?.kind === 'skill' && link.id) return <Link to="/skills" search={{ skill: link.id }} className={ROW_LINK} title={row.label}>{row.label}</Link>
  if (link?.kind === 'kanban_task' && link.id) return <Link to="/kanban" search={{ ...(link.board ? { board: link.board } : {}), task: link.id }} className={ROW_LINK} title={row.label}>{row.label}</Link>
  return <span className="min-w-0 truncate text-text" title={row.label}>{row.label}</span>
}

/** TAL-2326: a memory, skill, past-chat, scheduled job, connection or clarify result as its title, rows and a skill's text. */
function ToolRowsResult({ rows }: { rows: ToolRows }) {
  return (
    <div className="tool-rows max-h-72 space-y-1.5 overflow-auto">
      {rows.title && <div className={cn(LABEL, 'truncate')} title={rows.title}>{rows.title}</div>}
      {rows.rows.map((row, i) => (
        <div key={i} className="tool-row min-w-0" data-row-status={row.status}>
          <div className="flex min-w-0 items-center gap-1.5">
            {row.status && <Dot state={ROW_DOT[row.status]} />}
            <ToolRowLabel row={row} />
          </div>
          {row.detail && <div className="truncate text-xs text-muted" title={row.detail}>{row.detail}</div>}
        </div>
      ))}
      {rows.markdown && <Markdown text={rows.markdown} className="hermes-prose text-[13px]" />}
    </div>
  )
}

/** The typed section a result view carries in place of its text (TAL-2323, TAL-2324, TAL-2325, TAL-2326). */
const hasSection = (view: ToolResultView | null): boolean => Boolean(view?.file_excerpt ?? view?.matches ?? view?.links ?? view?.pages ?? view?.analysis ?? view?.rows)

/** A result's typed section, else its rows when the server sent them (a JSON object), else its sections as text. */
function ResultBody({ view, text, sessionId }: { view: ToolResultView | null; text: string; sessionId?: string | undefined }) {
  if (view?.file_excerpt) return <FileExcerptResult excerpt={view.file_excerpt} sessionId={sessionId} />
  if (view?.matches) return <MatchesResult matches={view.matches} sessionId={sessionId} />
  if (view?.links) return <LinksResult links={view.links} />
  if (view?.pages) return <PagesResult pages={view.pages} />
  // TAL-2325: what an image or video analysis said, formatted.
  if (view?.analysis) return <Markdown text={view.analysis} className="tool-analysis hermes-prose max-h-72 overflow-auto text-[13px]" />
  if (view?.rows) return <ToolRowsResult rows={view.rows} />
  return view?.fields?.length ? <FieldRows fields={view.fields} /> : <pre className={RESULT_PRE}>{text}</pre>
}

/** A result the server clipped or capped: its sections until the reader asks for the whole view, which the server sends redacted. */
function ClippedResult({ sessionId, callId, view, clipped }: { sessionId: string; callId: string; view: ToolResultView | null; clipped: string }) {
  const query = useQuery({ queryKey: ['tool-result', sessionId, callId], queryFn: ({ signal }) => fetchToolResult(sessionId, callId, signal), enabled: false, staleTime: Infinity })
  return (
    <>
      {query.data ? <ResultBody view={query.data.result_view} text={resultText(query.data.result_view)} sessionId={sessionId} /> : <ResultBody view={view} text={clipped} sessionId={sessionId} />}
      {!query.data && <Button variant="ghost" className="mt-1" disabled={query.isFetching} onClick={() => { void query.refetch() }}>{query.isFetching ? m.loading() : query.isError ? m.retry() : m.tool_show_full_output()}</Button>}
    </>
  )
}

/** One tool invocation. Collapsed by default: verb + target; details show arguments and result preview as text. */
export function ToolCard({ call, timestamp, sessionId, arrivalKey }: { call: ToolCardData; timestamp?: string | undefined; sessionId?: string | undefined; /** Its row in a running turn, which opens as it arrives. */ arrivalKey?: string | undefined }) {
  const locale = useLocale()
  const arrival = useArrival(arrivalKey)
  const [open, toggle] = useDisclosure(`tool:${call.id}`, false)
  const kind = call.kind
  const label = toolCardLabel(call, locale)
  const args = pretty(call.args)
  const result = call.resultView ? resultText(call.resultView) : call.preview ?? ''
  const flash = useApprovalFlash([call])
  const answeredBy = call.approvalAnsweredBy && (call.approvalAnsweredBy.outcome === 'denied' ? m.tool_approval_denied_by : m.tool_approval_allowed_by)({ title: call.approvalAnsweredBy.title })
  return (
    <div ref={arrival} className={cn('tool-card-row tool-card my-1 rounded-lg border border-border-subtle bg-surface-subtle text-[13px]', call.isError && 'border-error/40', !call.done && 'tool-card-running')} data-tool-id={call.id} data-tool-kind={kind} data-tool-done={call.done ? '1' : '0'} data-tool-error={call.isError ? '1' : undefined}>
      <button type="button" className={cn('tool-card-header flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-text', flash)} aria-expanded={open} onClick={toggle}>
        <ChevronRight size={14} className={cn('tool-card-toggle shrink-0 text-muted transition-transform', open && 'rotate-90')} aria-hidden="true" />
        <span className="tool-card-icon"><ToolKindIcon kind={kind} /></span>
        <span className="tool-card-name min-w-0 flex-1 truncate"><SwapText className="tool-card-name-label" text={label} /></span>
        {!call.done && call.progress && <span className="tool-card-progress min-w-0 max-w-[60%] truncate text-[11px] tabular-nums text-muted" title={call.progress.message ?? undefined}>{[call.progress.percent === null ? null : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(call.progress.percent / 100), call.progress.message].filter(Boolean).join(' · ')}</span>}
        {call.background && <span className="tool-card-background shrink-0 text-[11px] text-muted" data-background-status={call.background.status}>{call.background.status === 'running' || call.background.status === 'completed' ? agentsSummary(call.background.agents) : `${statusLabel(call.background.status)} · ${agentsSummary(call.background.agents)}`}</span>}
        {answeredBy && <span className="tool-card-answered-by min-w-0 max-w-[40%] shrink truncate text-[11px] text-muted" data-approval-outcome={call.approvalAnsweredBy?.outcome} title={answeredBy}>{answeredBy}</span>}
        {!call.done && <span className="tool-card-running-dot h-2 w-2 shrink-0 rounded-full bg-accent" aria-label={m.status_streaming()} />}
        {call.done && call.duration !== null && <span className="shrink-0 text-[11px] tabular-nums text-muted">{call.duration.toFixed(1)}s</span>}
        {timestamp && <span className="shrink-0 text-[11px] tabular-nums text-muted">{timestamp}</span>}
      </button>
      {call.resultView?.decision_review && <DecisionReviewResult key={call.resultView.decision_review.review_id} reference={call.resultView.decision_review} />}
      {call.resultView?.proposal && <ProposalResult key={call.resultView.proposal.proposal_id} reference={call.resultView.proposal} />}
      {call.resultView?.block && <ShowBlockResult key={call.resultView.block.block_id} reference={call.resultView.block} />}
      {/* TAL-2325: the images, speech or video a media tool made, in view without opening the call. */}
      {call.resultView?.media?.length ? <div className="tool-card-media px-2.5 pb-2"><MediaTiles media={call.resultView.media} sessionId={sessionId} images /></div> : null}
      {sessionId && call.resultView?.terminal && <TerminalResult key={call.resultView.terminal.terminal_id} sessionId={sessionId} reference={call.resultView.terminal} />}
      {sessionId && call.resultView?.outbound_draft && <OutboundDraftResult key={JSON.stringify([sessionId, call.id, call.resultView.outbound_draft])} sessionId={sessionId} callId={call.id} reference={call.resultView.outbound_draft} />}
      {open && (
        <div className="tool-card-detail border-t border-border-subtle px-2.5 py-2">
          {(call.argsFields ? call.argsFields.length > 0 : args && args !== '{}') && (
            <div className="tool-card-args mb-2">
              <div className="mb-1 text-[11px] uppercase tracking-wider text-muted">{m.tool_args_label()}</div>
              {call.argsFields ? <FieldRows fields={call.argsFields} /> : <pre className={`max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code-bg p-2 ${MONO}`}>{args}</pre>}
            </div>
          )}
          {(result || hasSection(call.resultView)) && (
            <div className="tool-card-result">
              <div className="mb-1 text-[11px] uppercase tracking-wider text-muted">{call.isError ? m.tool_error_label() : m.tool_result_label()}</div>
              {call.resultTruncated && sessionId ? <ClippedResult sessionId={sessionId} callId={call.id} view={call.resultView} clipped={result} /> : <ResultBody view={call.resultView} text={result} sessionId={sessionId} />}
            </div>
          )}
          {call.costUsd !== null && <div className="mt-1 text-[11px] text-muted">${call.costUsd.toFixed(4)}</div>}
        </div>
      )}
    </div>
  )
}
