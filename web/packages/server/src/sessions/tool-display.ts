/**
 * The server's one tool classifier: every client shows a call's icon, verb and label from the `kind` and `target` this
 * module computes for live frames and the public projection of persisted calls (`redact.ts` stamps them). Callers pass
 * redacted args, so the target never shows more than the arguments it came from.
 */
import type { FileExcerpt, FileExcerptLine, ResultLink, ResultLinks, ResultPage, SearchMatches, SearchMatchFile, ToolApp, ToolEditDiff, ToolKind, ToolOutcome, ToolPresentation, ToolPresentationEntry, ToolProgress, ToolResultView, ToolRow, ToolRows, ToolVerb } from '@maudecode/talaria-web-contracts'
import { DecisionReviewRefSchema, DisplayMediaSchema, FileExcerptSchema, OutboundDraftRefSchema, SearchMatchesSchema, ProposalRefSchema, ShowBlockRefSchema, TALARIA_TOOL_NAMES, TerminalRefSchema, TOOL_PRESENTATIONS, type DecisionReviewRef, type DisplayMedia, type OutboundDraftRef, type ProposalRef, type ShowBlockRef, type TerminalRef } from '@maudecode/talaria-web-contracts'
import { posix } from 'node:path'
import { str } from '../util.js'
import { expandHome } from '../workspace/paths.js'
import { diffHunks, hunkTotals } from '../text/diff.js'
import { isDict, messageText, TOOL_ARG_CONTENT_CAP, TOOL_ARG_CONTENT_KEYS } from './merge.js'
import { displaySetting } from './display-settings.js'
import { inlineRemoteImage, vouchRemoteImage } from '../http/remote-image.js'
import { isRemoteImageSource } from '../workspace/media-refs.js'

/** Only a structured tool reply supplies a locator. Its content/authority still comes from the registered backend. */
export function outboundDraftRef(name: unknown, raw: unknown): OutboundDraftRef | undefined {
  if (name !== 'draft_card') return undefined
  let value = Array.isArray(raw) ? messageText(raw) : raw
  if (typeof value === 'string') { try { value = JSON.parse(value) as unknown } catch { return undefined } }
  if (!isDict(value) || value.error || typeof value.card !== 'string') return undefined
  const match = /^::draft-card\{id="(d_[0-9a-f]{8})" v="([1-9][0-9]*)"\}$/.exec(value.card)
  if (!match || match[1] !== value.draft_id) return undefined
  return OutboundDraftRefSchema.safeParse({ draft_id: value.draft_id, card: Number(match[2]) }).data
}

/** TAL-1963: the transcript card's reference from a `decision_review_put` result (parsed JSON), or nothing. */
export function decisionReviewRef(name: unknown, value: unknown): DecisionReviewRef | undefined {
  if (name !== 'decision_review_put' || !isDict(value) || value.error) return undefined
  return DecisionReviewRefSchema.safeParse({ review_id: value.review_id, title: value.title, progress: value.progress }).data
}

/** TAL-1967: the transcript card's reference from a `propose` result (parsed JSON), or nothing. */
export function proposalRef(name: unknown, value: unknown): ProposalRef | undefined {
  if (name !== 'propose' || !isDict(value) || value.error) return undefined
  return ProposalRefSchema.safeParse({ proposal_id: value.proposal_id, kind: value.kind, summary: value.summary }).data
}

/** TAL-1968: the transcript block's reference from a `show` or (TAL-1971) `deliver` result (parsed JSON), or nothing. */
export function showBlockRef(name: unknown, value: unknown): ShowBlockRef | undefined {
  if ((name !== 'show' && name !== 'deliver') || !isDict(value) || value.error) return undefined
  return ShowBlockRefSchema.safeParse({ block_id: value.block_id, kind: value.kind, title: value.title }).data
}

/** TAL-1974: the transcript card's reference from a `terminal_open` result (parsed JSON), or nothing; the command shows only when it is not the title. */
export function terminalRef(name: unknown, value: unknown): TerminalRef | undefined {
  if (name !== 'terminal_open' || !isDict(value) || value.error) return undefined
  return TerminalRefSchema.safeParse({ terminal_id: value.terminal_id, title: value.title, command: value.command === value.title ? null : value.command }).data
}

/** Ordered rules over whole `_`-separated name tokens (a substring match would read `merge` as `rg`). */
const RULES: [ToolKind, (tokens: Set<string>, name: string) => boolean][] = [
  ['delegate', (_, n) => n === 'subagent_progress' || n === 'delegate_task'],
  ['skill', (t) => t.has('skill') || t.has('skills')],
  ['memory', (t) => t.has('memory')],
  ['web', (_, n) => n === 'browser_exec'],
  ['shell', (t, n) => ['terminal', 'shell', 'command', 'process', 'bash', 'exec'].some((k) => t.has(k)) || n === 'execute_code'],
  ['read', (t) => ['read', 'view', 'open'].some((k) => t.has(k))],
  ['list', (t, n) => t.has('list') || n === 'todo'],
  ['web', (t) => ['web', 'fetch', 'curl', 'extract', 'browse', 'browser', 'navigate'].some((k) => t.has(k))],
  ['search', (t) => ['search', 'grep', 'find', 'rg', 'ripgrep', 'glob'].some((k) => t.has(k))],
  ['write', (t) => ['write', 'patch', 'edit'].some((k) => t.has(k))],
]

/** TAL-2317: Talaria's own tools, by exact name, before any name-token rule reads them. */
const TALARIA_TOOLS = new Set<string>(TALARIA_TOOL_NAMES)

/** TAL-2322: a supported Agent's registered tool's table entry; undefined for any other name (MCP, connector, plugin, Talaria). */
function agentTool(name: unknown): ToolPresentationEntry | undefined {
  return typeof name === 'string' && Object.hasOwn(TOOL_PRESENTATIONS, name) ? TOOL_PRESENTATIONS[name] : undefined
}

/** TAL-2322: how a registered Agent tool's result shows; undefined for a name the table does not list. */
export const toolPresentation = (name: unknown): ToolPresentation | undefined => agentTool(name)?.presentation

export function toolKind(name: unknown): ToolKind {
  if (typeof name === 'string' && TALARIA_TOOLS.has(name)) return 'talaria'
  return appTool(name)?.kind ?? agentTool(name)?.kind ?? tokenToolKind(name)
}

/**
 * TAL-2330: the kind a file decision (focus path, edit diff) reads: an MCP or connector tool's from its name tokens, as it
 * was before its app kind, so `mcp__filesystem__read_file` still focuses its file and a `write_file` keeps its diff.
 */
const fileKind = (name: unknown): ToolKind => (appTool(name) ? tokenToolKind(name) : toolKind(name))

/** TAL-2330: the Agent's titles for apps a slug does not spell (`tools/tool_labels.py` `_APP_TITLES`), by lowercase slug. */
const APP_TITLES: Record<string, string> = {
  discord: 'Discord', figma: 'Figma', github: 'GitHub', gmail: 'Gmail', googlecalendar: 'Google Calendar', googledocs: 'Google Docs',
  googledrive: 'Google Drive', jira: 'Jira', linear: 'Linear', notion: 'Notion', outlook: 'Outlook', slack: 'Slack', stripe_mcp: 'Stripe', todoist: 'Todoist',
}

/** TAL-2330: an app's title as the Agent's `app_title` gives it: a known title, else each `-`/`_`/space-separated word capitalized. */
export function appTitle(slug: string): string {
  const key = slug.trim()
  if (Object.hasOwn(APP_TITLES, key.toLowerCase())) return APP_TITLES[key.toLowerCase()]!
  return key.split(/[-_\s]+/).filter(Boolean).map((word) => { const [head = '', ...rest] = word; return head.toUpperCase() + rest.join('') }).join(' ') || key
}

/** TAL-2330: a tool slug as the Agent's `_action_phrase` reads it, in sentence case: a connector's `<APP>_` vendor prefix dropped. */
function actionPhrase(tool: string, app = ''): string {
  let text = tool.trim()
  const prefix = `${app.replaceAll('-', '_').toUpperCase()}_`
  if (app && text.toUpperCase().startsWith(prefix)) text = text.slice(prefix.length)
  const [head = '', ...rest] = text.split(/[-_\s]+/).filter(Boolean).join(' ').toLowerCase()
  return head.toUpperCase() + rest.join('')
}

/**
 * TAL-2330: each connector's catalog logo by slug, from the last catalog read; a connector call shows its app's. TAL-2199:
 * inline (`inlineRemoteImage`), so it loads under the page's CSP: null until its fetch lands, or when that fails.
 */
const connectorLogos = new Map<string, string | null>()
/** Settles once every logo of this catalog read has its inline form (or none). */
export function rememberConnectorLogos(catalog: readonly { slug: string; logo_url: string | null }[], fetchImpl?: typeof fetch): Promise<void> {
  return Promise.all(catalog.map(async (row) => {
    if (!connectorLogos.has(row.slug)) connectorLogos.set(row.slug, null)
    connectorLogos.set(row.slug, row.logo_url ? await inlineRemoteImage(row.logo_url, fetchImpl) : null)
  })).then(() => undefined)
}
/** A connector's logo as clients show it. */
export const connectorLogo = (slug: string): string | null => connectorLogos.get(slug) ?? null

