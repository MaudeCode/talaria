/**
 * The server's one tool classifier: every client shows a call's icon, verb and label from the `kind` and `target` this
 * module computes for live frames and the public projection of persisted calls (`redact.ts` stamps them). Callers pass
 * redacted args, so the target never shows more than the arguments it came from.
 */
import type { ToolKind } from '@maudecode/talaria-web-contracts'
import { str } from '../util.js'
import { isDict } from './merge.js'

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
  // camelCase words split like snake_case ones (`readFile` is `read`, `file`).
  const n = str(name).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
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

/** A call's display class and label: the first line of its kind's argument, whitespace-collapsed and capped. */
export function toolDisplay(name: unknown, args: unknown): { kind: ToolKind; target: string } {
  const kind = toolKind(name)
  const a = isDict(args) ? args : {}
  const raw = (TARGET_KEYS[kind] ?? FALLBACK_KEYS).map((k) => a[k]).find((v): v is string => typeof v === 'string' && Boolean(v.trim())) ?? ''
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
