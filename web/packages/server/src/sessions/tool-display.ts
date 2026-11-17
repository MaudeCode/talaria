/**
 * The server's one tool classifier: every client shows a call's icon, verb and label from the `kind` and `target` this
 * module computes for live frames and the public projection of persisted calls (`redact.ts` stamps them). Callers pass
 * redacted args, so the target never shows more than the arguments it came from.
 */
import type { FileExcerpt, FileExcerptLine, ResultLink, ResultLinks, ResultPage, SearchMatches, SearchMatchFile, ToolEditDiff, ToolKind, ToolPresentation, ToolPresentationEntry, ToolProgress } from '@maudecode/talaria-web-contracts'
import { DecisionReviewRefSchema, FileExcerptSchema, OutboundDraftRefSchema, SearchMatchesSchema, ProposalRefSchema, ShowBlockRefSchema, TALARIA_TOOL_NAMES, TerminalRefSchema, TOOL_PRESENTATIONS, type DecisionReviewRef, type OutboundDraftRef, type ProposalRef, type ShowBlockRef, type TerminalRef } from '@maudecode/talaria-web-contracts'
import { posix } from 'node:path'
import { str } from '../util.js'
import { expandHome } from '../workspace/paths.js'
import { diffHunks, hunkTotals } from '../text/diff.js'
import { isDict, messageText, TOOL_ARG_CONTENT_CAP, TOOL_ARG_CONTENT_KEYS } from './merge.js'

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
  ['read', (t, n) => ['read', 'view', 'open'].some((k) => t.has(k)) || n === 'vision_analyze'],
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
  return agentTool(name)?.kind ?? tokenToolKind(name)
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
}
/** TAL-2317: the Talaria tools named by what they act on; every other one is named by the tool itself. */
const TALARIA_TARGET_KEYS: Record<string, string[]> = { deliver: ['path'], terminal_open: ['command'] }
const FALLBACK_KEYS = ['cmd', 'command', 'path', 'file_path', 'file', 'uri', 'url', 'query', 'pattern', 'dir', 'task', 'name']
const TOOL_TARGET_MAX = 200

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
export function toolDisplay(name: unknown, args: unknown, workspace: string | null = null): { kind: ToolKind; target: string; focus_path: string | null; shows_card?: true } {
  const bridge = BRIDGES.get(str(name))
  const kind = bridge?.kind ?? toolKind(name)
  const a = isDict(args) ? args : {}
  const arg = (keys: string[]) => keys.map((k) => snapshotArg(a, k)).find((v): v is string => typeof v === 'string' && Boolean(v.trim())) ?? ''
  const special = name === 'delegate_task' ? delegateTarget(arg) : bridge ? bridge.target(snapshotItems(snapshotArg(a, bridge.key) ?? '')) : ''
  const own = kind === 'talaria' ? arg(TALARIA_TARGET_KEYS[str(name)] ?? []) || str(name) : ''
  const first = (special || own || arg(TARGET_KEYS[kind] ?? FALLBACK_KEYS)).trim().split('\n')[0] ?? ''
  // Capped by code point, so the cap never splits a surrogate pair into invalid JSON.
  return {
    kind, target: Array.from(first.replace(/\s+/g, ' ').trim()).slice(0, TOOL_TARGET_MAX).join(''), focus_path: kind === 'read' || kind === 'write' ? focusPath(arg(FOCUS_KEYS), workspace) : null,
    ...(typeof name === 'string' && CARD_TOOLS.has(name) ? { shows_card: true as const } : {}),
  }
}

/**
 * TAL-2316: the Agent's tool-discovery bridges, labelled as its own `_bridge_labels` does: `tool_describe` reads the
 * named tools' details, `tool_search` searches by its first non-empty query.
 */
const BRIDGES = new Map<string, { kind: ToolKind; key: string; target: (items: string[]) => string }>([
  ['tool_describe', { kind: 'read', key: 'names', target: (names) => names.filter((n) => n.trim()).join(', ') }],
  ['tool_search', { kind: 'search', key: 'queries', target: (queries) => queries.find((q) => q.trim()) ?? '' }],
])