/** Connector slugs a catalog read was started for, so an app the catalog lacks is asked for once. */
const logoReads = new Set<string>()
/**
 * TAL-2330: true, once per app, for a connector call whose app no catalog read has covered. ponytail: after a restart a reload
 * shows the connector icon until a catalog read (Settings › Connectors, a connect card, a new connector call).
 */
export function connectorLogoUnread(name: unknown): boolean {
  const app = appTool(name)
  if (app?.kind !== 'connector' || connectorLogos.has(app.slug) || logoReads.has(app.slug)) return false
  logoReads.add(app.slug)
  return true
}

/**
 * TAL-2330: an MCP server's tool (`mcp__<server>__<tool>`) or a hosted connector's (`connectors__<app>__<tool>`), split as the
 * Agent's `label_for_tool_name` splits it; undefined for any other name, or one with no tool.
 */
function appTool(name: unknown): { kind: 'mcp' | 'connector'; slug: string; tool: string } | undefined {
  if (typeof name !== 'string') return undefined
  const connector = /^connectors__(.*?)__(.*)$/s.exec(name)
  if (connector) return connector[1] && connector[2] ? { kind: 'connector', slug: connector[1], tool: connector[2] } : undefined
  const mcp = /^mcp__(.*?)__(.+)$/s.exec(name)
  return mcp ? { kind: 'mcp', slug: mcp[1]!, tool: mcp[2]! } : undefined
}

/** The name-token rules, for a tool neither Talaria nor the Agent table lists. */
export function tokenToolKind(name: unknown): ToolKind {
  // camelCase and acronym words split like snake_case ones (`readFile` is `read`, `file`; `HTTPFetch` is `http`, `fetch`).
  const n = str(name).replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!n) return 'unknown'
  const tokens = new Set(n.split('_'))
  return RULES.find(([, match]) => match(tokens, n))?.[0] ?? 'unknown'
}

const TARGET_KEYS: Partial<Record<ToolKind, string[]>> = {
  shell: ['cmd', 'command'],
  skill: ['name', 'skill'],
  memory: ['target', 'name', 'action'],
  read: ['path', 'file_path', 'file', 'target', 'name'],
  write: ['path', 'file_path', 'file', 'target', 'name'],
  search: ['query', 'pattern', 'url', 'uri'],
  web: ['query', 'pattern', 'url', 'uri', 'session', 'code'],
  // TAL-2325: a media tool reads as its kind's phrase ("Generated an image"), never a prompt or path.
  image: [], audio: [], video: [], image_analysis: [], video_analysis: [],
  // TAL-2326: a session search names its query, a job its name; connections and questions read as their kind's phrase.
  session: ['query', 'session_id'], schedule: ['name', 'job_id'], connection: [], question: [],
  // TAL-2327: a Kanban call names its task (a new one by its title, a link by its child); a list reads as its verb's phrase.
  kanban: ['task_id', 'title', 'child_id'],
  // TAL-2328: browser code names its session, else its first line (TAL-1805), the comment the Agent asks it to start with; a
  // CDP command its method. Every other browser or computer call reads as its verb's phrase: its arguments are a handle,
  // typed text or coordinates.
  browser: ['session', 'code', 'method'], computer: [],
}
/** TAL-2317: the Talaria tools named by what they act on; every other one is named by the tool itself. */
const TALARIA_TARGET_KEYS: Record<string, string[]> = { deliver: ['path'], terminal_open: ['command'] }
const FALLBACK_KEYS = ['cmd', 'command', 'path', 'file_path', 'file', 'uri', 'url', 'query', 'pattern', 'dir', 'task', 'name']
const TOOL_TARGET_MAX = 200
/** A target whitespace-collapsed and capped by code point, so the cap never splits a surrogate pair into invalid JSON. */
const capped = (text: string): string => Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, TOOL_TARGET_MAX).join('')

/** Python's `repr` of a JSON value (what `str()` shows for items inside a list or dict). */
function pythonRepr(value: unknown): string {
  if (typeof value === 'string') {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'"
    return quote + value.replace(/[\\\n\r\t]/g, (c) => ({ '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' })[c]!).replaceAll(quote, `\\${quote}`) + quote
  }
  return pythonStr(value)
}

/**
 * A JSON value in Python's `str()` shape with JavaScript number text (a persisted `1.0` parses to `1`). The sidecar's
 * `_display_str` renders a live non-string argument by this same rule, so a call shows one target live and after reload.
 */
function pythonStr(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (Array.isArray(value)) return `[${value.map(pythonRepr).join(', ')}]`
  if (isDict(value)) return `{${Object.entries(value).map(([k, v]) => `${pythonRepr(k)}: ${pythonRepr(v)}`).join(', ')}}`
  return typeof value === 'number' ? String(value) : ''
}

/**
 * An argument as the live frame carries it (the sidecar's `_args_snapshot`): only the first four arguments, and a
 * non-content value capped at 120 code points plus `...`. Targets come from this view, so a call shows the same target
 * live and after reload.
 */
function snapshotArg(args: Record<string, unknown>, key: string): string | null {
  if (!Object.keys(args).slice(0, 4).includes(key) || args[key] === undefined) return null
  return snapshotValue(key, args[key])
}

function snapshotValue(key: string, raw: unknown): string {
  const value = pythonStr(raw)
  const cap = TOOL_ARG_CONTENT_KEYS.has(key.toLowerCase()) ? TOOL_ARG_CONTENT_CAP : 120
  const chars = Array.from(value)
  return chars.length > cap ? `${chars.slice(0, cap).join('')}...` : value
}

/**
 * A persisted call's arguments as the live frame carries them (the sidecar's `_args_snapshot`), so its target is
 * redacted after the same cap the live one was (a credential straddling the cap masks alike). Idempotent on a snapshot.
 */
export function snapshotArgs(args: unknown): unknown {
  if (!isDict(args)) return args
  return Object.fromEntries(Object.entries(args).slice(0, 4).filter(([, v]) => v !== undefined).map(([k, v]) => [k, snapshotValue(k, v)]))
}

/** A `goal` key with its string value (group 3), else any other string, consumed whole so its text never reads as a key. */
const TASK_GOAL = /(['"])goal\1:\s*(['"])((?:(?!\2)[^\\]|\\.)*)\2?|(['"])(?:(?!\4)[^\\]|\\.)*\4?/gs

/** A string's backslash escapes, in `pythonStr` or JSON text. Well-formed, since the snapshot cap can split an escaped surrogate pair. */
function unescapeGoal(goal: string): string {
  return goal.replace(/\\(u[0-9a-fA-F]{4}|.)/gs, (_, c: string) => (c.length > 1 ? String.fromCharCode(parseInt(c.slice(1), 16)) : ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[c] ?? c)).replace(/\p{Cs}/gu, '�')
}

/** The first line of each `goal` in a `tasks` snapshot: `pythonStr` of the list or JSON text, which the snapshot cap may cut mid-goal. */
function taskGoals(tasks: string): string[] {
  return Array.from(tasks.matchAll(TASK_GOAL), (m) => unescapeGoal(m[3] ?? '').trim().split('\n')[0] ?? '').filter(Boolean)
}

/**
 * TAL-1758: a `delegate_task` call's label, in the Agent's own precedence: a control action (it ignores goals), else its
 * `tasks`, else the legacy single `goal`. Empty for neither, which leaves the fallback keys to name the call.
 */
function delegateTarget(arg: (keys: string[]) => string): string {
  const action = arg(['action']).trim().toLowerCase()
  if (action && action !== 'spawn') return [action, arg(['subagent_id']).trim()].filter(Boolean).join(' ')
  return taskGoals(arg(['tasks'])).join(' · ') || arg(['goal'])
}

/**
 * A call's display class and label: the first line of its kind's argument, whitespace-collapsed and capped. TAL-1458:
 * `focus_path` is a read or write call's file inside the session's `workspace` root, the file a companion page shows.
 */
