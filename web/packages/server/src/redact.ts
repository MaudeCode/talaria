import { str } from './util.js'
import { toolArgs, toolDisplay, toolName } from './sessions/tool-display.js'
/**
 * Credential redaction and the public session projection (Python
 * `api/helpers.py`). API responses are a hard boundary: transcript-bearing
 * fields are masked with the local pattern set, and private replay aliases
 * are stripped at their schema positions. The Agent's broader redactor is
 * not consulted (it lives in-process in Python); the local patterns mirror
 * its known credential prefixes.
 */

const CRED_RE = new RegExp(
  '(?<![A-Za-z0-9_-])(' +
    'sk-[A-Za-z0-9_-]{10,}' +
    '|ghp_[A-Za-z0-9]{10,}' +
    '|github_pat_[A-Za-z0-9_]{10,}' +
    '|gho_[A-Za-z0-9]{10,}' +
    '|ghu_[A-Za-z0-9]{10,}' +
    '|ghs_[A-Za-z0-9]{10,}' +
    '|ghr_[A-Za-z0-9]{10,}' +
    '|xox[baprs]-[A-Za-z0-9-]{10,}' +
    '|AIza[A-Za-z0-9_-]{30,}' +
    '|pplx-[A-Za-z0-9]{10,}' +
    '|fal_[A-Za-z0-9_-]{10,}' +
    '|fc-[A-Za-z0-9]{10,}' +
    '|bb_live_[A-Za-z0-9_-]{10,}' +
    '|gAAAA[A-Za-z0-9_=-]{20,}' +
    '|AKIA[A-Z0-9]{16}' +
    '|sk_live_[A-Za-z0-9]{10,}' +
    '|sk_test_[A-Za-z0-9]{10,}' +
    '|rk_live_[A-Za-z0-9]{10,}' +
    '|SG\\.[A-Za-z0-9_-]{10,}' +
    '|hf_[A-Za-z0-9]{10,}' +
    '|r8_[A-Za-z0-9]{10,}' +
    '|npm_[A-Za-z0-9]{10,}' +
    '|pypi-[A-Za-z0-9_-]{10,}' +
    '|dop_v1_[A-Za-z0-9]{10,}' +
    '|doo_v1_[A-Za-z0-9]{10,}' +
    '|am_[A-Za-z0-9_-]{10,}' +
    '|sk_[A-Za-z0-9_]{10,}' +
    '|tvly-[A-Za-z0-9]{10,}' +
    '|exa_[A-Za-z0-9]{10,}' +
    '|gsk_[A-Za-z0-9]{10,}' +
    '|syt_[A-Za-z0-9]{10,}' +
    '|retaindb_[A-Za-z0-9]{10,}' +
    '|hsk-[A-Za-z0-9]{10,}' +
    '|mem0_[A-Za-z0-9]{10,}' +
    '|brv_[A-Za-z0-9]{10,}' +
    ')(?![A-Za-z0-9_-])',
  'g',
)
/** One `name=value` auth parameter: an escaped-quoted, quoted or bare value. */
const AUTH_PARAM = String.raw`[A-Za-z0-9_-]+=(?:\\"(?:[^"\\\r\n]|\\[^"])*\\"|"[^"\r\n]*"|'[^'\r\n]*'|[^\s,"'\\]*)`
/**
 * The credential of an `Authorization:` header, after an optional scheme word (`Bearer`, `ApiKey`, `AWS4-HMAC-SHA256`, ...).
 * A parameterized credential (`Digest username="bob", response="..."`, `Credential=..., Signature=...`) is masked whole.
 */
