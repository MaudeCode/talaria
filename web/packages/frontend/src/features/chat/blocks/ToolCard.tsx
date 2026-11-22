import { DecisionReviewResult, OutboundDraftResult, ProposalResult, TerminalResult } from './OutboundDraftResult'
import { ShowBlockResult } from './ShowBlockResult'
import { useApprovalFlash, useDisclosure } from './Worklog'
import { Braces, ChevronRight, Copy } from 'lucide-react'
import { cn } from '../../../ui/cn'
import { ToolKindIcon } from '../toolKind'
import type { ApprovalAnsweredBy, BackgroundAgent, BackgroundLink, FileExcerpt, ResultLinks, ResultPage, SearchMatches, ToolApp, ToolApprovalOutcome, ToolField, ToolKind, ToolOutcome, ToolProgress, ToolResultView, ToolRow, ToolRows, ToolVerb } from '@maudecode/talaria-web-contracts'
import { agentsSummary, statusLabel, StatusIcon, useBackgroundTasks } from '../../background/BackgroundWork'
import { RunElapsed } from '../RunElapsed'
import { requestOpenAgent } from '../../background/openAgentRequest'
import { formatElapsed, resetTime } from '../../../i18n/units'
import { toolText } from '../../../i18n/toolText'
import { useLocale } from '../../../i18n/useLocale'
import { m } from '../../../paraglide/messages.js'
import { useQuery } from '@tanstack/react-query'
import { fetchToolResult } from '../../../api/endpoints'
import { useSwitchProfile } from '../../../app/queries'
import { Button, IconButton } from '../../../ui/Button'
import { SwapText } from '../../../ui/SwapText'
import { useArrival } from '../arrival'
import { lazy, Suspense, useState, type ReactNode } from 'react'
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
  /** TAL-2330: an `mcp` or `connector` call's app, which names it and draws a connector's logo (server field). */
  app?: ToolApp | undefined
  target: string
  args: unknown
  /** TAL-2318: the server's argument rows; absent when the arguments are not an object, which shows `args` as text. */
  argsFields?: ToolField[] | undefined
  /** TAL-2338: the server's raw view of the arguments and result, which the row's `{}` toggle shows and Copy copies. */
  rawArgs?: string | undefined
  rawResult?: string | undefined
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
  /** TAL-2341: the open row starts in its raw view (server `opens_raw`, the `formatted_tool_results` switch off). */
  opensRaw?: true | undefined
  /** TAL-2341: the call's media shows only in the open row (server `media_in_details`, the `inline_tool_media` switch off). */
  mediaInDetails?: true | undefined
  /** TAL-2340: when a running call started (epoch ms, from the server's `started_at`); its row's timer counts from it. */
  startedAt?: number | undefined
  /** TAL-2340: the background process the call started (server field `process_id`), whose latest output line shows under it. */
  processId?: string | undefined
}

/** The row's label from its server display fields; an approval card (TAL-2333) labels the call it holds the same way. */
export function toolCardLabel(call: Pick<ToolCardData, 'app' | 'target' | 'isError' | 'kind' | 'verb' | 'done' | 'name'>, locale: string): string {
  // TAL-2330: an app's call reads "<App> · <Action>"; only a failure takes its kind's verb.
  if (call.app) {
    const named = [call.app.name, call.target].filter(Boolean).join(' · ')
    return call.isError ? toolText(locale).actionLabel(call.kind, 'done', named, call.name, true) : named
  }
  // TAL-2327: a call the server gave a verb reads with that verb's phrase of its kind (`kanban_create`).
  return toolText(locale).actionLabel(call.verb ? `${call.kind}_${call.verb}` : call.kind, call.done ? 'done' : 'running', call.target, call.name, call.isError)
}