export function toolDisplay(name: unknown, args: unknown, workspace: string | null = null): { kind: ToolKind; target: string; focus_path: string | null; shows_card?: true; verb?: ToolVerb; app?: ToolApp } {
  const bridge = BRIDGES.get(str(name))
  const kind = displayKind(name)
  const a = isDict(args) ? args : {}
  const arg = (keys: string[]) => keys.map((k) => snapshotArg(a, k)).find((v): v is string => typeof v === 'string' && Boolean(v.trim())) ?? ''
  // TAL-2330: an MCP or connector call reads as its app and action; a connector's names the account alias the call picked.
  const focus = (fileKind: ToolKind) => (fileKind === 'read' || fileKind === 'write' ? focusPath(arg(FOCUS_KEYS), workspace) : null)
  const app = appTool(name)
  if (app) {
    const connector = app.kind === 'connector'
    const action = actionPhrase(app.tool, connector ? app.slug : '')
    const alias = connector ? arg(['connector_alias']).trim() : ''
    return { kind, target: capped(alias ? `${action} (${alias})` : action), focus_path: focus(fileKind(name)), app: { name: appTitle(app.slug), logo_url: connector ? connectorLogo(app.slug) : null } }
  }
  const special = name === 'delegate_task' ? delegateTarget(arg) : bridge ? bridge.target(snapshotItems(snapshotArg(a, bridge.key) ?? '')) : ''
  const own = kind === 'talaria' ? arg(TALARIA_TARGET_KEYS[str(name)] ?? []) || str(name) : ''
  const line = (special || own || arg(TARGET_KEYS[kind] ?? FALLBACK_KEYS)).trim().split('\n')[0] ?? ''
  // TAL-2328: browser code's comment line reads as its text.
  const first = kind === 'browser' ? line.replace(/^#+\s*/, '') : line
  // TAL-2327: the verb a `kanban` call shows in place of its kind's own. TAL-2328: a vault or computer call's, by its action.
  const actions = typeof name === 'string' && Object.hasOwn(ACTION_VERBS, name) ? ACTION_VERBS[name]! : undefined
  const action = arg(['action']).trim().toLowerCase()
  const verb = actions ? (Object.hasOwn(actions, action) ? actions[action] : undefined) : agentTool(name)?.verb
  return {
    kind, target: capped(first), focus_path: focus(kind),
    ...(showsCard(name) ? { shows_card: true as const } : {}),
    ...(verb ? { verb } : {}),
  }
}

/** TAL-1305: the registry process (`proc_…`) a result names; a native owner's result is its JSON text (TAL-2266). */
export function resultProcessId(result: unknown): string | null {
  // A result naming no process is not parsed: every shown row passes through here (TAL-2340).
  if (typeof result === 'string') { if (!result.includes('proc_')) return null; try { result = JSON.parse(result) } catch { return null } }
  const id = isDict(result) ? str(result.session_id) : ''
  return id.startsWith('proc_') ? id : null
}

/**
 * TAL-2340: the process a `terminal` call left running in the background (asked for, or a foreground run handed off),
 * which its row names as `process_id`.
 */
export function startedProcessId(name: unknown, result: unknown): string | null {
  return name === 'terminal' ? resultProcessId(result) : null
}

/** The kind a call shows: a lookup bridge's own, else its name's. */
const displayKind = (name: unknown): ToolKind => BRIDGES.get(str(name))?.kind ?? toolKind(name)

/**
 * TAL-2332: what activity grouping reads of a call, from its name alone: the kind it shows, how its result shows (`generic`
 * for a name the table does not list) and whether its card stands alone (`shows_card`).
 */
export function toolGrouping(name: unknown): { kind: ToolKind; presentation: string; card: boolean } {
  return { kind: displayKind(name), presentation: toolPresentation(name) ?? 'generic', card: showsCard(name) }
}

/** TAL-2328: the verb of a tool whose `action` decides what it does; an action not listed reads as its kind's own phrase. */
const ACTION_VERBS: Record<string, Record<string, ToolVerb>> = {
  browser_vault: { list: 'list', fill: 'fill', enter_code: 'fill' },
  computer_use: { capture: 'capture', click: 'click', double_click: 'click', right_click: 'click', middle_click: 'click', type: 'type', set_value: 'type' },
}

/**
 * TAL-2316: the Agent's tool-discovery bridges, labelled as its own `_bridge_labels` does: `tool_describe` reads the
 * named tools' details, `tool_search` searches by its first non-empty query.
 */
const BRIDGES = new Map<string, { kind: ToolKind; key: string; target: (items: string[]) => string }>([
  ['tool_describe', { kind: 'read', key: 'names', target: (names) => names.filter((n) => n.trim()).join(', ') }],
  ['tool_search', { kind: 'search', key: 'queries', target: (queries) => queries.find((q) => q.trim()) ?? '' }],
])

/** TAL-2331: a `tool_search` or `tool_describe` call the transcript leaves out: one that did not fail, while `show_tool_lookups` is off. */
export const hiddenLookup = (name: unknown, isError: boolean): boolean => BRIDGES.has(str(name)) && !isError && !displaySetting('show_tool_lookups')

/** A quoted string in a `pythonStr` list, whose closing quote the snapshot cap may have cut. */
const QUOTED = /(['"])((?:(?!\1)[^\\]|\\.)*)\1?/gs

/** A snapshot argument's items: each string of a `pythonStr` list (which the cap may cut short), else the one value. */
function snapshotItems(value: string): string[] {
  return value.startsWith('[') ? Array.from(value.matchAll(QUOTED), (m) => unescapeGoal(m[2] ?? '')) : [value]
}

/**
 * TAL-1968: calls whose transcript card the user must see, as a settled turn keeps them open (`buildTurnScene`). TAL-2027: an
 * answered question's rows stay in view the same way.
 */
const CARD_TOOLS = new Set(['show', 'deliver', 'propose', 'draft_card', 'terminal_open', 'clarify'])
/** TAL-2325: the media tools, whose media stands alone like a card while `inline_tool_media` is on (TAL-2341). */
const MEDIA_TOOLS = new Set(Object.entries(TOOL_PRESENTATIONS).flatMap(([name, entry]) => (entry.presentation === 'media' ? [name] : [])))
const showsCard = (name: unknown): boolean => typeof name === 'string' && (CARD_TOOLS.has(name) || (MEDIA_TOOLS.has(name) && displaySetting('inline_tool_media')))

const FOCUS_KEYS = ['path', 'file_path', 'file', 'target']

/**
 * A path argument as a workspace-relative file, without a leading `./`; null for a drive or URL path, one that climbs out
 * with `..`, a multi-line value, or one the snapshot capped (it ends in `...` and names no real file).
 */
function focusPath(raw: string, workspace: string | null): string | null {
  const path = workspaceRelative(raw.trim(), workspace)?.replace(/^(?:\.[\\/])+/, '')
  if (!path || path.includes('\n') || path.endsWith('...') || /^(?:[\\/~]|[A-Za-z]:|[A-Za-z][\w+.-]*:\/\/)/.test(path)) return null
  return path.split(/[\\/]/).includes('..') ? null : path
}

/**
 * TAL-1537: an absolute or `~/` path as its remainder under the workspace root, lexically (no symlinks resolved); null for
 * the root itself, a path outside it, or no workspace. Any other path passes through for `focusPath`'s own rules.
 */
function workspaceRelative(path: string, workspace: string | null): string | null {
  if (!path.startsWith('/') && !path.startsWith('~/')) return path
  if (!workspace) return null
  const root = posix.normalize(workspace).replace(/\/+$/, '')
  const full = posix.normalize(expandHome(path))
  return full.startsWith(`${root}/`) ? full.slice(root.length + 1) : null
}

/**
 * A persisted call's arguments: live `args`, a `tool_use` block's `input`, or OpenAI `function.arguments` JSON. TAL-2316:
 * a bridged call's are its one entry's `arguments`, as the Agent ran it and the live frame carried them.
 */
export function toolArgs(call: Record<string, unknown>): unknown {
  return bridgedCall(call)?.arguments ?? rawToolArgs(call)
}

function rawToolArgs(call: Record<string, unknown>): unknown {
  if (call.args !== undefined) return call.args
  if (call.input !== undefined) return call.input
  return parsedJson(isDict(call.function) ? call.function.arguments : undefined)
}

/** A JSON-string value parsed, else the value as is; null when absent. */
function parsedJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? null
  try { return JSON.parse(raw) as unknown } catch { return raw }
}

/** A live frame's or persisted call's tool name, in any of the shapes the transcript carries; a bridged call's own name (TAL-2316). */
export function toolName(call: Record<string, unknown>): string {
  return bridgedCall(call)?.name ?? rawToolName(call)
}

/** The name a call carries itself: a bridge's is `tool_call`. */
export function rawToolName(call: Record<string, unknown>): string {
  return str(call.name) || str(call.tool_name) || (isDict(call.function) ? str(call.function.name) : '')
}

/**
 * TAL-2316: the one call a single-entry `tool_call` bridge carries. The Agent defers toolsets behind `tool_call {calls}`
 * and stores one entry per invocation, but runs (and streams) that entry's tool by its own name and arguments. A bridge
 * with no entry or several (a connector batch) stays itself.
 */
function bridgedCall(call: Record<string, unknown>): { name: string; arguments: unknown } | undefined {
  if (rawToolName(call) !== 'tool_call') return undefined
  const args = rawToolArgs(call)
  const calls = isDict(args) ? args.calls : undefined
  const entry = Array.isArray(calls) && calls.length === 1 && isDict(calls[0]) ? calls[0] : undefined
  const name = entry ? str(entry.name) : ''
  return entry && name ? { name, arguments: parsedJson(entry.arguments) ?? {} } : undefined
}

/** TAL-448: the most diff lines (and characters) an `edit_diff` carries; its counts always cover the whole diff. */
export const EDIT_DIFF_MAX_LINES = 400
const EDIT_DIFF_MAX_CHARS = 64_000

/**
 * TAL-448: a file-edit call's change, from its completed result's unified `diff` (the Agent's `patch` result): added and
 * removed lines counted over the whole diff's hunks, and the diff itself capped and parsed into `hunks`. TAL-909: else the
 * `diff` in the result row's `display_metadata`, which the sidecar computes from the Agent's before-snapshot of a
 * `write_file`, `patch` or `skill_manage` edit. Undefined for any other call, or with neither. Callers redact the returned
 * `diff` with the rest of the call, which parses its `hunks` again from the redacted diff (`redactValue`).
 */
export function toolEditDiff(name: unknown, result: unknown, displayMetadata?: unknown): ToolEditDiff | undefined {
  const diff = resultDiff(name, result) ?? (isDict(displayMetadata) ? displayMetadata.diff : undefined)
  if (typeof diff !== 'string' || !diff.trim()) return undefined
  const [added, removed] = hunkTotals(diffHunks(diff))
  const lines = diff.replace(/\n$/, '').split('\n')
  // Whole lines only, so redaction never sees a credential cut short.
  const shown: string[] = []
  let size = 0
  for (const line of lines.slice(0, EDIT_DIFF_MAX_LINES)) {
    size += line.length + 1
    if (size > EDIT_DIFF_MAX_CHARS) break
    shown.push(line)
  }
  return withHunks({ added, removed, diff: shown.join('\n'), truncated: shown.length < lines.length })
}

/** A file-edit result's own unified `diff`: a listed tool's when it presents a diff, an unlisted one's when its name reads `write`. */
function resultDiff(name: unknown, result: unknown): unknown {
  const presentation = toolPresentation(name)
  if (presentation ? presentation !== 'diff' : fileKind(name) !== 'write') return undefined
  let data: unknown = Array.isArray(result) ? messageText(result) : result
  if (typeof data === 'string') { try { data = JSON.parse(data) } catch { return undefined } }
  const diff = isDict(data) ? data.diff : undefined
  return typeof diff === 'string' && diff.trim() ? diff : undefined
}

/** A decided `edit_diff` (one a live call or a built scene row already carries), kept only when well-formed. */
export function decidedEditDiff(value: unknown): ToolEditDiff | undefined {
  if (!isDict(value)) return undefined
  const { added, removed, diff, truncated } = value
  return Number.isSafeInteger(added) && Number.isSafeInteger(removed) && typeof diff === 'string' && typeof truncated === 'boolean' ? withHunks({ added: added as number, removed: removed as number, diff, truncated }) : undefined
}

/** TAL-604: an `edit_diff` with its shown `diff` parsed, so clients never parse it. */
function withHunks(edit: Omit<ToolEditDiff, 'hunks'>): ToolEditDiff {
  return { ...edit, hunks: diffHunks(edit.diff) }
}

const safeInt = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined)

/** TAL-2323: a `read_file` line's gutter (`12|`), as the Agent's `_add_line_numbers` writes it. */
const GUTTER_RE = /^(\d{1,9})\|/

/** TAL-2323: `read_file` content as numbered lines, gutters dropped; a line without one continues the line before it. */
export function gutterLines(content: string): FileExcerptLine[] {
  const lines: FileExcerptLine[] = []
  for (const line of content.split('\n')) {
    const gutter = GUTTER_RE.exec(line)
    if (gutter) lines.push({ n: Number(gutter[1]), text: line.slice(gutter[0].length) })
    else if (lines.length) lines[lines.length - 1]!.text += `\n${line}`
  }
  return lines
}

/** TAL-2323: numbered lines back in the Agent's gutter format, so redaction reads them as the one text they came from. */
export const gutterText = (lines: readonly FileExcerptLine[]): string => lines.map((line) => `${String(line.n)}|${line.text}`).join('\n')

/**
 * TAL-2323: a `read_file` result (Agent `ReadResult.to_dict`): its content as a `file_excerpt` of the file the call's `path`
 * names; a repeat read's stub, a special file's note and a not-found error (with the similar files it names) as one line.
 * Undefined for any other result (another error, a binary file), which the generic rule shows.
 */
export function readFileView(data: Record<string, unknown>, args: unknown): { file_excerpt?: FileExcerpt; text?: string; error?: string } | undefined {
  if (data.status === 'unchanged' && data.dedup === true) return { text: 'Unchanged since the last read' }
  if (data.success === false && typeof data.note === 'string' && data.note.trim()) return { text: data.note.trim() }
  if (data.not_found === true && typeof data.error === 'string') {
    const similar = Array.isArray(data.similar_files) ? data.similar_files.filter((path): path is string => typeof path === 'string').slice(0, 5) : []
    return { error: similar.length ? `${data.error}\nSimilar files: ${similar.join(', ')}` : data.error }
  }
  // Content without the Agent's gutter (another tool's shape) keeps the generic text.
  if (typeof data.content !== 'string' || data.error || (data.content && !GUTTER_RE.test(data.content))) return undefined
  const lines = gutterLines(data.content)
  const truncated = data.truncated === true
  const next = safeInt(data.next_offset) ?? (truncated && lines.length ? lines[lines.length - 1]!.n + 1 : undefined)
  const path = isDict(args) ? str(args.path) : ''
  return { file_excerpt: {
    path, language: data.extracted_document === true ? null : posix.extname(path).slice(1).toLowerCase() || null, start_line: lines[0]?.n ?? 1, lines, total_lines: safeInt(data.total_lines) ?? null, truncated,
    ...(next !== undefined ? { next_offset: next } : {}),
  } }
}

/** TAL-2323: a `matches_text` row under its file's path line: `  12: text`. */
const MATCH_ROW_RE = /^ {2}(\d{1,9}): ?(.*)$/

/**
 * TAL-2323: a `search_files` result (Agent `SearchResult.to_dict(densify=True)`) grouped by file in the Agent's order: a
 * `matches` list, a path-grouped `matches_text` block, a files-only `files` list, or a count search's `counts`. Undefined for
 * an error or any other shape, which the generic rule shows.
 */
export function searchFilesView(data: Record<string, unknown>): SearchMatches | undefined {
  const total = safeInt(data.total_count)
  if (total === undefined || data.error) return undefined
  const files: SearchMatchFile[] = []
  const file = (path: string): SearchMatchFile => {
    const last = files[files.length - 1]
    if (last?.path === path) return last
    const next: SearchMatchFile = { path, matches: [] }
    files.push(next)
    return next
  }
  for (const match of Array.isArray(data.matches) ? data.matches : []) {
    if (isDict(match) && typeof match.path === 'string') file(match.path).matches.push({ line: safeInt(match.line) ?? 0, text: str(match.content) })
  }
  if (typeof data.matches_text === 'string') {
    for (const line of data.matches_text.split('\n')) {
      const row = MATCH_ROW_RE.exec(line)
      if (row && files.length) files[files.length - 1]!.matches.push({ line: Number(row[1]), text: row[2]! })
      else if (line.trim() && !row) file(line)
    }
  }
  for (const path of Array.isArray(data.files) ? data.files : []) if (typeof path === 'string') file(path)
  if (isDict(data.counts)) for (const [path, count] of Object.entries(data.counts)) if (safeInt(count) !== undefined) file(path).count = count as number
  return { total, truncated: data.truncated === true, files }
}

/** TAL-2325: image data a model was given, which never ships to a client. */
export const DATA_URL_RE = /data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g

/**
 * TAL-2325: what `vision_analyze` or `video_analyze` said, as Markdown: its `analysis` (on failure the Agent's explanation),
 * else a multimodal result's `text_summary`, without any `data:` URL. Undefined when it said nothing.
 */
export function resultAnalysisView(data: Record<string, unknown>): string | undefined {
  const text = typeof data.analysis === 'string' ? data.analysis : typeof data.text_summary === 'string' ? data.text_summary : ''
  return text.replace(DATA_URL_RE, '').trim() || undefined
}

/** TAL-2324: an http(s) URL as written, the only kind a link row opens; undefined for any other scheme or text. */
function webUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

/** TAL-2324: a URL's host without a leading `www.`, the domain a link or page row shows. */
const urlDomain = (url: URL): string => url.hostname.replace(/^www\./, '')

const resultLink = (title: string, url: URL, snippet = ''): ResultLink => ({ title: title.trim() || url.href, url: url.href, domain: urlDomain(url), ...(snippet.trim() ? { snippet: snippet.trim() } : {}) })

/**
 * TAL-2324: a `web_search` result's `data.web` rows in order (any extra keys a backend adds ignored), or an `x_search`
 * result's answer above the links it cited: its titled inline citations, then the bare `citations` they did not name, each
 * URL once. Only http(s) URLs become links. Undefined for an error or any other shape, which the generic rule shows.
 */
export function resultLinksView(data: Record<string, unknown>): ResultLinks | undefined {
  if (data.success === false || data.error) return undefined
  if (isDict(data.data) && Array.isArray(data.data.web)) {
    return { items: data.data.web.flatMap((row) => {
      const url = isDict(row) ? webUrl(row.url) : undefined
      return url && isDict(row) ? [resultLink(str(row.title), url, str(row.description))] : []
    }) }
  }
  if (typeof data.answer !== 'string') return undefined
  const cited = new Map<string, ResultLink>()
  const cite = (title: string, value: unknown) => {
    const url = webUrl(value)
    if (url && !cited.has(url.href)) cited.set(url.href, resultLink(title, url))
  }
  for (const inline of Array.isArray(data.inline_citations) ? data.inline_citations : []) if (isDict(inline)) cite(str(inline.title), inline.url)
  for (const url of Array.isArray(data.citations) ? data.citations : []) cite('', url)
  return { ...(data.answer.trim() ? { answer: data.answer.trim() } : {}), items: [...cited.values()] }
}

/** TAL-2324: how much of a page's Markdown a `web_extract` row shows; the whole page stays behind "Show full output". */
export const PAGE_EXCERPT_CHARS = 600
/** TAL-2324: where the Agent's cut of a long page begins (`web_tools_truncate._truncate_with_footer`): its middle marker, else its footer. */
const PAGE_CUT_RE = /\n\n\[\.\.\. middle omitted|\n─+ \[TRUNCATED\] ─+/

/**
 * TAL-2324: a page's Markdown up to the Agent's cut, at most `PAGE_EXCERPT_CHARS` characters ending at a word where one is
 * near. An excerpt is its own excerpt, so a stored view capped again keeps it.
 */
export function pageExcerpt(content: string): string {
  const page = content.split(PAGE_CUT_RE)[0]!.trim()
  if (page.length <= PAGE_EXCERPT_CHARS) return page
  const head = page.slice(0, PAGE_EXCERPT_CHARS - 1)
  const word = head.search(/\s\S*$/)
  return `${(word > PAGE_EXCERPT_CHARS * 0.8 ? head.slice(0, word) : head).trimEnd()}…`
}

/**
 * TAL-2324: a `web_extract` result's `results`, one page each with its whole Markdown as `excerpt` (the display cap cuts it
 * to `pageExcerpt`; the whole-result read keeps it), or the error that page failed with (a policy block carries its message
 * there too). Undefined for a whole-call error or any other shape, which the generic rule shows.
 */
export function resultPagesView(data: Record<string, unknown>): ResultPage[] | undefined {
  if (!Array.isArray(data.results) || data.error) return undefined
  return data.results.flatMap((row): ResultPage[] => {
    if (!isDict(row)) return []
    const url = webUrl(row.url)
    const error = typeof row.error === 'string' && row.error.trim() ? row.error.trim() : undefined
    // A URL the Agent refused as invalid still names its row, as text.
    return [{ url: url?.href ?? '', domain: url ? urlDomain(url) : '', title: str(row.title).trim() || str(row.url).trim(), excerpt: error ? '' : str(row.content), ...(error ? { error } : {}) }]
  })
}

/**
 * TAL-2323: a result view's `file_excerpt` and `matches` files with the `focus_path` each path names inside the session's
 * `workspace` (the call-level TAL-1458 rule). Callers pass the redacted view, so a focus path never shows more than its path.
 * Without a workspace an absolute path keeps the focus path it was given. TAL-2325: with the session's id, each local `media`
 * URL carries it, so the session's media grant serves a file the allowed roots do not. TAL-2199: a remote image loads
 * through the server's relay, stored views included, or is a link when the server would not fetch it.
 */
export function withResultFocusPaths<T extends Record<string, unknown>>(view: T, workspace: string | null, sessionId: string | null = null): T {
  const located = <F extends { path: string; focus_path?: string | undefined }>(item: F): F => {
    const { focus_path: given, ...rest } = item
    const focus = focusPath(item.path, workspace) ?? (workspace ? null : given)
    return (focus ? { ...rest, focus_path: focus } : rest) as F
  }
  const excerpt = view.file_excerpt === undefined ? undefined : FileExcerptSchema.safeParse(view.file_excerpt).data
  const matches = view.matches === undefined ? undefined : SearchMatchesSchema.safeParse(view.matches).data
  const media = view.media === undefined ? undefined : DisplayMediaSchema.array().safeParse(view.media).data
  return { ...view, ...(excerpt ? { file_excerpt: located(excerpt) } : {}), ...(matches ? { matches: { ...matches, files: matches.files.map(located) } } : {}), ...(media ? { media: media.map((item) => shippedMedia(item, sessionId)) } : {}) }
}

const MEDIA_URL = './api/media?'
/** TAL-2325: a local media URL with the session's id, when there is one; TAL-2199: a remote image through the relay, else a link. */
function shippedMedia(item: DisplayMedia, sessionId: string | null): DisplayMedia {
  if (item.kind === 'image' && isRemoteImageSource(item.url)) {
    const relayed = vouchRemoteImage(item.url)
    return relayed ? { ...item, url: relayed } : { ...item, kind: 'file' }
  }
  if (!sessionId || !item.url.startsWith(MEDIA_URL)) return item
  const query = new URLSearchParams(item.url.slice(MEDIA_URL.length))
  query.set('session_id', sessionId)
  return { ...item, url: `${MEDIA_URL}${query.toString()}` }
}

/** MCP progress is untrusted; only finite percentages and a bounded message reach clients. */
export function toolProgress(data: Record<string, unknown>): ToolProgress {
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  const percent = finite(data.percent) ? data.percent : finite(data.progress) && finite(data.total) && data.total > 0 ? (data.progress / data.total) * 100 : null
  return { percent: percent === null ? null : Math.round(Math.max(0, Math.min(100, percent))), message: typeof data.message === 'string' ? data.message.trim().slice(0, 1000) || null : null }
}

/**
 * TAL-2326: the rows a `rows`- or `clarify`-presented tool's successful object result shows: memory changes, skills, past
 * chats, scheduled jobs, connected apps or answered questions. The call's `args` name what a memory or skill write changed,
 * which its result does not repeat. A connect URL never ships: a connection row opens the app's connections page.
 * Undefined for a shape the tool does not return, which the generic rule shows.
 */
export function toolRowsView(name: unknown, data: Record<string, unknown>, args: unknown): ToolRows | undefined {
  const a = isDict(args) ? args : {}
  switch (name) {
    case 'memory': return memoryRows(data, a)
    case 'skills_list': return Array.isArray(data.skills) ? { title: 'Skills', rows: dicts(data.skills).map((skill) => row(str(skill.name), str(skill.description), undefined, skillLink(skill.name))) } : undefined
    case 'skill_view': return skillViewRows(data, a)
    case 'skill_manage': return skillManageRows(data, a)
    case 'session_search': return sessionSearchRows(data)
    case 'cronjob_manage': return cronRows(data, a)
    case 'manage_connections': return connectionRows(data)
    case 'clarify': return clarifyRows(data)
    case 'browser_cdp': return str(data.method) || str(a.method) ? { rows: [row(str(data.method) || str(a.method), '', 'ok')] } : undefined
    case 'browser_dialog': return dialogRows(data, a)
    case 'browser_vault': return vaultRows(data, a)
    case 'computer_use': return computerRows(data, a)
    default: return agentTool(name)?.kind === 'kanban' ? kanbanRows(str(name), data, a) : undefined
  }
}

const dicts = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isDict) : [])
/** A row with its optional parts only when present, its text trimmed. */
function row(label: string, detail = '', status?: ToolRow['status'], link?: ToolRow['link']): ToolRow {
  return { label: label.trim(), ...(detail.trim() ? { detail: detail.trim() } : {}), ...(status ? { status } : {}), ...(link ? { link } : {}) }
}
const skillLink = (name: unknown): ToolRow['link'] => (str(name).trim() ? { kind: 'skill', id: str(name).trim() } : undefined)
const firstLine = (text: unknown): string => str(text).trim().split('\n')[0]!.trim()
const joined = (...parts: string[]): string => parts.map((part) => part.trim()).filter(Boolean).join(' · ')
const PENDING = 'Waiting for approval'