/** A quoted string in a `pythonStr` list, whose closing quote the snapshot cap may have cut. */
const QUOTED = /(['"])((?:(?!\1)[^\\]|\\.)*)\1?/gs

/** A snapshot argument's items: each string of a `pythonStr` list (which the cap may cut short), else the one value. */
function snapshotItems(value: string): string[] {
  return value.startsWith('[') ? Array.from(value.matchAll(QUOTED), (m) => unescapeGoal(m[2] ?? '')) : [value]
}

/** TAL-1968: calls whose transcript card the user must see, as a settled turn keeps them open (`buildTurnScene`). */
const CARD_TOOLS = new Set(['show', 'deliver', 'propose', 'draft_card', 'terminal_open'])

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

function rawToolName(call: Record<string, unknown>): string {
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
  if (presentation ? presentation !== 'diff' : toolKind(name) !== 'write') return undefined
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

/** TAL-2324: how much of a page's Markdown a `web_extract` row shows; the whole result stays behind "Show full output". */
export const PAGE_EXCERPT_CHARS = 600
/** TAL-2324: where the Agent's cut of a long page begins (`web_tools_truncate._truncate_with_footer`): its middle marker, else its footer. */
const PAGE_CUT_RE = /\n\n\[\.\.\. middle omitted|\n─+ \[TRUNCATED\] ─+/

/** TAL-2324: a page's Markdown up to its cut, its first `PAGE_EXCERPT_CHARS` characters ending at a word where one is near. */
function pageExcerpt(content: string): string {
  const page = content.split(PAGE_CUT_RE)[0]!.trim()
  if (page.length <= PAGE_EXCERPT_CHARS) return page
  const head = page.slice(0, PAGE_EXCERPT_CHARS)
  const word = head.search(/\s\S*$/)
  return `${(word > PAGE_EXCERPT_CHARS * 0.8 ? head.slice(0, word) : head).trimEnd()}…`
}

/**
 * TAL-2324: a `web_extract` result's `results`, one page each with its excerpt, or the error that page failed with (a policy
 * block carries its message there too). Undefined for a whole-call error or any other shape, which the generic rule shows.
 */
export function resultPagesView(data: Record<string, unknown>): ResultPage[] | undefined {
  if (!Array.isArray(data.results) || data.error) return undefined
  return data.results.flatMap((row): ResultPage[] => {
    if (!isDict(row)) return []
    const url = webUrl(row.url)
    const error = typeof row.error === 'string' && row.error.trim() ? row.error.trim() : undefined
    // A URL the Agent refused as invalid still names its row, as text.
    return [{ url: url?.href ?? '', domain: url ? urlDomain(url) : '', title: str(row.title).trim() || str(row.url).trim(), excerpt: error ? '' : pageExcerpt(str(row.content)), ...(error ? { error } : {}) }]
  })
}

/**
 * TAL-2323: a result view's `file_excerpt` and `matches` files with the `focus_path` each path names inside the session's
 * `workspace` (the call-level TAL-1458 rule). Callers pass the redacted view, so a focus path never shows more than its path.
 * Without a workspace an absolute path keeps the focus path it was given.
 */
export function withResultFocusPaths<T extends Record<string, unknown>>(view: T, workspace: string | null): T {
  const located = <F extends { path: string; focus_path?: string | undefined }>(item: F): F => {
    const { focus_path: given, ...rest } = item
    const focus = focusPath(item.path, workspace) ?? (workspace ? null : given)
    return (focus ? { ...rest, focus_path: focus } : rest) as F
  }
  const excerpt = view.file_excerpt === undefined ? undefined : FileExcerptSchema.safeParse(view.file_excerpt).data
  const matches = view.matches === undefined ? undefined : SearchMatchesSchema.safeParse(view.matches).data
  return { ...view, ...(excerpt ? { file_excerpt: located(excerpt) } : {}), ...(matches ? { matches: { ...matches, files: matches.files.map(located) } } : {}) }
}

/** MCP progress is untrusted; only finite percentages and a bounded message reach clients. */
export function toolProgress(data: Record<string, unknown>): ToolProgress {
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  const percent = finite(data.percent) ? data.percent : finite(data.progress) && finite(data.total) && data.total > 0 ? (data.progress / data.total) * 100 : null
  return { percent: percent === null ? null : Math.round(Math.max(0, Math.min(100, percent))), message: typeof data.message === 'string' ? data.message.trim().slice(0, 1000) || null : null }
}