const AUTH_HDR_RE = new RegExp(String.raw`(Authorization:\s*(?:[A-Za-z][A-Za-z0-9-]{0,31}\s+)?)(${AUTH_PARAM}(?:\s*,\s*${AUTH_PARAM})*|[^\s'",\])]+)`, 'gi')
/** A JSON Web Token anywhere (`eyJ<header>.<payload>.<signature>`). */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g
/** A bearer credential in any header or text (`X-Auth: Bearer ...`); `AUTH_HDR_RE` owns the `Authorization:` header. */
const BEARER_RE = /((?<!Authorization:\s{0,8})\bBearer\s+)([^\s'",\])]+)/gi
/** A `Cookie:` / `Set-Cookie:` header's whole value (session cookies are credentials). */
const COOKIE_HDR_RE = /(\b(?:Set-)?Cookie:\s*)([^'"\r\n]+)/gi
const EMBEDDED_AWS_RE = /AKIA[A-Z0-9]{16}/g
const ENV_RE = /([A-Z0-9_]{0,50}(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]{0,50})\s*=\s*(['"]?)(\S+)\2/g
/** `scheme://user:secret@host` (database and basic-auth URLs): the password is masked, the user and host stay. The scheme starts at a run boundary and is capped so the scan stays linear. */
const URL_USERINFO_RE = /((?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s:@/'"]+:)([^\s@/'"]+)(?=@)/g
/** Credential key names in any case and naming style (`access_token`, `clientSecret`, `aws_secret_access_key`, `X-Api-Key`). */
const CRED_KEY_NAME = String.raw`(?:(?:access|refresh|id|auth)[_-]?token|api[_-]?key|client[_-]?secret|(?:private|access|secret|session)[_-]?key|credentials?|authorization|signature|cookie|secret|token|password|passwd)`
const CRED_KEY = String.raw`(?:[A-Za-z0-9]+[_-]){0,4}${CRED_KEY_NAME}`
/** The prefilter's view of the same key names, so it never skips text the credential rule would mask. */
const CRED_KEY_NAME_RE = new RegExp(CRED_KEY_NAME, 'i')
/** An argument or JSON key naming a credential; its scalar value is masked whatever it contains. */
const CRED_KEY_RE = new RegExp(String.raw`^-{0,2}${CRED_KEY}$`, 'i')
/**
 * Credential parameters in text (`access_token=`, `"clientSecret": "..."`, `X-Api-Key:`) and CLI flags with a
 * space-separated value (`--password hunter2`); a quoted value (including bash `$'...'`) is masked through its closing quote. An unquoted upper-case
 * `KEY=value` whose name `ENV_RE` covers is left to it.
 * The name prefix is capped at four segments so the scan stays linear.
 */
const CRED_PARAM_RE = new RegExp(String.raw`(?<![A-Za-z0-9])(-{0,2})(${CRED_KEY})(["']?\s*[=:]\s*|\s+)(\$?"[^"\n]*"|\$?'[^'\n]*'|[^\s"'&,;)}\]$]+)`, 'gi')
const ENV_KEY_NAME_RE = /API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/
/** `curl -u user:secret` / `--user user:secret`; a quoted pair is masked through its closing quote. */
const USER_FLAG_RE = /((?<![A-Za-z0-9-])(?:-u|--user)\s+\$?)(?:(["'])([^\n:'"]*:)([^\n'"]*)\2|([^\s:"'$]+:)([^\s"'@]+))/g
const QUERY_KEY_RE = /([?&]key=)([^\s"'&#]+)/gi
const PRIVKEY_RE = /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g
const CODE_ENV_KEY_LITERAL_RE = /([A-Z0-9_]{0,50}(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]{0,50}=)(["'][)\]:,]+|[)\]:,]+)/y
const ENV_KEY_PREFIX_RE = /([A-Z0-9_]{0,50}(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]{0,50}=)/g
const REDACTED_ENV_VALUE_RE = /(?:\*{3,}|[A-Za-z0-9][A-Za-z0-9_.:/+-]{0,32}\.\.\.[A-Za-z0-9_.:/+-]{1,16})/y

function mask(token: string): string {
  // By code point, so a partial mask never splits a surrogate pair into invalid JSON.
  const chars = Array.from(token)
  return chars.length >= 18 ? `${chars.slice(0, 6).join('')}...${chars.slice(-4).join('')}` : '***'
}

/** Restore `KEY=)` style code literals the env regex would otherwise mangle. */
function restoreCodeEnvKeyLiterals(original: string, redacted: string): string {
  const literalOccurrences = new Map<string, string>()
  const originalCounts = new Map<string, number>()
  for (const m of original.matchAll(ENV_KEY_PREFIX_RE)) {
    const prefix = m[1] ?? ''
    const occurrence = originalCounts.get(prefix) ?? 0
    originalCounts.set(prefix, occurrence + 1)
    CODE_ENV_KEY_LITERAL_RE.lastIndex = m.index
    const literal = CODE_ENV_KEY_LITERAL_RE.exec(original)
    if (literal) literalOccurrences.set(`${prefix}\u0000${occurrence}`, literal[2] ?? '')
  }
  if (!literalOccurrences.size) return redacted
  const redactedCounts = new Map<string, number>()
  const pieces: string[] = []
  let last = 0
  for (const m of redacted.matchAll(ENV_KEY_PREFIX_RE)) {
    const prefix = m[1] ?? ''
    const occurrence = redactedCounts.get(prefix) ?? 0
    redactedCounts.set(prefix, occurrence + 1)
    const suffix = literalOccurrences.get(`${prefix}\u0000${occurrence}`)
    if (suffix === undefined) continue
    REDACTED_ENV_VALUE_RE.lastIndex = m.index + m[0].length
    const value = REDACTED_ENV_VALUE_RE.exec(redacted)
    if (!value) continue
    pieces.push(redacted.slice(last, value.index), suffix)
    last = value.index + value[0].length
  }
  if (!pieces.length) return redacted
  pieces.push(redacted.slice(last))
  return pieces.join('')
}

export function redactSensitive(text: string): string {
  if (!text) return text
  let out = text.replace(CRED_RE, (_, t: string) => mask(t))
  out = out.replace(EMBEDDED_AWS_RE, (t) => mask(t))
  out = out.replace(AUTH_HDR_RE, (_, head: string, token: string) => head + (/^[A-Za-z0-9_-]+=/.test(token) ? '***' : mask(token)))
  out = out.replace(JWT_RE, (t) => mask(t))
  out = out.replace(BEARER_RE, (_, head: string, token: string) => head + mask(token))
  out = out.replace(COOKIE_HDR_RE, (whole, head: string, value: string) => (/[A-Za-z0-9]/.test(value) ? `${head}***` : whole))
  out = out.replace(CRED_PARAM_RE, (whole, dash: string, key: string, sep: string, value: string) => {
    const dollar = value.startsWith('$') ? '$' : ''
    const quote = /^["']/.test(value.slice(dollar.length)) ? value[dollar.length]! : ''
    const inner = quote ? value.slice(dollar.length + 1, -1) : value
    if (!/[A-Za-z0-9]/.test(inner)) return whole
    // A bare space only separates a CLI flag from its value; `secret sauce` is prose.
    if (!/[=:]/.test(sep) && !dash) return whole
    if (!quote && sep.includes('=') && key === key.toUpperCase() && ENV_KEY_NAME_RE.test(key)) return whole
    // A bare `Authorization: <scheme> <credential>` header is `AUTH_HDR_RE`'s.
    if (!quote && /authorization$/i.test(key) && /^\s*:\s*$/.test(sep)) return whole
    // Fully masked: a partial mask would leak part of a password or passphrase.
    return `${dash}${key}${sep}${dollar}${quote}***${quote}`
  })
  out = out.replace(ENV_RE, (whole, key: string, quote: string, value: string) => (/[A-Za-z0-9]/.test(value) ? `${key}=${quote}${mask(value)}${quote}` : whole))
  out = out.replace(URL_USERINFO_RE, (_, head: string, secret: string) => head + mask(secret))
  out = out.replace(USER_FLAG_RE, (whole, head: string, quote: string | undefined, quotedUser: string | undefined, quotedSecret: string | undefined, user: string | undefined, secret: string | undefined) => {
    if (quote) return /[A-Za-z0-9]/.test(quotedSecret ?? '') ? `${head}${quote}${quotedUser ?? ''}***${quote}` : whole
    return /[A-Za-z0-9]/.test(secret ?? '') ? `${head}${user ?? ''}***` : whole
  })
  out = out.replace(QUERY_KEY_RE, (whole, head: string, value: string) => (/[A-Za-z0-9]/.test(value) ? head + mask(value) : whole))
  out = out.replace(PRIVKEY_RE, '[REDACTED PRIVATE KEY]')
  return restoreCodeEnvKeyLiterals(text, out)
}

const CASE_MARKERS = [
  'sk-', 'ghp_', 'github_pat_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'AKIA', 'xoxb-', 'xoxa-', 'xoxp-', 'xoxr-', 'xoxs-', 'AIza', 'pplx-', 'fal_', 'fc-',
  'bb_live_', 'gAAAA', 'sk_live_', 'sk_test_', 'rk_live_', 'SG.', 'hf_', 'r8_', 'npm_', 'pypi-', 'dop_v1_', 'doo_v1_', 'am_', 'sk_', 'tvly-', 'exa_',
  'gsk_', 'syt_', 'retaindb_', 'hsk-', 'mem0_', 'brv_', 'eyJ', '-----BEGIN',
]
const LOWER_MARKERS = [
  'authorization: bearer ', 'authorization: bot ', 'private key', 'postgres://', 'postgresql://', 'mysql://', 'mongodb://', 'redis://', 'amqp://', '://',
  'access_token', 'refresh_token', 'id_token', 'api_key', 'apikey', 'client_secret', 'auth_token', 'raw_secret', 'secret_input', 'key_material',
  'x-amz-signature', 'token=', 'secret=', 'password=', 'passwd', 'password', 'secret', 'token', 'api-key', 'apikey', 'clientsecret', 'private_key', 'credential', ' -u ', '--user ', 'authorization', 'signature', 'bearer ', 'cookie:', 'authorization=', 'key=', '"token"', '"secret"', '"password"', '"bearer"',
]
const TELEGRAM_RE = /(?:bot)?\d{8,}:[-A-Za-z0-9_]{30,}/
const DISCORD_RE = /<@!?\d{17,20}>/
const PHONE_RE = /(?<![A-Za-z0-9])\+[1-9]\d{6,14}(?![A-Za-z0-9])/

export function mightContainSensitiveText(text: string): boolean {
  if (!text) return false
  if (CASE_MARKERS.some((m) => text.includes(m))) return true
  const lower = text.toLowerCase()
  if (LOWER_MARKERS.some((m) => lower.includes(m))) return true
  if (CRED_KEY_NAME_RE.test(text)) return true
  if (text.includes(':') && TELEGRAM_RE.test(text)) return true
  if (text.includes('<@') && DISCORD_RE.test(text)) return true
  if (text.includes('+') && PHONE_RE.test(text)) return true
  return false
}

const cache = new Map<string, string>()
const CACHE_MAX = 4096
const CACHE_MAX_TEXT_LEN = 16384

export function redactText(text: unknown, enabled: boolean): unknown {
  if (typeof text !== 'string' || !text) return text
  if (!enabled) return text
  if (!mightContainSensitiveText(text)) return text
  if (text.length > CACHE_MAX_TEXT_LEN) return redactSensitive(text)
  const hit = cache.get(text)
  if (hit !== undefined) return hit
  const out = redactSensitive(text)
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(text, out)
  return out
}

export function redactString(text: string, enabled = true): string {
  return redactText(text, enabled) as string
}

export function redactValue(v: unknown, enabled: boolean): unknown {
  if (typeof v === 'string') return redactText(v, enabled)
  if (Array.isArray(v)) return v.map((item) => redactValue(item, enabled))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, redactValue(val, enabled)]))
  return v
}

export const PUBLIC_MESSAGE_INTERNAL_FIELDS = new Set(['api_content', '_row_id', '_state_db_row_id', '_db_row_id', 'state_db_row_id', '_active_turn_token', '_active_turn_user', '_fork_child_turn'])

export type Json = unknown

export function copyJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v: unknown) => copyJson(v)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, copyJson(v)])) as T
  return value
}

function scrubAliasRecord(record: unknown): unknown {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return copyJson(record)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record as Record<string, unknown>)) if (!PUBLIC_MESSAGE_INTERNAL_FIELDS.has(k)) out[k] = copyJson(v)
  return out
}

function scrubToolCallRecord(call: unknown): unknown {
  const result = scrubAliasRecord(call)
  if (!call || typeof call !== 'object' || Array.isArray(call)) return result
  const fn = (call as Record<string, unknown>).function
  if (fn && typeof fn === 'object' && !Array.isArray(fn)) (result as Record<string, unknown>).function = scrubAliasRecord(fn)
  return result
}

function scrubMessageRecord(message: unknown, preserveApiContent: boolean): unknown {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return copyJson(message)
  const m = message as Record<string, unknown>
  const result = scrubAliasRecord(m) as Record<string, unknown>
  if (preserveApiContent && typeof m.api_content === 'string' && m.api_content) result.api_content = m.api_content
  if (Array.isArray(m.content)) result.content = m.content.map((part) => scrubAliasRecord(part))
  if (Array.isArray(m.tool_calls)) result.tool_calls = m.tool_calls.map((call) => scrubToolCallRecord(call))
  return result
}

function scrubMessageRecords(messages: unknown, preserveApiContent = false): unknown {
  if (!Array.isArray(messages)) return copyJson(messages)
  return messages.map((m) => scrubMessageRecord(m, preserveApiContent))
}

function scrubToolCallRecords(toolCalls: unknown): unknown {
  if (!Array.isArray(toolCalls)) return copyJson(toolCalls)
  return toolCalls.map((c) => scrubToolCallRecord(c))
}

function scrubRuntimeJournalSnapshot(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return copyJson(snapshot)
  const s = snapshot as Record<string, unknown>
  const result = copyJson(s)
  if (Array.isArray(s.messages)) result.messages = scrubMessageRecords(s.messages)
  if (Array.isArray(s.tool_calls)) result.tool_calls = scrubToolCallRecords(s.tool_calls)
  return result
}

/** Copy runtime data and strip private replay aliases at their schema positions (Python `scrub_internal_replay_fields`). */
export function scrubInternalReplayFields(value: unknown, opts: { preserveMessageApiContent?: boolean; messageRecords?: boolean } = {}): unknown {
  if (Array.isArray(value)) {
    if (opts.messageRecords === false) return scrubToolCallRecords(value)
    return scrubMessageRecords(value, opts.preserveMessageApiContent ?? false)
  }
  if (!value || typeof value !== 'object') return copyJson(value)
  const v = value as Record<string, unknown>
  const result = copyJson(v)
  for (const [key, child] of Object.entries(v)) {
    if ((key === 'messages' || key === 'context_messages') && Array.isArray(child)) result[key] = scrubMessageRecords(child, opts.preserveMessageApiContent ?? false)
    else if (key === 'tool_calls' && Array.isArray(child)) result[key] = scrubToolCallRecords(child)
    else if (key === 'runtime_journal_snapshot' && child && typeof child === 'object') result[key] = scrubRuntimeJournalSnapshot(child)
  }
  return result
}

export function stripPublicInternalFields(value: unknown, opts: { messageRecords?: boolean } = {}): unknown {
  return scrubInternalReplayFields(value, { messageRecords: opts.messageRecords ?? false })
}

/** Python `format(value, '.17g')`. */
export function formatG17(n: number): string {
  let s = n.toPrecision(17)
  if (s.includes('e')) {
    const [mantissaRaw = '', expRaw = ''] = s.split('e')
    const mantissa = mantissaRaw.includes('.') ? mantissaRaw.replace(/0+$/, '').replace(/\.$/, '') : mantissaRaw
    const sign = expRaw.startsWith('-') ? '-' : '+'
    const digits = expRaw.replace(/^[+-]/, '').replace(/^0+/, '') || '0'
    return `${mantissa}e${sign}${digits.padStart(2, '0')}`
  }
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s
}

/** Python `process_event_utils.build_active_turn_token`. */
export function buildActiveTurnToken(streamId: unknown, pendingStartedAt: unknown): string | null {
  if (!streamId) return null
  const started = typeof pendingStartedAt === 'number' ? pendingStartedAt : typeof pendingStartedAt === 'string' ? Number(pendingStartedAt) : Number.NaN
  if (!Number.isFinite(started) || started <= 0) return null
  return `${str(streamId).trim()}:${formatG17(started)}`
}

function publicMessageProjection(message: unknown, enabled: boolean, activeTurnToken: string | null): unknown {
  const isActive = Boolean(message && typeof message === 'object' && (message as Record<string, unknown>).role === 'user' && activeTurnToken !== null && (message as Record<string, unknown>)._active_turn_token === activeTurnToken)
  const scrubbed = (scrubInternalReplayFields([message], { messageRecords: true }) as unknown[])[0]
  if (!scrubbed || typeof scrubbed !== 'object' || Array.isArray(scrubbed)) return redactValue(scrubbed, enabled)
  const item: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(scrubbed as Record<string, unknown>)) {
    if (PUBLIC_MESSAGE_INTERNAL_FIELDS.has(key)) continue
    item[key] = redactValue(value, enabled)
  }
  if (isActive) item._active_turn_user = true
  return withMessageToolDisplay(scrubbed as Record<string, unknown>, item, enabled)
}

/**
 * A redacted call with its server `kind` and `target`, taken from the raw call's parsed args redacted once (never a
 * redacted JSON string, which masks a different span), so a call shows one target live, after replay and after reload.
 */
function withToolDisplay<T>(raw: unknown, redacted: T, enabled: boolean): T {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !redacted || typeof redacted !== 'object' || Array.isArray(redacted)) return redacted
  const record = raw as Record<string, unknown>
  const out = { ...redacted } as Record<string, unknown>
  if (record.args !== undefined) out.args = redactArgs(record.args, enabled)
  if (record.input !== undefined) out.input = redactArgs(record.input, enabled)
  const fn = record.function
  if (enabled && fn && typeof fn === 'object' && typeof (fn as Record<string, unknown>).arguments === 'string' && out.function && typeof out.function === 'object') {
    try { out.function = { ...out.function, arguments: JSON.stringify(redactArgs(JSON.parse((fn as Record<string, unknown>).arguments as string), enabled)) } } catch { /* unparseable: the text redaction stands */ }
  }
  return { ...out, ...toolDisplay(toolName(record), redactArgs(toolArgs(record), enabled)) } as T
}

/** Every non-empty scalar of a credential value masked, keeping its shape (`{ password: ['x'] }` → `['***']`). */
function maskLeaves(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskLeaves)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, maskLeaves(item)]))
  return (typeof value === 'string' || typeof value === 'number') && String(value) !== '' ? '***' : value
}