/** One memory operation's row: what it added, the entry it updated (its old text the detail) or the entry it removed. */
function memoryOpRow(op: Record<string, unknown>, n: number, data: Record<string, unknown>, single: boolean, status?: ToolRow['status']): ToolRow | undefined {
  // A batch result keys an operation's entries by its 1-based index; a one-operation write may name them once.
  const entry = (batch: string, one: string): string => {
    const byIndex = data[batch]
    return (isDict(byIndex) ? str(byIndex[String(n)]) : '') || (single ? str(data[one]) : '')
  }
  const action = str(op.action)
  if (action === 'add') return row(`Added: ${str(op.content)}`, '', status)
  if (action === 'patch' || action === 'replace') {
    const after = entry('patched_entries_after', 'patched_entry_after') || str(op.content) || str(op.new_text)
    const before = entry('patched_entries', 'patched_entry_before') || entry('replaced_entries', 'replaced_entry') || str(op.old_text)
    return row(`Updated: ${after}`, before ? `Was: ${before}` : '', status)
  }
  if (action === 'remove') return row(`Removed: ${entry('removed_entries', 'removed_entry') || str(op.old_text)}`, '', status)
  return undefined
}

/** A memory write's changes under its store and how full it is; a staged write waits for approval first. */
function memoryRows(data: Record<string, unknown>, a: Record<string, unknown>): ToolRows {
  const ops = Array.isArray(a.operations) ? dicts(a.operations) : [a]
  const staged = data.staged === true
  const rows = ops.flatMap((op, i) => memoryOpRow(op, i + 1, data, ops.length === 1, staged ? 'pending' : undefined) ?? [])
  const title = joined((str(data.target) || str(a.target)) === 'user' ? 'User profile' : 'Memory', str(data.usage))
  return { title, rows: staged ? [row(PENDING, str(data.message), 'pending'), ...rows] : rows }
}

