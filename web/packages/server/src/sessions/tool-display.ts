/**
 * The server's one tool classifier: every client shows a call's icon, verb and label from the `kind` and `target` this
 * module computes for live frames and the public projection of persisted calls (`redact.ts` stamps them). Callers pass
 * redacted args, so the target never shows more than the arguments it came from.
 */
import type { ToolEditDiff, ToolKind } from '@maudecode/talaria-web-contracts'
import { str } from '../util.js'
import { isDict, messageText, TOOL_ARG_CONTENT_CAP, TOOL_ARG_CONTENT_KEYS } from './merge.js'

/** Ordered rules over whole `_`-separated name tokens (a substring match would read `merge` as `rg`). */
const RULES: [ToolKind, (tokens: Set<string>, name: string) => boolean][] = [
  ['delegate', (_, n) => n === 'subagent_progress' || n === 'delegate_task'],
  ['skill', (t) => t.has('skill') || t.has('skills')],
  ['memory', (t) => t.has('memory')],
  ['shell', (t, n) => ['terminal', 'shell', 'command', 'process', 'bash', 'exec'].some((k) => t.has(k)) || n === 'execute_code'],
  ['read', (t, n) => ['read', 'view', 'open'].some((k) => t.has(k)) || n === 'vision_analyze'],
  ['list', (t, n) => t.has('list') || n === 'todo'],
  ['web', (t) => ['web', 'fetch', 'curl', 'extract', 'browse', 'browser', 'navigate'].some((k) => t.has(k))],
  ['search', (t) => ['search', 'grep', 'find', 'rg', 'ripgrep', 'glob'].some((k) => t.has(k))],
  ['write', (t) => ['write', 'patch', 'edit'].some((k) => t.has(k))],
]

export function toolKind(name: unknown): ToolKind {
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
  web: ['query', 'pattern', 'url', 'uri'],
}
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

/** A call's display class and label: the first line of its kind's argument, whitespace-collapsed and capped. */
export function toolDisplay(name: unknown, args: unknown): { kind: ToolKind; target: string } {
  const kind = toolKind(name)
  const a = isDict(args) ? args : {}
  const raw = (TARGET_KEYS[kind] ?? FALLBACK_KEYS).map((k) => snapshotArg(a, k)).find((v): v is string => typeof v === 'string' && Boolean(v.trim())) ?? ''
  const first = raw.trim().split('\n')[0] ?? ''
  // Capped by code point, so the cap never splits a surrogate pair into invalid JSON.
  return { kind, target: Array.from(first.replace(/\s+/g, ' ').trim()).slice(0, TOOL_TARGET_MAX).join('') }
}

/** A persisted call's arguments: live `args`, a `tool_use` block's `input`, or OpenAI `function.arguments` JSON. */
export function toolArgs(call: Record<string, unknown>): unknown {
  if (call.args !== undefined) return call.args
  if (call.input !== undefined) return call.input
  const raw = isDict(call.function) ? call.function.arguments : undefined
  if (typeof raw !== 'string') return raw ?? null
  try { return JSON.parse(raw) as unknown } catch { return raw }
}

/** A live frame's or persisted call's tool name, in any of the shapes the transcript carries. */
export function toolName(call: Record<string, unknown>): string {
  return str(call.name) || str(call.tool_name) || (isDict(call.function) ? str(call.function.name) : '')
}

/** TAL-448: the most diff lines (and characters) an `edit_diff` carries; its counts always cover the whole diff. */
export const EDIT_DIFF_MAX_LINES = 400
const EDIT_DIFF_MAX_CHARS = 64_000

/**
 * TAL-448: a file-edit call's change, from its completed result's unified `diff` (the Agent's `patch` result): added and
 * removed lines counted over the whole diff, `---` / `+++` file headers excluded by walking each `@@` hunk's line counts,
 * and the diff itself capped. Undefined for any other call, or a result without a string `diff` (`write_file`). Callers
 * redact the returned `diff` with the rest of the call.
 */
export function toolEditDiff(name: unknown, result: unknown): ToolEditDiff | undefined {
  if (toolKind(name) !== 'write') return undefined
  let data: unknown = Array.isArray(result) ? messageText(result) : result
  if (typeof data === 'string') { try { data = JSON.parse(data) } catch { return undefined } }
  const diff = isDict(data) ? data.diff : undefined
  if (typeof diff !== 'string' || !diff.trim()) return undefined
  const lines = diff.replace(/\n$/, '').split('\n')
  let added = 0
  let removed = 0
  let oldLeft = 0
  let newLeft = 0
  for (const [i, line] of lines.entries()) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line)
    if (hunk) { oldLeft = Number(hunk[1] ?? 1); newLeft = Number(hunk[2] ?? 1); continue }
    // A file header pair always ends the hunk before it (a final line without a newline leaves its count short).
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) { oldLeft = 0; newLeft = 0; continue }
    if (oldLeft <= 0 && newLeft <= 0) continue
    if (line.startsWith('+')) { added += 1; newLeft -= 1 } else if (line.startsWith('-')) { removed += 1; oldLeft -= 1 } else if (line.startsWith(' ') || line === '') { oldLeft -= 1; newLeft -= 1 }
  }
  // Whole lines only, so redaction never sees a credential cut short.
  const shown: string[] = []
  let size = 0
  for (const line of lines.slice(0, EDIT_DIFF_MAX_LINES)) {
    size += line.length + 1
    if (size > EDIT_DIFF_MAX_CHARS) break
    shown.push(line)
  }
  return { added, removed, diff: shown.join('\n'), truncated: shown.length < lines.length }
}

/** A decided `edit_diff` (one a live call or a built scene row already carries), kept only when well-formed. */
export function decidedEditDiff(value: unknown): ToolEditDiff | undefined {
  if (!isDict(value)) return undefined
  const { added, removed, diff, truncated } = value
  return Number.isSafeInteger(added) && Number.isSafeInteger(removed) && typeof diff === 'string' && typeof truncated === 'boolean' ? { added: added as number, removed: removed as number, diff, truncated } : undefined
}