/** Tool arguments redacted like any value, plus every scalar under a credential-named key (`{ password: 'x' }`). */
function redactArgs(value: unknown, enabled: boolean): unknown {
  if (!enabled) return value
  if (Array.isArray(value)) {
    // A `[name, value]` header tuple naming a credential.
    if (value.length === 2 && typeof value[0] === 'string' && CRED_KEY_RE.test(value[0])) return [value[0], maskLeaves(value[1])]
    return value.map((item) => redactArgs(item, enabled))
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    // A `{ name: 'Authorization', value: ... }` pair (HAR and similar header lists).
    const label = [record.name, record.key, record.header].find((v): v is string => typeof v === 'string')
    const labelled = label !== undefined && CRED_KEY_RE.test(label)
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, CRED_KEY_RE.test(key) || (labelled && key === 'value') ? maskLeaves(item) : redactArgs(item, enabled)]))
  }
  return redactValue(value, enabled)
}

const isToolUse = (part: unknown): boolean => Boolean(part && typeof part === 'object' && (part as Record<string, unknown>).type === 'tool_use')

/** Every tool call a redacted message carries (OpenAI `tool_calls`, `tool_use` blocks, scene rows), stamped from its raw twin. */
function withMessageToolDisplay(raw: Record<string, unknown>, item: Record<string, unknown>, enabled: boolean): Record<string, unknown> {
  if (Array.isArray(raw.tool_calls) && Array.isArray(item.tool_calls)) {
    const calls = raw.tool_calls as unknown[]
    item.tool_calls = item.tool_calls.map((call: unknown, i) => withToolDisplay(calls[i], call, enabled))
  }
  if (Array.isArray(raw.content) && Array.isArray(item.content)) {
    const parts = raw.content as unknown[]
    item.content = item.content.map((part: unknown, i) => (isToolUse(parts[i]) ? withToolDisplay(parts[i], part, enabled) : part))
  }
  const rawScene = raw._anchor_activity_scene
  const scene = item._anchor_activity_scene
  if (rawScene && typeof rawScene === 'object' && scene && typeof scene === 'object' && Array.isArray((scene as Record<string, unknown>).activity_rows)) {
    item._anchor_activity_scene = { ...scene, activity_rows: withSceneToolDisplay((rawScene as Record<string, unknown>).activity_rows, (scene as Record<string, unknown>).activity_rows as unknown[], enabled) }
  }
  return item
}