/** A viewed skill: its description and any setup it still needs over its formatted text. */
function skillViewRows(data: Record<string, unknown>, a: Record<string, unknown>): ToolRows | undefined {
  const name = str(data.name) || str(a.name)
  if (data.status === 'unchanged') return { title: name, rows: [row('Already loaded in this chat', '', 'ok', skillLink(name))] }
  if (typeof data.content !== 'string') return undefined
  const setup = data.setup_needed === true ? [row('Setup needed', str(data.setup_note), 'warn')] : []
  return { title: name, rows: [row(str(data.description) || name, '', undefined, skillLink(name)), ...setup], markdown: data.content }
}

const SKILL_ACTIONS: Record<string, string> = { create: 'Created', edit: 'Edited', patch: 'Patched', delete: 'Deleted', write_file: 'Wrote', remove_file: 'Removed' }
/** One skill write: what it did to which skill and file, then each lint finding it raised. */
function skillWriteRows(action: string, name: string, file: string, lint: unknown, status?: ToolRow['status']): ToolRow[] {
  return [row(`${SKILL_ACTIONS[action] ?? action} ${name}`, file, status, action === 'delete' ? undefined : skillLink(name)), ...dicts(lint).map((f) => row(str(f.message), str(f.rule), 'warn'))]
}