/** Arguments the server sent no rows for (not an object), as text. */
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
export function FieldRows({ fields }: { fields: ToolField[] }) {
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

/**
 * TAL-2323: a read's lines under its path, highlighted like a chat code block with their real numbers, and where a cut-short read stopped.
 * TAL-2686: an archive read that wrapped its long lines says so, since its numbers count wrapped lines.
 */
function FileExcerptResult({ excerpt, sessionId }: { excerpt: FileExcerpt; sessionId?: string | undefined }) {
  const last = excerpt.lines.at(-1)?.n
  const code = excerpt.lines.map((line) => line.text).join('\n')
  return (
    <div className="tool-file-excerpt">
      {excerpt.path && <div className="mb-1"><FilePath path={excerpt.path} focusPath={excerpt.focus_path} line={excerpt.start_line} sessionId={sessionId} /></div>}
      {excerpt.lines.length > 0 && <div className="max-h-72 overflow-auto rounded-md text-xs"><Suspense fallback={<pre className={RESULT_PRE}>{code}</pre>}><CodeBlockBody code={code} language={excerpt.language ?? 'text'} incomplete={false} numbers={excerpt.lines.map((line) => line.n)} /></Suspense></div>}
      {excerpt.truncated && last !== undefined && <div className={cn(LABEL, 'mt-1')}>{excerpt.total_lines === null ? m.tool_read_stopped_at({ line: String(last) }) : m.tool_read_stopped({ line: String(last), total: String(excerpt.total_lines) })}</div>}
      {excerpt.wrapped_at !== undefined && <div className={cn(LABEL, 'mt-1')}>{m.tool_read_wrapped({ width: String(excerpt.wrapped_at) })}</div>}
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

/** TAL-1171: a chat on another profile, opened after switching to that profile. */
function OtherProfileSessionLink({ label, sessionId, profile }: { label: string; sessionId: string; profile: string }) {
  const switchProfile = useSwitchProfile()
  return <Link to="/session/$sessionId" params={{ sessionId }} onClick={(event) => { event.preventDefault(); switchProfile.mutate({ name: profile, sessionId }) }} className={ROW_LINK} title={label}>{label}</Link>
}

/**
 * TAL-2326: a row's label, opening the Talaria page the server named: a chat (TAL-1171: on its profile), a scheduled job,
 * connections, a skill or (TAL-2327) a Kanban task.
 */
function ToolRowLabel({ row, wrap }: { row: ToolRow; wrap: boolean }) {
  const link = row.link
  if (link?.kind === 'session' && link.id && link.profile) return <OtherProfileSessionLink label={row.label} sessionId={link.id} profile={link.profile} />
  if (link?.kind === 'session' && link.id) return <Link to="/session/$sessionId" params={{ sessionId: link.id }} className={ROW_LINK} title={row.label}>{row.label}</Link>
  if (link?.kind === 'crons' && link.id) return <Link to="/tasks" search={{ job: link.id }} className={ROW_LINK} title={row.label}>{row.label}</Link>
  if (link?.kind === 'connectors') return <Link to="/settings/$section" params={{ section: 'tools' }} search={{ tab: 'connectors' }} className={ROW_LINK} title={row.label}>{row.label}</Link>
  if (link?.kind === 'skill' && link.id) return <Link to="/skills" search={{ skill: link.id }} className={ROW_LINK} title={row.label}>{row.label}</Link>
  if (link?.kind === 'kanban_task' && link.id) return <Link to="/kanban" search={{ ...(link.board ? { board: link.board } : {}), task: link.id }} className={ROW_LINK} title={row.label}>{row.label}</Link>
  return <span className={cn('min-w-0 text-text', wrap ? 'break-words' : 'truncate')} title={row.label}>{row.label}</span>
}

/**
 * TAL-2326: a memory, skill, past-chat, scheduled job, connection or clarify result as its title, rows and a skill's text.
 * TAL-2027: rows shown under a folded row (`wrap`) wrap whole, so an answered question reads in full.
 */
function ToolRowsResult({ rows, wrap = false }: { rows: ToolRows; wrap?: boolean }) {
  return (
    <div className="tool-rows max-h-72 space-y-1.5 overflow-auto">
      {rows.title && <div className={cn(LABEL, wrap ? 'break-words' : 'truncate')} title={rows.title}>{rows.title}</div>}
      {rows.rows.map((row, i) => (
        <div key={i} className="tool-row min-w-0" data-row-status={row.status}>
          <div className="flex min-w-0 items-center gap-1.5">
            {row.status && <Dot state={ROW_DOT[row.status]} />}
            <ToolRowLabel row={row} wrap={wrap} />
          </div>
          {row.detail && <div className={cn('text-xs text-muted', wrap ? 'break-words' : 'truncate')} title={row.detail}>{row.detail}</div>}
        </div>
      ))}
      {rows.markdown && <Markdown text={rows.markdown} className="hermes-prose text-[13px]" />}
    </div>
  )
}

/**
 * TAL-2333: a delegation's subagents under its row, each with its status, goal, seconds once finished and its summary's
 * first line; each opens its unit on the side panel's Agents page.
 */
function DelegateAgents({ agents, sessionId }: { agents: BackgroundAgent[]; sessionId?: string | undefined }) {
  const locale = useLocale()
  return (
    <ul className="tool-card-agents space-y-1 px-2.5 pb-2" aria-label={m.panel_agents()}>
      {agents.map((agent, i) => {
        const open: RowAction | null = sessionId ? { label: m.show_open(), run: () => { requestOpenAgent({ sessionId, taskId: agent.task_id }) } } : null
        const goal = open
          ? <button type="button" className={cn(ROW_LINK, 'text-left')} title={agent.goal} onClick={open.run}>{agent.goal}</button>
          : <span className="min-w-0 truncate text-text" title={agent.goal}>{agent.goal}</span>
        return (
          <li key={i} className="tool-row min-w-0" data-agent-status={agent.status}>
            <RowContextMenu label={agent.goal} actions={[...(open ? [open] : []), { label: m.copy(), run: () => { copyWithToast(agent.goal) } }]} trigger={
              <div className="flex min-w-0 items-center gap-1.5">
                <span title={statusLabel(agent.status)} className="inline-flex shrink-0"><StatusIcon status={agent.status} /></span>
                <span className="sr-only">{statusLabel(agent.status)}</span>
                {goal}
                <span className="flex-1" />
                {agent.duration !== undefined && <span className="shrink-0 text-[11px] tabular-nums text-muted">{formatElapsed(locale, agent.duration)}</span>}
              </div>
            } />
            {agent.summary && <div className="truncate pl-5 text-xs text-muted" title={agent.summary}>{agent.summary}</div>}
          </li>
        )
      })}
    </ul>
  )
}

/** TAL-2027: a card call's rows (an answered question) show under its row without opening it (server `shows_card`). */
const rowsInView = (call: ToolCardData): boolean => call.showsCard === true && Boolean(call.resultView?.rows)

/** The typed section a result view carries in place of its text (TAL-2323, TAL-2324, TAL-2325, TAL-2326). */
const hasSection = (view: ToolResultView | null): boolean => Boolean(view?.file_excerpt ?? view?.matches ?? view?.links ?? view?.pages ?? view?.analysis ?? view?.rows)

/** A result's typed section, else its rows when the server sent them (a JSON object), else its sections as text. */
function ResultBody({ view, text, sessionId, wrap = false }: { view: ToolResultView | null; text: string; sessionId?: string | undefined; wrap?: boolean }) {
  // TAL-2328: code a call ran (an excerpt without a path) shows above its output.
  if (view?.file_excerpt && !view.file_excerpt.path) return <><FileExcerptResult excerpt={view.file_excerpt} sessionId={sessionId} />{text && <pre className={cn(RESULT_PRE, 'mt-2')}>{text}</pre>}</>
  if (view?.file_excerpt) return <FileExcerptResult excerpt={view.file_excerpt} sessionId={sessionId} />
  if (view?.matches) return <MatchesResult matches={view.matches} sessionId={sessionId} />
  if (view?.links) return <LinksResult links={view.links} />
  if (view?.pages) return <PagesResult pages={view.pages} />
  // TAL-2325: what an image or video analysis said, formatted.
  if (view?.analysis) return <Markdown text={view.analysis} className="tool-analysis hermes-prose max-h-72 overflow-auto text-[13px]" />
  if (view?.rows) return <ToolRowsResult rows={view.rows} wrap={wrap} />
  return view?.fields?.length ? <FieldRows fields={view.fields} /> : <pre className={RESULT_PRE}>{text}</pre>
}

/** A result the server clipped or capped: its sections until the reader asks for the whole view, which the server sends redacted. */
function ClippedResult({ sessionId, callId, view, clipped, wrap = false }: { sessionId: string; callId: string; view: ToolResultView | null; clipped: string; wrap?: boolean }) {
  const query = useQuery({ queryKey: ['tool-result', sessionId, callId], queryFn: ({ signal }) => fetchToolResult(sessionId, callId, signal), enabled: false, staleTime: Infinity })
  return (
    <>
      {query.data ? <ResultBody view={query.data.result_view} text={resultText(query.data.result_view)} sessionId={sessionId} wrap={wrap} /> : <ResultBody view={view} text={clipped} sessionId={sessionId} wrap={wrap} />}
      {!query.data && <Button variant="ghost" className="mt-1" disabled={query.isFetching} onClick={() => { void query.refetch() }}>{query.isFetching ? m.loading() : query.isError ? m.retry() : m.tool_show_full_output()}</Button>}
    </>
  )
}

/** TAL-2338: argument or result rows as copied text, one `key: value` line each, a multi-line value under its key. */
const fieldsText = (fields: ToolField[]): string => fields.map((field) => (field.multiline ? `${field.key}:\n${field.value}` : `${field.key}: ${field.value}`)).join('\n')

/**
 * TAL-2338: a result as the reader sees it, for Copy: the same section `ResultBody` shows (a read's lines under its path, a
 * search's `line: text` matches under each file, links, pages, an analysis, rows, key/value rows), else its sections' text.
 */
function resultCopyText(view: ToolResultView | null, text: string): string {
  const join = (parts: (string | undefined)[], separator = '\n') => parts.filter(Boolean).join(separator)
  const excerpt = view?.file_excerpt
  if (excerpt) {
    const lines = excerpt.lines.map((line) => line.text).join('\n')
    return excerpt.path ? join([excerpt.path, lines]) : join([lines, text], '\n\n')
  }
  if (view?.matches) return view.matches.files.map((file) => join([file.path, ...file.matches.map((match) => `${String(match.line)}: ${match.text}`)])).join('\n\n')
  if (view?.links) return join([view.links.answer, ...view.links.items.map((item) => join([item.title, item.url, item.snippet]))], '\n\n')
  if (view?.pages) return view.pages.map((page) => join([page.title, page.url, page.error ?? page.excerpt])).join('\n\n')
  if (view?.analysis) return view.analysis
  if (view?.rows) return join([view.rows.title, ...view.rows.rows.map((row) => join([row.label, row.detail], ': ')), view.rows.markdown])
  return view?.fields?.length ? fieldsText(view.fields) : text
}

/** A detail section's label; the first section's carries the row's tools at its end (TAL-2338). */
function SectionLabel({ label, tools }: { label: string; tools: ReactNode }) {
  return (
    <div className="mb-1 flex min-h-7 items-center gap-2">
      <span className="text-[11px] uppercase tracking-wider text-muted">{label}</span>
      {tools && <span className="tool-card-tools ml-auto flex shrink-0 gap-0.5">{tools}</span>}
    </div>
  )
}

/**
 * An open row's arguments and result. TAL-2338: `{}` switches between them as the row formats them and the server's raw
 * view (`raw_args`, `raw_result`); Copy copies whichever shows. A clipped result's raw view waits for the whole one.
 */
interface DetailProps { call: ToolCardData; sessionId?: string | undefined; args: string; result: string; raw: boolean; onToggleRaw: () => void }
interface FullResult { data?: Awaited<ReturnType<typeof fetchToolResult>> | undefined; isFetching: boolean; isError: boolean; refetch: () => Promise<unknown> }

function ToolCardDetail(props: DetailProps) {
  return props.call.resultTruncated && props.sessionId ? <ClippedToolCardDetail {...props} sessionId={props.sessionId} /> : <ToolCardDetailBody {...props} full={{ isFetching: false, isError: false, refetch: () => Promise.resolve() }} />
}

/** A clipped row's detail: the whole result, shared with its Show full output (`ClippedResult`), which raw view fetches. */
function ClippedToolCardDetail(props: DetailProps & { sessionId: string }) {
  const full = useQuery({ queryKey: ['tool-result', props.sessionId, props.call.id], queryFn: ({ signal }) => fetchToolResult(props.sessionId, props.call.id, signal), enabled: props.raw, staleTime: Infinity })
  return <ToolCardDetailBody {...props} full={full} />
}

function ToolCardDetailBody({ call, sessionId, args, result, raw, onToggleRaw, full }: DetailProps & { full: FullResult }) {
  const clipped = Boolean(call.resultTruncated && sessionId)
  const rawResult = clipped ? full.data?.raw_result : call.rawResult
  const hasRaw = call.rawArgs !== undefined || call.rawResult !== undefined
  const showRaw = raw && hasRaw
  const showArgs = showRaw ? Boolean(call.rawArgs) : call.argsFields ? call.argsFields.length > 0 : Boolean(args && args !== '{}')
  // TAL-2027: rows already in view under the header are not repeated in the open row; Copy still takes them.
  const inView = rowsInView(call)
  const showResult = showRaw ? Boolean(call.rawResult) : !inView && Boolean(result || hasSection(call.resultView))
  // Copy takes the result as it shows: the whole one once fetched, else the row's own.
  const shownResult = full.data ? resultCopyText(full.data.result_view, resultText(full.data.result_view)) : resultCopyText(call.resultView, result)
  const copyText = showRaw
    ? [showArgs ? call.rawArgs : '', rawResult ?? ''].filter(Boolean).join('\n\n')
    : [showArgs ? call.argsFields ? fieldsText(call.argsFields) : args : '', showResult || inView ? shownResult : ''].filter(Boolean).join('\n\n')
  const copyLabel = showRaw ? m.tool_copy_raw() : m.copy()
  const tools = (
    <>
      {hasRaw && <IconButton variant="ghost" className="size-7" label={showRaw ? m.tool_show_formatted() : m.tool_show_raw()} active={showRaw} aria-pressed={showRaw} onClick={onToggleRaw}><Braces aria-hidden="true" /></IconButton>}
      <IconButton variant="ghost" className="size-7" label={copyLabel} disabled={!copyText || (showRaw && clipped && rawResult === undefined)} onClick={() => { copyWithToast(copyText) }}><Copy aria-hidden="true" /></IconButton>
    </>
  )
  const rawPre = (text: string) => <pre className={RESULT_PRE}>{text}</pre>
  return (
    <div className="tool-card-detail border-t border-border-subtle px-2.5 py-2" data-tool-view={showRaw ? 'raw' : 'formatted'}>
      {showArgs && (
        <div className="tool-card-args mb-2">
          <SectionLabel label={m.tool_args_label()} tools={tools} />
          {showRaw ? rawPre(call.rawArgs ?? '') : call.argsFields ? <FieldRows fields={call.argsFields} /> : <pre className={`max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code-bg p-2 ${MONO}`}>{args}</pre>}
        </div>
      )}
      {showResult && (
        <div className="tool-card-result">
          <SectionLabel label={call.isError ? m.tool_error_label() : m.tool_result_label()} tools={showArgs ? null : tools} />
          {showRaw
            ? rawResult !== undefined ? rawPre(rawResult) : <Button variant="ghost" disabled={full.isFetching} onClick={() => { void full.refetch() }}>{full.isError ? m.retry() : m.loading()}</Button>
            : clipped && sessionId ? <ClippedResult sessionId={sessionId} callId={call.id} view={call.resultView} clipped={result} /> : <ResultBody view={call.resultView} text={result} sessionId={sessionId} />}
        </div>
      )}
      {call.costUsd !== null && <div className="mt-1 text-[11px] text-muted">${call.costUsd.toFixed(4)}</div>}
    </div>
  )
}

/** TAL-2335: a call's outcome in the reader's words; the server decided the outcome, its tone and its value. */
export function toolOutcomeText(outcome: ToolOutcome, locale: string): string {
  const count = outcome.count ?? 0
  const value = outcome.value ?? ''
  switch (outcome.key) {
    case 'sent': return m.tool_outcome_sent()
    case 'approved': return m.tool_outcome_approved()
    case 'denied': return m.tool_outcome_denied()
    case 'goal_set': return m.tool_outcome_goal_set()
    case 'created': return m.tool_outcome_created()
    case 'memory_added': return m.tool_outcome_memory_added({ count })
    case 'memory_updated': return m.tool_outcome_memory_updated({ count })
    case 'memory_removed': return m.tool_outcome_memory_removed({ count })
    case 'skill_created': return m.tool_outcome_skill_created()
    case 'skill_updated': return m.tool_outcome_skill_updated()
    case 'pending_approval': return m.tool_outcome_pending_approval()
    case 'job_created': return value ? m.tool_outcome_job_next_run({ when: resetTime(locale, value) }) : m.tool_outcome_job_created()
    case 'paused': return m.tool_outcome_paused()
    case 'resumed': return m.tool_outcome_resumed()
    case 'removed': return m.tool_outcome_removed()
    case 'ran_now': return m.tool_outcome_ran_now()
    case 'moved_to': return m.tool_outcome_moved_to({ status: value })
    case 'blocked': return m.tool_outcome_blocked()
    case 'completed': return m.tool_outcome_completed()
    case 'commented': return m.tool_outcome_commented()
    case 'connected': return m.tool_outcome_connected({ apps: value })
    case 'needs_sign_in': return m.tool_outcome_needs_sign_in()
    case 'answered': return m.tool_outcome_answered({ answer: value })
    case 'skipped': return m.tool_outcome_skipped()
    case 'no_matches': return m.tool_matches_none()
    case 'no_results': return m.tool_links_none()
    case 'exit': return m.tool_outcome_exit({ code: String(count) })
    case 'failed': return value || m.tool_outcome_failed()
  }
}

/** TAL-2340: the latest output line of the background process a call started, from its Background Work record while it runs. */
function ProcessOutputTail({ sessionId, processId }: { sessionId: string; processId: string }) {
  const { data } = useBackgroundTasks(sessionId)
  const tail = data?.tasks.find((task) => task.process_id === processId)?.output_tail
  return tail ? <div className="tool-card-output-tail" title={tail}>{tail}</div> : null
}

/** One tool invocation. Collapsed by default: verb + target; details show arguments and result preview as text. */
export function ToolCard({ call, timestamp, sessionId, arrivalKey }: { call: ToolCardData; timestamp?: string | undefined; sessionId?: string | undefined; /** Its row in a running turn, which opens as it arrives. */ arrivalKey?: string | undefined }) {
  const locale = useLocale()
  const arrival = useArrival(arrivalKey)
  const [open, toggle] = useDisclosure(`tool:${call.id}`, false)
  // TAL-2338: whether the open row shows the server's raw view: the reader's choice once made, else the server's default
  // (TAL-2341 `opens_raw`, which follows the setting while the row stays mounted).
  const [rawChoice, setRawChoice] = useState<boolean | null>(null)
  const raw = rawChoice ?? call.opensRaw === true
  const kind = call.kind
  const label = toolCardLabel(call, locale)
  const args = pretty(call.args)
  const result = call.resultView ? resultText(call.resultView) : call.preview ?? ''
  const flash = useApprovalFlash([call])
  const outcome = call.done && call.resultView?.outcome ? toolOutcomeText(call.resultView.outcome, locale) : ''
  const answeredBy = call.approvalAnsweredBy && (call.approvalAnsweredBy.outcome === 'denied' ? m.tool_approval_denied_by : m.tool_approval_allowed_by)({ title: call.approvalAnsweredBy.title })
  return (
    <div ref={arrival} className={cn('tool-card-row tool-card my-1 rounded-lg border border-border-subtle bg-surface-subtle text-[13px]', call.isError && 'border-error/40', !call.done && 'tool-card-running')} data-tool-id={call.id} data-tool-kind={kind} data-tool-done={call.done ? '1' : '0'} data-tool-error={call.isError ? '1' : undefined}>
      <button type="button" className={cn('tool-card-header flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-text', flash)} aria-expanded={open} onClick={toggle}>
        <ChevronRight size={14} className={cn('tool-card-toggle shrink-0 text-muted transition-transform', open && 'rotate-90')} aria-hidden="true" />
        <span className="tool-card-icon"><ToolKindIcon kind={kind} logoUrl={call.app?.logo_url} /></span>
        <span className="tool-card-name min-w-0 flex-1 truncate"><SwapText className="tool-card-name-label" text={label} /></span>
        {/* TAL-2335: what the call did, after its label: muted, or the error or warning colour the server's tone asks for. */}
        {outcome && <span className="tool-card-outcome" data-outcome-tone={call.resultView?.outcome?.tone} title={outcome}>{outcome}</span>}
        {!call.done && call.progress && <span className="tool-card-progress min-w-0 max-w-[60%] truncate text-[11px] tabular-nums text-muted" title={call.progress.message ?? undefined}>{[call.progress.percent === null ? null : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(call.progress.percent / 100), call.progress.message].filter(Boolean).join(' · ')}</span>}
        {call.background && <span className="tool-card-background shrink-0 text-[11px] text-muted" data-background-status={call.background.status}>{call.background.status === 'running' || call.background.status === 'completed' ? agentsSummary(call.background.agents) : `${statusLabel(call.background.status)} · ${agentsSummary(call.background.agents)}`}</span>}
        {answeredBy && <span className="tool-card-answered-by min-w-0 max-w-[40%] shrink truncate text-[11px] text-muted" data-approval-outcome={call.approvalAnsweredBy?.outcome} title={answeredBy}>{answeredBy}</span>}
        {!call.done && <span className="tool-card-running-dot h-2 w-2 shrink-0 rounded-full bg-accent" aria-label={m.status_streaming()} />}
        {/* TAL-2340: a running call's time so far, which its final duration replaces. */}
        {!call.done && call.startedAt !== undefined && <span className="tool-card-elapsed shrink-0 text-[11px] tabular-nums text-muted"><RunElapsed since={call.startedAt} showSeconds /></span>}
        {call.done && call.duration !== null && <span className="shrink-0 text-[11px] tabular-nums text-muted">{formatElapsed(locale, call.duration)}</span>}
        {timestamp && <span className="shrink-0 text-[11px] tabular-nums text-muted">{timestamp}</span>}
      </button>
      {call.resultView?.decision_review && <DecisionReviewResult key={call.resultView.decision_review.review_id} reference={call.resultView.decision_review} />}
      {call.resultView?.proposal && <ProposalResult key={call.resultView.proposal.proposal_id} reference={call.resultView.proposal} />}
      {call.resultView?.block && <ShowBlockResult key={call.resultView.block.block_id} reference={call.resultView.block} />}
      {/* A clipped exchange keeps its Show full output here, sharing the open row's fetch. */}
      {rowsInView(call) && call.resultView?.rows && <div className="tool-card-rows px-2.5 pb-2">{call.resultTruncated && sessionId ? <ClippedResult sessionId={sessionId} callId={call.id} view={call.resultView} clipped={result} wrap /> : <ToolRowsResult rows={call.resultView.rows} wrap />}</div>}
      {call.background?.agents_detail?.length ? <DelegateAgents agents={call.background.agents_detail} sessionId={sessionId} /> : null}
      {sessionId && call.processId && <ProcessOutputTail sessionId={sessionId} processId={call.processId} />}
      {/* TAL-2325: the images, speech or video a media tool made, in view without opening the call (TAL-2341: only open, while the server says so). */}
      {call.resultView?.media?.length && (open || !call.mediaInDetails) ? <div className="tool-card-media px-2.5 pb-2"><MediaTiles media={call.resultView.media} sessionId={sessionId} images /></div> : null}
      {sessionId && call.resultView?.terminal && <TerminalResult key={call.resultView.terminal.terminal_id} sessionId={sessionId} reference={call.resultView.terminal} />}
      {sessionId && call.resultView?.outbound_draft && <OutboundDraftResult key={JSON.stringify([sessionId, call.id, call.resultView.outbound_draft])} sessionId={sessionId} callId={call.id} reference={call.resultView.outbound_draft} />}
      {open && <ToolCardDetail call={call} sessionId={sessionId} args={args} result={result} raw={raw} onToggleRaw={() => { setRawChoice(!raw) }} />}
    </div>
  )
}