/** Redacted scene rows (the detail preview and the paged rows) stamped from their raw twins the same way. */
export function withSceneToolDisplay(rawRows: unknown, rows: unknown[], enabled: boolean): unknown[] {
  const raws = Array.isArray(rawRows) ? rawRows : []
  return rows.map((row, i) => {
    const rawTool = (raws[i] as Record<string, unknown> | undefined)?.tool
    if (!row || typeof row !== 'object' || Array.isArray(row) || !rawTool) return row
    return { ...row, tool: withToolDisplay(rawTool, (row as Record<string, unknown>).tool, enabled) }
  })
}

function redactMessages(messages: unknown, enabled: boolean, activeTurnToken: string | null): unknown {
  if (!Array.isArray(messages)) return redactValue(messages, enabled)
  return messages.map((m) => publicMessageProjection(m, enabled, activeTurnToken))
}

function redactToolCalls(toolCalls: unknown, enabled: boolean): unknown {
  const scrubbed = scrubInternalReplayFields(toolCalls, { messageRecords: false })
  const redacted = redactValue(scrubbed, enabled)
  return Array.isArray(scrubbed) && Array.isArray(redacted) ? redacted.map((call: unknown, i) => withToolDisplay(scrubbed[i], call, enabled)) : redacted
}

/** A live `tool` / `tool_complete` frame as it leaves the server (SSE, journal, legacy replay): redacted like session detail, then stamped. */
export function publicToolFrame(data: Record<string, unknown>, enabled: boolean): Record<string, unknown> {
  const frame = withToolDisplay(data, redactValue(data, enabled) as Record<string, unknown>, enabled)
  // A frame without a displayable argument (a bare completion, or `args: {}`) has no target of its own: omitting it keeps
  // the one its start frame set.
  if (!frame.target) delete frame.target
  return frame
}