/** A skill write: each operation a batch applied, a single write's own, or the writes waiting for approval. */
function skillManageRows(data: Record<string, unknown>, a: Record<string, unknown>): ToolRows | undefined {
  const ops = Array.isArray(a.operations) ? dicts(a.operations) : [a]
  const opRows = (status?: ToolRow['status']) => ops.flatMap((op) => skillWriteRows(str(op.action), str(op.name) || str(a.name), str(op.file_path), undefined, status))
  if (data.staged === true) return { rows: [row(PENDING, str(data.gist) || str(data.message), 'pending'), ...opRows('pending')] }
  if (Array.isArray(data.results)) return { rows: dicts(data.results).flatMap((r) => skillWriteRows(str(r.action), str(r.name), str(r.file_path), r.lint_warnings)) }
  if (data.success !== true) return undefined
  return { rows: skillWriteRows(str(a.action), str(a.name), str(a.file_path) || str(data.path), data.lint_warnings) }
}

const sessionLink = (id: unknown): ToolRow['link'] => (str(id).trim() ? { kind: 'session', id: str(id).trim() } : undefined)
const UNTITLED = 'Untitled chat'
/** A past-chat search: each chat it found or listed, or the messages it read from one, each opening that chat. */
function sessionSearchRows(data: Record<string, unknown>): ToolRows | undefined {
  const results = dicts(data.results)
  if (data.mode === 'discover') return { ...(str(data.query).trim() ? { title: str(data.query).trim() } : {}), rows: results.map((r) => row(str(r.title) || UNTITLED, joined(str(r.when), firstLine(r.snippet)), undefined, sessionLink(r.session_id))) }
  if (data.mode === 'browse') return { title: 'Recent chats', rows: results.map((r) => row(str(r.title) || UNTITLED, firstLine(r.preview), undefined, sessionLink(r.session_id))) }
  if (data.mode !== 'read' && data.mode !== 'scroll') return undefined
  const meta = isDict(data.session_meta) ? data.session_meta : {}
  const link = sessionLink(data.session_id)
  return { title: joined(str(meta.title) || UNTITLED, str(meta.when)), rows: dicts(data.messages).map((m) => row(firstLine(m.content) || '…', str(m.role), undefined, link)) }
}

const CRON_TITLES: Record<string, string> = { create: 'Created', list: 'Scheduled jobs', update: 'Updated', pause: 'Paused', resume: 'Resumed', remove: 'Removed', run: 'Started', cancel: 'Cancelled' }
/** A scheduled job's row: its name, schedule, next run and last outcome, opening it on the scheduled jobs page. */
function cronRow(job: Record<string, unknown>, exists = true): ToolRow {
  const last = str(job.last_status).toLowerCase()
  const next = str(job.next_run_at).trim()
  const detail = joined(str(job.schedule), job.enabled === false || job.state === 'paused' ? 'paused' : '', next ? `next ${next.slice(0, 16).replace('T', ' ')}` : '', last ? `last ${last}` : '')
  const status = last === 'ok' || last === 'success' ? 'ok' : last === 'error' || last === 'failed' ? 'error' : undefined
  const id = str(job.job_id) || str(job.id)
  return row(str(job.name) || id || 'Scheduled job', detail, status, { kind: 'crons', ...(exists && id ? { id } : {}) })
}
/** A scheduled-job action: the jobs it listed or the one it acted on, under what it did. */
function cronRows(data: Record<string, unknown>, a: Record<string, unknown>): ToolRows | undefined {
  const title = CRON_TITLES[str(a.action)] ?? 'Scheduled jobs'
  if (Array.isArray(data.jobs)) return { title, rows: dicts(data.jobs).map((job) => cronRow(job)) }
  if (isDict(data.removed_job)) return { title: CRON_TITLES.remove!, rows: [cronRow(data.removed_job, false)] }
  return isDict(data.job) ? { title, rows: [cronRow(data.job)] } : undefined
}

const TARGET_STATUS: Record<string, ToolRow['status']> = { connected: 'ok', initiated: 'pending', pending: 'pending', failed: 'error', expired: 'error' }
const CONNECTORS: ToolRow['link'] = { kind: 'connectors' }
/** Connected apps: each app's accounts or connection state, or the account a rename named; never a connect URL. */
function connectionRows(data: Record<string, unknown>): ToolRows | undefined {
  if (Array.isArray(data.connectors)) {
    return { rows: dicts(data.connectors).map((c) => {
      const accounts = dicts(c.accounts).map((account) => str(account.alias) || str(account.label)).filter(Boolean)
      return row(str(c.connector), c.connected === true ? accounts.join(', ') || 'Connected' : 'Not connected', c.connected === true ? 'ok' : undefined, CONNECTORS)
    }) }
  }
  if (Array.isArray(data.targets)) return { rows: dicts(data.targets).map((t) => row(str(t.name), joined(str(t.alias), str(t.state).replace(/_/g, ' '), str(t.error)), TARGET_STATUS[str(t.state)], CONNECTORS)) }
  if (isDict(data.renamed)) return { rows: [row(str(data.renamed.connector), `Renamed to ${str(data.renamed.alias) || str(data.renamed.label)}`, 'ok', CONNECTORS)] }
  return undefined
}

/** The Agent's legacy one-question reply when the user never answered (its `TIMEOUT_RESPONSE`). */
const CLARIFY_TIMEOUT_RESPONSE = 'The user did not provide a response within the time limit. Use your best judgement to make the choice and proceed.'

/**
 * TAL-2027: a clarify result's questions in order, each with its answer (`null` unless the user gave a non-blank one) or that
 * they skipped it, and the note on how the wait ended: the batch `{responses, outcome | timed_out, notice}` or the legacy
 * `{question, user_response}`, whose timeout sentinel reads as no answer. Undefined for any other shape.
 */
function clarifyExchanges(data: Record<string, unknown>): { exchanges: { question: string; answer: string | null; skipped: boolean }[]; note: string } | undefined {
  const legacy = !Array.isArray(data.responses) && typeof data.question === 'string'
  if (!legacy && !Array.isArray(data.responses)) return undefined
  let timedOut = data.outcome === 'timed_out' || data.timed_out === true
  const exchanges = (legacy ? [data] : dicts(data.responses)).map((r) => {
    const raw = r.user_response
    const sentinel = legacy && raw === CLARIFY_TIMEOUT_RESPONSE
    if (sentinel) timedOut = true
    const text = sentinel ? '' : Array.isArray(raw) ? raw.map(str).filter((item) => item.trim()).join(', ') : str(raw)
    return { question: str(r.question), answer: (r.status ?? 'answered') === 'answered' && text.trim() ? text : null, skipped: r.status === 'skipped' }
  })
  return { exchanges, note: str(data.notice).trim() || (timedOut ? 'Timed out waiting for an answer.' : '') }
}

/** Each clarify question with its answer, or that the user skipped it or never answered, under the note on how the wait ended. */
function clarifyRows(data: Record<string, unknown>): ToolRows | undefined {
  const parsed = clarifyExchanges(data)
  if (!parsed) return undefined
  return { rows: parsed.exchanges.map((e) => row(e.question, e.answer ?? (e.skipped ? 'Skipped' : 'No answer'))), ...(parsed.note ? { title: parsed.note } : {}) }
}

/** TAL-2327: a Kanban task's row: its title, else its id, and a muted detail, opening the task on the call's board. */
function taskRow(id: unknown, title: unknown, detail: string, board: string): ToolRow {
  const taskId = str(id).trim()
  return row(str(title).trim() || taskId, detail, undefined, taskId ? { kind: 'kanban_task', id: taskId, ...(board ? { board } : {}) } : undefined)
}

/**
 * TAL-2327: the task or tasks a `kanban_*` call touched, each opening that task: a shown task or each listed one with its
 * status and assignee, a new task by the title the call gave, a linked parent and child, a task's files, or the task a state
 * change, comment or attachment acted on, with where it landed. Undefined for a shape the tool does not return.
 */
function kanbanRows(name: string, data: Record<string, unknown>, a: Record<string, unknown>): ToolRows | undefined {
  const board = str(a.board).trim()
  const id = str(data.task_id) || str(a.task_id)
  const summary = (task: Record<string, unknown>) => taskRow(task.id, task.title, joined(str(task.status), str(task.assignee)), board)
  if (name === 'kanban_show') return isDict(data.task) ? { rows: [summary(data.task)] } : undefined
  if (name === 'kanban_list') return Array.isArray(data.tasks) ? { rows: dicts(data.tasks).map(summary) } : undefined
  if (name === 'kanban_link') {
    if (!str(data.parent_id) || !str(data.child_id)) return undefined
    return { rows: [taskRow(data.parent_id, '', 'Parent', board), taskRow(data.child_id, '', joined('Child', data.gated === true ? 'waiting on parent' : ''), board)] }
  }
  if (!id || data.ok !== true) return undefined
  if (name === 'kanban_attachments') return { rows: [taskRow(id, '', '', board), ...dicts(data.attachments).map((file) => row(str(file.filename), str(file.content_type)))] }
  const detail = name === 'kanban_comment' ? firstLine(a.body)
    : name === 'kanban_attach' || name === 'kanban_attach_url' ? str(a.filename) || str(a.url)
    : joined(str(data.status), str(data.block_kind).replace(/_/g, ' '), data.gated === true ? 'waiting on parent' : '')
  return { rows: [taskRow(id, name === 'kanban_create' ? a.title : '', detail, board)] }
}

/**
 * TAL-2328: the code a `browser_exec` call ran (its `code` argument, which the caller passes redacted like the rest of the
 * call) as a pathless excerpt numbered from 1. The Agent runs it as Python. Undefined for a call without code.
 */
export function codeExcerpt(args: unknown): FileExcerpt | undefined {
  const code = isDict(args) ? str(args.code).replace(/\n+$/, '') : ''
  if (!code.trim()) return undefined
  const lines = code.split('\n').map((text, i) => ({ n: i + 1, text }))
  return { path: '', language: 'python', start_line: 1, lines, total_lines: lines.length, truncated: false }
}

const HUMAN_CONTROL: Record<string, string> = { browser_vault: 'You have control of the browser', computer_use: 'You have control of the computer' }
/** TAL-2328: a vault or computer call the Agent refused because the user has taken control, as one warning row. */
export function humanControlRows(name: unknown, data: Record<string, unknown>): ToolRows | undefined {
  const label = typeof name === 'string' && Object.hasOwn(HUMAN_CONTROL, name) ? HUMAN_CONTROL[name]! : ''
  return label && (data.code === 'human_has_control' || data.error_type === 'human_has_control') ? { rows: [row(label, '', 'warn')] } : undefined
}

/** TAL-2328: an answered dialog: its message (else its type), its type and what the agent did. */
function dialogRows(data: Record<string, unknown>, a: Record<string, unknown>): ToolRows | undefined {
  if (!isDict(data.dialog)) return undefined
  const action = str(data.action) || str(a.action)
  const answer = action === 'accept' ? 'Accepted' : action === 'dismiss' ? 'Dismissed' : action
  return { rows: [row(firstLine(data.dialog.message) || str(data.dialog.type) || 'Dialog', joined(str(data.dialog.type), answer), 'ok')] }
}

/** TAL-2328: a fill's row: how many fields it filled on which site. */
function filledRow(fill: Record<string, unknown>): ToolRow {
  const n = typeof fill.filled_fields === 'number' ? fill.filled_fields : 0
  const origin = str(fill.origin).trim()
  return row(`Filled ${String(n)} ${n === 1 ? 'field' : 'fields'}${origin ? ` on ${origin}` : ''}`, '', n > 0 ? 'ok' : 'warn')
}

/**
 * TAL-2328: a `browser_vault` action: the saved logins a list found (label, site and whether one can fill) and the managers
 * still locked, the fields a fill or code entry filled, a saved login with its fill, or an unlocked manager. The Agent never
 * returns a secret; a login's identifier stays out of its rows too.
 */
function vaultRows(data: Record<string, unknown>, a: Record<string, unknown>): ToolRows | undefined {
  if (Array.isArray(data.items)) {
    return { title: 'Saved logins', rows: [
      ...dicts(data.items).map((item) => row(str(item.label) || str(item.origin) || 'Login', joined(str(item.origin), str(item.kind) === 'login' ? '' : str(item.kind), item.available === false ? 'Unavailable' : ''), item.available === false ? 'warn' : 'ok')),
      ...dicts(data.locked).map((locked) => row(str(locked.display_name) || str(locked.backend), 'Locked', 'warn')),
    ] }
  }
  if (str(a.action) === 'save_login' && str(data.origin)) return { rows: [row(`Saved a login for ${str(data.origin)}`, '', 'ok'), ...(isDict(data.fill) && typeof data.fill.filled_fields === 'number' ? [filledRow(data.fill)] : [])] }
  if (typeof data.filled_fields === 'number') return { rows: [filledRow(data)] }
  if (str(a.action) === 'unlock' && str(data.backend)) return { rows: [row(`Unlocked ${str(data.backend)}`, data.already_unlocked === true ? 'Already unlocked' : '', 'ok')] }
  return undefined
}

const COMPUTER_ACTIONS: Record<string, string> = {
  click: 'Clicked', double_click: 'Double-clicked', right_click: 'Right-clicked', middle_click: 'Middle-clicked', drag: 'Dragged', scroll: 'Scrolled',
  type: 'Typed', key: 'Pressed keys', set_value: 'Set a value', wait: 'Waited', focus_app: 'Focused',
}
const VERDICTS: Record<string, string> = { verify_fresh_state: 'Not confirmed yet', escalate: 'Needs another approach' }
/** TAL-2328: an input action's row: what it did, its message and the driver's verdict; never the text it typed. */
function computerActionRow(data: Record<string, unknown>): ToolRow {
  const action = str(data.action)
  const decision = isDict(data.verdict) ? str(data.verdict.decision) : ''
  const verdict = Object.hasOwn(VERDICTS, decision) ? VERDICTS[decision]! : ''
  return row((Object.hasOwn(COMPUTER_ACTIONS, action) ? COMPUTER_ACTIONS[action] : undefined) ?? action, joined(firstLine(data.message), verdict), data.ok === false ? 'error' : verdict ? 'warn' : 'ok')
}

/** TAL-2328: a capture's row: the app (else the screen) and its window and element count. */
const captureRow = (app: string, window: string, elements: number | undefined): ToolRow => row(app || 'Screen', joined(window, elements === undefined ? '' : `${String(elements)} ${elements === 1 ? 'element' : 'elements'}`))

/**
 * TAL-2328: a `computer_use` action: an input action's outcome under the app it targeted, a capture's app, window and element
 * count (an action that captured after shows both), or each listed app or window.
 */
function computerRows(data: Record<string, unknown>, a: Record<string, unknown>): ToolRows | undefined {
  const title = str(a.app).trim()
  const titled = (rows: ToolRow[]): ToolRows => ({ ...(title ? { title } : {}), rows })
  if (Array.isArray(data.apps)) return { title: 'Apps', rows: dicts(data.apps).map((app) => row(str(app.name) || str(app.bundle_id), str(app.bundle_id))) }
  if (Array.isArray(data.windows)) return { title: 'Windows', rows: dicts(data.windows).map((w) => row(str(w.title) || str(w.app_name) || str(w.app), str(w.app_name) || str(w.app))) }
  const action = typeof data.ok === 'boolean' && str(data.action) ? [computerActionRow(data)] : []
  // A capture's row names its app, so it needs no title.
  if (typeof data.mode === 'string' && 'total_elements' in data) return { rows: [...action, captureRow(str(data.app), str(data.window_title), safeInt(data.total_elements))] }
  return action.length ? titled(action) : undefined
}