function redactNestedMessageContainers(value: unknown, enabled: boolean): unknown {
  const scrubbed = scrubInternalReplayFields(value)
  if (!scrubbed || typeof scrubbed !== 'object' || Array.isArray(scrubbed)) return redactValue(scrubbed, enabled)
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(scrubbed as Record<string, unknown>)) {
    if ((key === 'messages' || key === 'context_messages') && Array.isArray(child)) result[key] = redactMessages(child, enabled, null)
    else if (key === 'tool_calls' && Array.isArray(child)) result[key] = redactToolCalls(child, enabled)
    else if (key === 'runtime_journal_snapshot' && child && typeof child === 'object') result[key] = redactNestedMessageContainers(child, enabled)
    else result[key] = redactValue(child, enabled)
  }
  return result
}

/** Redact credentials in a public session response without mutation (Python `redact_session_data`). */
export function redactSessionData(session: Record<string, unknown>, enabled: boolean): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const activeTurnToken = buildActiveTurnToken(session.active_stream_id, session.pending_started_at)
  for (const [key, value] of Object.entries(session)) {
    if (PUBLIC_MESSAGE_INTERNAL_FIELDS.has(key)) continue
    if (key === 'title' && typeof value === 'string') result[key] = redactText(value, enabled)
    else if (key === 'messages' || key === 'context_messages') result[key] = redactMessages(value, enabled, activeTurnToken)
    else if (key === 'tool_calls' && Array.isArray(value)) result[key] = redactToolCalls(value, enabled)
    else if (key === 'todo_state' || key === 'runtime_journal_snapshot') result[key] = redactNestedMessageContainers(value, enabled)
    else result[key] = copyJson(value)
  }
  return result
}

export const publicSessionProjection = redactSessionData