/** A capture summary's first line (`capture mode=som 1440x900 app=Safari window='Inbox'`) and its element count line. */
const CAPTURE_LINE_RE = /^capture mode=\S+ \d+x\d+(?: app=(.*?))?(?: window=(['"])(.*)\2)?$/m
const ELEMENTS_LINE_RE = /^(\d+) interactable element\(s\):$/m

/**
 * TAL-2328: a `computer_use` result the Agent kept as text (a capture handed to the model as an image, its JSON action
 * outcome first when it captured after acting) as rows; undefined for any other tool or text.
 */
export function toolTextRows(name: unknown, text: string): ToolRows | undefined {
  if (name !== 'computer_use') return undefined
  const capture = CAPTURE_LINE_RE.exec(text)
  if (!capture) return undefined
  const end = text.indexOf('\n')
  const head = text.startsWith('{') && end > 0 ? text.slice(0, end) : ''
  let payload: unknown
  try { payload = head ? JSON.parse(head) : undefined } catch { payload = undefined }
  const action = isDict(payload) && typeof payload.ok === 'boolean' && str(payload.action) ? [computerActionRow(payload)] : []
  const elements = ELEMENTS_LINE_RE.exec(text)
  return { rows: [...action, captureRow(capture[1] ?? '', capture[3] ?? '', elements ? Number(elements[1]) : undefined)] }
}

/** TAL-2335: the longest outcome `value` (an error's or answer's first line) a row carries; the row truncates it further. */
const OUTCOME_VALUE_MAX = 200
/** TAL-2335: an outcome `value`: the text's first line, cut to `OUTCOME_VALUE_MAX`; undefined when it has none. */
export const outcomeValue = (text: unknown): string | undefined => {
  const line = firstLine(text)
  return line ? (line.length > OUTCOME_VALUE_MAX ? `${line.slice(0, OUTCOME_VALUE_MAX - 1)}…` : line) : undefined
}
const outcome = (key: ToolOutcome['key'], extra: Partial<Omit<ToolOutcome, 'key'>> = {}): ToolOutcome => ({ key, tone: 'neutral', ...extra })
const withValue = (key: ToolOutcome['key'], value: string | undefined): ToolOutcome => outcome(key, value ? { value } : {})

/** TAL-2335: the tools whose non-zero exit is their outcome; a zero exit shows nothing. */
const EXIT_TOOLS = new Set(['terminal', 'execute_code', 'process_manage'])
/** TAL-2335: the Kanban calls that move a task, whose outcome is the status it landed in. */
const KANBAN_MOVES = new Set(['kanban_request_review', 'kanban_request_changes', 'kanban_unblock', 'kanban_schedule'])
const KANBAN_OUTCOMES: Record<string, ToolOutcome['key']> = { kanban_block: 'blocked', kanban_complete: 'completed', kanban_comment: 'commented' }
const CRON_OUTCOMES: Record<string, ToolOutcome['key']> = { pause: 'paused', resume: 'resumed', remove: 'removed', run: 'ran_now' }
const TALARIA_OUTCOMES: Record<string, ToolOutcome['key']> = { session_send: 'sent', clarify_respond: 'sent', session_new: 'created', session_branch: 'created', project_create: 'created', goal_set: 'goal_set' }
const MEMORY_OUTCOMES: Record<string, ToolOutcome['key']> = { add: 'memory_added', patch: 'memory_updated', replace: 'memory_updated', remove: 'memory_removed' }

/** `in_progress` → `In progress`: a status slug as a row shows it. */
const statusName = (slug: string): string => {
  const words = slug.trim().replace(/[_-]+/g, ' ')
  return words ? words[0]!.toUpperCase() + words.slice(1) : ''
}
/** An Agent timestamp as ISO 8601, which clients format; undefined when it is not a date. */
const isoTime = (value: unknown): string | undefined => {
  const time = typeof value === 'string' && value.trim() ? Date.parse(value) : Number.NaN
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

/** A memory write: its staged approval, else how many entries it added, updated or removed (a mixed batch counts as updates). */
function memoryOutcome(data: Record<string, unknown>, a: Record<string, unknown>): ToolOutcome | undefined {
  if (data.staged === true) return outcome('pending_approval', { tone: 'attention' })
  const keys = (Array.isArray(a.operations) ? dicts(a.operations) : [a]).flatMap((op) => (Object.hasOwn(MEMORY_OUTCOMES, str(op.action)) ? [MEMORY_OUTCOMES[str(op.action)]!] : []))
  if (!keys.length) return undefined
  return outcome(keys.every((key) => key === keys[0]) ? keys[0]! : 'memory_updated', { count: keys.length })
}

/** A skill write: its staged approval, else created (any create), removed (only deletes) or updated. */
function skillOutcome(data: Record<string, unknown>, a: Record<string, unknown>): ToolOutcome | undefined {
  if (data.staged === true) return outcome('pending_approval', { tone: 'attention' })
  const actions = Array.isArray(data.results) ? dicts(data.results).map((r) => str(r.action)) : data.success === true ? (Array.isArray(a.operations) ? dicts(a.operations) : [a]).map((op) => str(op.action)) : []
  if (!actions.length) return undefined
  if (actions.includes('create')) return outcome('skill_created')
  return outcome(actions.every((action) => action === 'delete') ? 'removed' : 'skill_updated')
}

/** A connection: waiting for the user to sign in, else the apps it connected. */
function connectionOutcome(data: Record<string, unknown>): ToolOutcome | undefined {
  const targets = dicts(data.targets)
  if (targets.some((t) => str(t.state) === 'initiated' || str(t.state) === 'pending')) return outcome('needs_sign_in', { tone: 'attention' })
  const names = targets.filter((t) => str(t.state) === 'connected').map((t) => str(t.name).trim()).filter(Boolean)
  const value = outcomeValue(names.join(', '))
  return value ? outcome('connected', { value }) : undefined
}

/** A question: the first answer's first line, or that the user skipped it. */
function clarifyOutcome(data: Record<string, unknown>): ToolOutcome | undefined {
  const first = clarifyExchanges(data)?.exchanges[0]
  if (first?.skipped) return outcome('skipped')
  const value = outcomeValue(first?.answer ?? '')
  return value ? outcome('answered', { value }) : undefined
}

/**
 * TAL-2335: the outcome a completed call's collapsed row shows after its label (`ToolOutcomeSchema`), decided once for live,
 * replayed and persisted calls from the classification `toolOutcome` made (`failed`, `isError`), the parsed result (`data`,
 * nested JSON parsed) and its uncapped display `view`: a shell tool's non-zero exit; any other failure's first error line; a
 * neutral `skill_manage` refusal (the Agent retries it) nothing; else what the tool changed, a search that found nothing, or
 * what waits on the user. Undefined for every other call: reads, lists, views, media, edits and app successes.
 */
export function toolCallOutcome(name: unknown, args: unknown, data: unknown, view: ToolResultView, failed: boolean, isError: boolean): ToolOutcome | undefined {
  const tool = str(name)
  const d = isDict(data) ? data : {}
  const a = isDict(args) ? args : {}
  if (EXIT_TOOLS.has(tool)) {
    const exit = d.exit_code ?? d.exitCode ?? view.exit_code
    if (typeof exit === 'number' && Number.isSafeInteger(exit) && exit !== 0) return outcome('exit', { tone: 'error', count: exit })
  }
  if (isError) {
    const value = outcomeValue(typeof d.error === 'string' ? d.error : '') ?? outcomeValue(view.error) ?? outcomeValue(view.stderr) ?? outcomeValue(view.text)
    return outcome('failed', { tone: 'error', ...(value ? { value } : {}) })
  }
  if (failed) return undefined
  if (Object.hasOwn(TALARIA_OUTCOMES, tool)) return outcome(TALARIA_OUTCOMES[tool]!)
  if (tool === 'queue_send_now') return d.outcome === 'delivered' || d.outcome === 'next_step' ? outcome('sent') : undefined
  if (tool === 'approval_respond') return outcome((str(d.choice) || str(a.choice)) === 'deny' ? 'denied' : 'approved')
  if (tool === 'memory') return memoryOutcome(d, a)
  if (tool === 'skill_manage') return skillOutcome(d, a)
  if (tool === 'cronjob_manage') {
    const action = str(a.action)
    if (action === 'create') return withValue('job_created', isoTime(isDict(d.job) ? d.job.next_run_at : undefined))
    return Object.hasOwn(CRON_OUTCOMES, action) ? outcome(CRON_OUTCOMES[action]!) : undefined
  }
  if (Object.hasOwn(KANBAN_OUTCOMES, tool)) return d.ok === true ? outcome(KANBAN_OUTCOMES[tool]!) : undefined
  if (KANBAN_MOVES.has(tool)) return d.ok === true && statusName(str(d.status)) ? withValue('moved_to', statusName(str(d.status))) : undefined
  if (tool === 'manage_connections') return connectionOutcome(d)
  if (tool === 'clarify') return clarifyOutcome(d)
  if (tool === 'search_files') return view.matches?.total === 0 ? outcome('no_matches') : undefined
  if (tool === 'web_search' || tool === 'x_search') return view.links && !view.links.items.length && !view.links.answer?.trim() ? outcome('no_results') : undefined
  if (tool === 'session_search') return (d.mode === 'discover' || d.mode === 'browse') && Array.isArray(d.results) && !d.results.length ? outcome('no_results') : undefined
  return undefined
}
