import { str } from './util.js'
import { snapshotArgs, toolArgs, toolDisplay, toolName } from './sessions/tool-display.js'
/**
 * Credential redaction and the public session projection (Python
 * `api/helpers.py`). API responses are a hard boundary: transcript-bearing
 * fields are masked with the local pattern set, and private replay aliases
 * are stripped at their schema positions. The Agent's redactor
 * (`agent/redact.py`, `redact_sensitive_text(force=True)`) is not consulted
 * at runtime; its pattern families are ported here and held to parity by
 * the `Agent redactor parity` tests.
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
    '|xapp-\\d+-[A-Za-z0-9-]{10,}' +
    '|xox[baprs]-[A-Za-z0-9-]{10,}' +
    '|AIza[A-Za-z0-9_-]{30,}' +
    '|pplx-[A-Za-z0-9]{10,}' +
    '|fal_[A-Za-z0-9_-]{10,}' +
    '|fc-[A-Za-z0-9]{10,}' +
    '|bb_live_[A-Za-z0-9_-]{10,}' +
    '|gAAAA[A-Za-z0-9_=-]{20,}' +
    '|(?:AKIA|ASIA)[A-Z0-9]{16}' +
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
    '|xai-[A-Za-z0-9]{30,}' +
    '|ntn_[A-Za-z0-9]{10,}' +
    '|fw[-_][A-Za-z0-9]{30,}' +
    '|fpk_[A-Za-z0-9]{30,}' +
    '|(?:glpat|gloas|gldt|glcbt|glptt|glft|glimt|glagent|glsoat|glffct|glwt)-[A-Za-z0-9_-]{10,}' +
    '|glrtr?-[A-Za-z0-9_.-]{10,}' +
    '|GR1348941[A-Za-z0-9_-]{10,}' +
    '|pk-lf-[A-Za-z0-9-]{8,}' +
    ')(?![A-Za-z0-9_-])',
  'g',
)
/** One `name=value` auth parameter: an escaped-quoted, quoted or bare value. */
const AUTH_PARAM = String.raw`[A-Za-z0-9_-]+=(?:\\"(?:[^"\\\r\n]|\\[^"])*\\"|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|[^\s,"'\\]*)`
/**
 * The credential of an `Authorization:` header, after an optional scheme token read whole (`Bearer`, `ApiKey`,
 * `AWS4-HMAC-SHA256`, `Custom_Scheme`, `2FA`, ...; RFC 7235 token characters other than the shell's quotes; an
 * all-asterisk word is a mask, not a scheme).
 * A parameterized credential (`Digest username="bob", response="..."`, `Credential=..., Signature=...`) is masked whole.
 */
const AUTH_HDR_RE = new RegExp(String.raw`(Authorization:\s*(?:(?!\*+\s)[A-Za-z0-9!#$%&*+.^_|~-]+\s+(?=[^\s,\])]))?)(${AUTH_PARAM}(?:\s*,\s*${AUTH_PARAM})*|[^\s,\])][^\s'",\])]*)`, 'gi')
/** A JSON Web Token anywhere (`eyJ<header>.<payload>.<signature>`), or its header alone or with its payload. */
const JWT_RE = /\beyJ(?:[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}|[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_=-]{4,}){0,2})/g
/** A bearer credential in any header or text (`X-Auth: Bearer ...`); `AUTH_HDR_RE` owns the `Authorization:` header. */
const BEARER_RE = /((?<!Authorization:\s{0,8})\bBearer\s+)([^\s,\])][^\s'",\])]*)/gi
/** One shell-quoted piece, which may span lines: `'...'`, `"..."` (with backslash escapes), bash `$'...'` / `$"..."`, or JSON escaped inside a shell string (`\"...\"`). */
const QUOTED = String.raw`\$?'[^']*'|\$?"(?:[^"\\]|\\[\s\S])*"|\\"(?:[^"\\]|\\[^"])*\\"`
/** A `"` / `'` not escaped by an odd run of backslashes. */
const UNESCAPED_QUOTE_RE = [/(?:^|[^\\])(?:\\\\)*"/, /(?:^|[^\\])(?:\\\\)*'/] as const
/** A quoted value's delimiters and content, or null for a bare value. */
function splitQuoted(value: string): { open: string; inner: string; close: string } | null {
  const m = /^(\$?(?:\\"|"|'))([\s\S]*?)(\\"|"|')$/.exec(value)
  if (!m || m[1]!.replace('$', '') !== m[3]) return null
  const [, open = '', inner = '', close = ''] = m
  // One piece only: its own delimiter never appears unescaped inside (`'bob':'pw'` is two pieces). A plain `'…'` has no
  // escapes; `"…"` and `$'…'` escape with a backslash; escaped JSON (`\"…\"`) is left to its scanner.
  if (open === "'" && inner.includes("'")) return null
  if ((open === '"' || open === '$"' || open === "$'") && UNESCAPED_QUOTE_RE[close === "'" ? 1 : 0].test(inner)) return null
  return { open, inner, close }
}
/**
 * A `Cookie:` / `Set-Cookie:` header's whole value (session cookies are credentials), up to the quote that encloses the
 * header (`-H 'Cookie: a="b c"'`, `-H "Cookie: a=\"b c\""`), or to the line end when it is not quoted.
 */
const COOKIE_ANSI_RE = /(\$'(?:Set-)?Cookie:\s*)((?:[^'\\\r\n]|\\.)*)/gi
const COOKIE_SQ_RE = /((?<!\$)'(?:Set-)?Cookie:\s*)([^'\r\n]*)/gi
const COOKIE_DQ_RE = /("(?:Set-)?Cookie:\s*)((?:[^"\\\r\n]|\\.)*)/gi
const COOKIE_BARE_RE = new RegExp(String.raw`((?<!['"])\b(?:Set-)?Cookie:\s*)((?:${QUOTED}|[^'"\\\r\n]|\\(?!"))+)`, 'gi')
/**
 * `user:password@host` with no scheme (curl reads it as a URL), or after an expansion that may supply one
 * (`${SCHEME}bob:pw@host`). The password runs from the first `:` to the `@`, colons included (`bob:hunter:2@`);
 * `git@host:org/repo` has no password before its `@`.
 */
const BARE_USERINFO_RE = /(?<![^\s'"=(<,})\x60])([A-Za-z0-9._%+-]+:)([^\s@/'"\\]+)(?=@[^\s@/'"\\])/g
/** A `key=value` whose key is percent-encoded (`api%5Fkey=`): the destination decodes the key once, so it is checked decoded. */
const PERCENT_KEY_RE = /(?<![A-Za-z0-9_.%-])((?=[A-Za-z0-9_.%-]*%[0-9A-Fa-f]{2})[A-Za-z0-9_.%-]+=)([^&#\s"'<>]*)/g
const percentDecode = (text: string): string => text.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
/**
 * A listed argv (`['login', '--password', 'hunter2']`, JSON or a Python repr): a quoted flag, then its value (quoted, a
 * bare scalar such as `123456`, or a flat list or dict).
 */
const LISTED_FLAG_RE = /(["'])(-{1,2})([A-Za-z0-9_][A-Za-z0-9_.-]*)\1(\s*,\s*)(?:(["'])((?:\\.|(?!\5)[^\\])*)\5|(\[[^[\]]*\]|\{[^{}]*\}|[^\s,\])}'"[{]+))/g
const EMBEDDED_AWS_RE = /(?:AKIA|ASIA)[A-Z0-9]{16}/g
const ENV_RE = /([A-Z0-9_]{0,50}(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]{0,50})\s*=\s*(['"]?)(\S+)\2/g
/**
 * The Agent's other env names: an all-caps one ending a word in `KEY`, `PASS` or `PW` (`OPENAI_KEY`, `DB_PW`, not
 * `KEYBOARD`), or a lowercase `name_key` / `name_pass` / `name_pw`, URL query parameters included (the Agent skips any
 * text with a URL). `isEnvSecretAssignment` gates it.
 */
// One attempt per identifier, which must hold a keyword: the scan stays linear on long runs (`PWPWPW…`).
const ENV_SUFFIX_RE = /(?<![A-Z0-9_])(?=[A-Z0-9_]*(?:KEY|PASS|PW))([A-Z0-9_]+)\s*=\s*(['"]?)(\S+)\2/g
const ENV_SUFFIX_LOWER_RE = /(?<![a-z0-9_])([a-z0-9_]+_(?:key|pass|pw)(?![a-z0-9_]))\s*=\s*(['"]?)(\S+)\2/gi
/** A keyword at a word edge of an env name (`DB_PW`, `MYSQL_PASS`), never inside a word (`KEYBOARD`, `PASSAGE`). */
const ENV_SUFFIX_WORD_RE = /(?:^|[^A-Za-z])(?:KEY|PASS|PW)S?(?![A-Za-z])/i
/** Env names whose value is a credential whatever its shape; a bare `KEY` needs an opaque value (`SORT_KEY=name` stays). */
const ENV_STRONG_NAME_RE = /(?:api|auth|access|refresh|session|id|bearer)[ _.-]?(?:key|token)|key[ _.-]?material|secret|passwd|password|pass|pw|credential|auth|bearer/i
/** The prefilter's view of `ENV_SUFFIX_RE` and `ENV_SUFFIX_LOWER_RE`. */
const ENV_SUFFIX_TEST_RES = [new RegExp(ENV_SUFFIX_RE.source), new RegExp(ENV_SUFFIX_LOWER_RE.source, 'i')]
/** The Agent's `_looks_like_opaque_credential`: a value shaped like a generated secret rather than a word. */
function looksOpaque(value: string): boolean {
  if (value === '***' || /^[A-Fa-f0-9]{16,}$/.test(value) || /^[A-Za-z0-9_./+=-]{20,}$/.test(value)) return true
  return value.length >= 12 && [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(value)).length >= 2
}
const isEnvSecretAssignment = (key: string, value: string): boolean =>
  /[A-Za-z0-9]/.test(value) && !/^(?:os\.(?:getenv|environ)|process\.env|\$ENV\{)/.test(value) && ENV_SUFFIX_WORD_RE.test(key) && (ENV_STRONG_NAME_RE.test(key) || looksOpaque(value))
/**
 * `scheme://user:secret@host` (database and basic-auth URLs): the password is masked, the user and host stay. The user
 * and password may be assembled from quoted and escaped shell pieces (`bob:hun'ter2'@`), and every delimiter may be
 * shell-escaped (`https\:\/\/`, `bob\:hunter2`, `hunter2\@`). Any scheme is accepted, a computed one included
 * (`${SCHEME}://`, `$(printf https)://`), since `://` then `user:password@` is userinfo whatever precedes it.
 */
const URL_USERINFO_RE = /(\\?:\\?\/\\?\/(?:[^\s:@/'"\\]|'[^'\n:@/]*'|"[^"\n:@/]*"|\\[^\s:@/])*\\?:)((?:[^\s@/'"\\]|'[^'\n@/]*'|"[^"\n@/]*"|\\[^\s@/])+)(?=\\?@)/g
/** Credential key names in any case and naming style (`access_token`, `clientSecret`, `aws_secret_access_key`, `X-Api-Key`). */
const CRED_KEY_NAME = String.raw`(?:(?:access|refresh|id|auth)[_-]?token|api[_-]?key|access[_-]?key[_-]?id|client[_-]?secret|(?:private|access|secret|session)[_-]?key|credentials?|authorization|signature|cookie|bearer|secret[_-]?input|key[_-]?material|pass[_-]?phrase|pass(?:in|out)|secret|token|password|passwd)`
/** The prefilter's view of the same key names, so it never skips text the credential rule would mask. */
const CRED_KEY_NAME_RE = new RegExp(CRED_KEY_NAME, 'i')
/** A credential name matched against a whole `_`-joined word run (`secret_access_key`, `session_token`). */
const CRED_KEY_NAME_WORDS_RE = new RegExp(String.raw`^${CRED_KEY_NAME}$`, 'i')
/**
 * A shell word with its quote and escape characters removed, as the shell passes it (`--pass'word'` → `--password`),
 * and a JSON `\uXXXX` escape decoded as a JSON parser does (`"pass\u0077ord"` → `password`).
 */
const dequote = (text: string): string => text.replace(/\\\r?\n/g, '').replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/\$(?=['"])|['"\\]/g, '')
/**
 * A key names a credential when any of its path segments (`auth.token`, `database.password`, `auth[password]`,
 * `auth["password"]`) ends in a credential name at a word boundary, however deep its namespace, once dequoted
 * (`--pass'word'`)
 * (`COMPANY_PROD_EU_AWS_SECRET_ACCESS_KEY`, `companyProdEuAwsSessionToken`).
 */
function isCredentialKey(key: string): boolean {
  return dequote(key).split(/[.:/[\]]/).some((segment) => {
    const words = segment.replace(/^-+/, '').split(/[_-]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).filter(Boolean).slice(-8)
    for (let i = 0; i < words.length; i += 1) if (CRED_KEY_NAME_WORDS_RE.test(words.slice(i).join('_'))) return true
    return false
  })
}
/**
 * A `key=value`, `key: value` or `--flag value` in text. Any identifier matches; the loop keeps only those
 * `isCredentialKey` accepts (`access_token`, `"clientSecret"`, `X-Api-Key`, `--companyProdEuAwsSecretAccessKey`,
 * `--auth["password"]`, the shell-composed `--pass'word'` / `--pass\word`), fails closed on a key the shell computes
 * (`--pass$(printf word)`, `--pass$W`), and consumes a value only for those, so a non-credential key never swallows the
 * text after it. The whole identifier is
 * read, however long, and matched whole even without a separator: the scan never restarts inside an identifier, so it
 * stays linear.
 */
/**
 * A piece of a key the shell computes: `$(…)` (flat, unquoted), `` `…` `` (no outer spaces), `${…}`, `$NAME`, a
 * positional or special parameter (`$1`, `$@`, `$#`), or an
 * ANSI-C `$'…'` with a backslash escape (`$'\x77ord'`; like any key piece, without spaces, `=` or `:`).
 */
const SUBST_PIECE = String.raw`\$'(?=[^'\s=:]*\\)(?:[^'\\\s=:]|\\\S)*'|\$\([^()\n'"\x60\\]*\)|\x60(?![\s\x60])(?:[^\x60\n\\]|\\.)*(?<![\s\\])\x60|\$\{[^{}\n]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?$!-]`
const CRED_PARAM_RE = new RegExp(String.raw`(?<![A-Za-z0-9_.[\]-])(-{0,2})((?:[A-Za-z0-9_]|${SUBST_PIECE}|(?<=-)\{(?=[^{}\s]*(?:,|\.\.))[^{}\s]*\}|(?<=-)(?=\$[({]|\x60|\{))(?:\[\\?["'][A-Za-z0-9_.-]*\\?["']\]|[A-Za-z0-9_.[\]-]|\$?'[A-Za-z0-9_.-]*'|\$?"[A-Za-z0-9_.-]*"|\\[A-Za-z0-9_.-]|${SUBST_PIECE}|\{(?=[^{}\s]*(?:,|\.\.))[^{}\s]*\})*)((?:\\?["'])?\s*\+?\\?[=:]\s*|\s+|)`, 'g')
/**
 * A substitution, variable or brace-expansion piece of a key (`$(…)`, `` `…` ``, `${…}`, `$NAME`, `{a,b}`, `{1..3}`) right
 * after an identifier character.
 */
/** Where a key's first computed piece starts (`$…`, an escaped ANSI-C `$'…'`, a backtick, a brace expansion). */
const COMPUTED_PIECE_RE = /\$(?:[({A-Za-z_0-9@*#?$!-]|'(?=[^'\s=:]*\\))|\x60|\{(?=[^{}\s]*(?:,|\.\.))/
/** Every computed piece of a key, to tell whether static text follows its first one. */
const COMPUTED_PIECES_RE = new RegExp(String.raw`${SUBST_PIECE}|\{(?=[^{}\s]*(?:,|\.\.))[^{}\s]*\}`, 'g')
const DYNAMIC_KEY_PIECE_RE = /[A-Za-z0-9_](?:\$[({A-Za-z_0-9@*#?$!-]|\$'(?=[^'\s=:]*\\)|`|\{(?=[^{}\s]*(?:,|\.\.)[^{}\s]*\}))/
/** An `Authorization` value's first word when it is a scheme token (`Basic`), and the gap to the credential after it. */
const AUTH_SCHEME_WORD_RE = /^(?!\*+$)[A-Za-z0-9!#$%&*+.^_|~-]+$/
const AUTH_SCHEME_GAP_RE = /[ \t]+(?=\S)/y
const ENV_KEY_NAME_RE = /API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/
/**
 * `curl -u user:secret` / `-uuser:secret` / `--user user:secret`, and the proxy forms `-U` / `--proxy-user` (and the
 * unique abbreviations curl accepts, `--proxy-u` / `--proxy-us` / `--proxy-use`); a quoted
 * pair or quoted secret is masked through its closing quote.
 */
const USER_FLAG_RE = /(?<![A-Za-z0-9-])(?:-[uU][ \t]*|--(?:user|proxy-u(?:s(?:e(?:r)?)?)?)[ \t]+)(?=\S)/g
/** The prefilter's view of `USER_FLAG_RE`. */
const USER_FLAG_TEST_RE = new RegExp(USER_FLAG_RE.source)
const QUERY_KEY_RE = /([?&]key=)([^\s"'&#]+)/gi
/** A Telegram bot token (`bot<id>:<secret>`): the id stays. */
const TELEGRAM_TOKEN_RE = /(bot)?(\d{8,}):([-A-Za-z0-9_]{30,})/g
/** An E.164 phone number, masked to its first and last digits; never inside a word or encoded data (`ab+1234567`). */
const PHONE_RE = /(?<![A-Za-z0-9])\+[1-9]\d{6,14}(?![A-Za-z0-9])/g
/**
 * A bare token as URL userinfo (`https://TOKEN@github.com`, `ssh://…@`): no `user:` part, at least 8 characters. Round-trip
 * URLs carry tokens in the query, so a bare userinfo credential is never one.
 */
const URL_BARE_TOKEN_RE = /((?:https?|wss?|git|ssh|ftps?|sftp):\/\/)([^\s:@/]{8,})(?=@\S)/gi
/** Control and zero-width characters that can split a token body (`ghp_abc\x1bdef`, `sk-abc\u200bdef`). */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f\u200b-\u200f\u2028-\u202f\u2060\ufeff]/
const CONTROL_CHARS_RE = new RegExp(CONTROL_CHAR_RE.source, 'g')
const CRED_TEST_RE = new RegExp(CRED_RE.source)
const CONTROL_SPLIT_SPAN_RE = /^[A-Za-z0-9_.\x00-\x1f\x7f\u200b-\u200f\u2028-\u202f\u2060\ufeff-]*$/
const PRIVKEY_RE = /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g
/** A private key whose end marker is missing (a display cap cut it off): masked to the end of the text. */
const PRIVKEY_OPEN_RE = /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*$/
const CODE_ENV_KEY_LITERAL_RE = /([A-Z0-9_]{0,50}(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]{0,50}=)(["'][)\]:,]+|[)\]:,]+)/y
const ENV_KEY_PREFIX_RE = /([A-Z0-9_]{0,50}(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]{0,50}=)/g
const REDACTED_ENV_VALUE_RE = /(?:\*{3,}|[A-Za-z0-9][A-Za-z0-9_.:/+-]{0,32}\.\.\.[A-Za-z0-9_.:/+-]{1,16})/y

/**
 * A prefixed credential whose body a control or zero-width character splits, matched on the text without those characters
 * and masked in place. A span may hold only token and control characters and never runs into a `KEY=`; a span crossing a
 * line whose own piece already matches is left to the prefix pass, so a complete token never swallows the next line.
 */
function maskControlSplitTokens(text: string): string {
  const stripped = text.replace(CONTROL_CHARS_RE, '')
  if (stripped.length === text.length || !CRED_TEST_RE.test(stripped)) return text
  // The original index of each kept character.
  const kept: number[] = []
  for (let i = 0; i < text.length; i += 1) if (!CONTROL_CHAR_RE.test(text[i]!)) kept.push(i)
  let out = ''
  let last = 0
  for (const m of stripped.matchAll(CRED_RE)) {
    const token = m[1]!
    const start = kept[m.index]!
    const end = kept[m.index + token.length - 1]! + 1
    const span = text.slice(start, end)
    if (/[\r\n]/.test(span) && CRED_TEST_RE.test(span)) continue
    if (!CONTROL_SPLIT_SPAN_RE.test(span) || text[end] === '=') continue
    out += text.slice(last, start) + mask(token)
    last = end
  }
  return out + text.slice(last)
}

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

/**
 * The index of the quote closing an enclosing `quote` (`'`, `"` or ANSI-C `$'`) at or after `from` (`-1` if none),
 * skipping escaped quotes inside `"…"` and `$'…'`, memoized per quoted region so many values inside one long quoted
 * argument share one scan.
 */
function enclosingClose(text: string): (from: number, quote: string) => number {
  let cachedQuote = ''
  let cachedFrom = -1
  let cachedClose = -1
  return (from: number, quote: string): number => {
    if (quote === cachedQuote && from >= cachedFrom && (cachedClose === -1 || from <= cachedClose)) return cachedClose
    const close = quote.slice(-1)
    let k = from
    while (k < text.length && text[k] !== close) k += quote !== "'" && text[k] === '\\' ? 2 : 1
    cachedQuote = quote
    cachedFrom = from
    cachedClose = k < text.length ? k : -1
    return cachedClose
  }
}

/**
 * The index of the `\"` closing a JSON string escaped inside a double-quoted shell string, scanning from `from` (just after
 * the opening `\"`): shell escapes decode first (`\\` is a JSON backslash, `\"` a JSON quote), then a JSON backslash escapes
 * the next JSON character, so `\\\"` inside the value is an escaped quote, not the close. `-1` if none.
 */
function escapedJsonClose(text: string, from: number): number {
  let jsonEscape = false
  for (let k = from; k < text.length; ) {
    let json: string
    let width: number
    if (text[k] === '\\' && (text[k + 1] === '\\' || text[k + 1] === '"')) { json = text[k + 1]!; width = 2 } else { json = text[k]!; width = 1 }
    if (jsonEscape) jsonEscape = false
    else if (json === '\\') jsonEscape = true
    else if (json === '"') return width === 2 ? k : -1
    k += width
  }
  return -1
}

/**
 * The end (exclusive) of the shell word starting at `start`: adjacent quoted (`'…'`, `"…"` with escapes, `$'…'`), escaped
 * (`\ `) and bare pieces, a leading `[…]`/`{…}`/`(…)` container (balanced; the sidecar's Python repr of nested args), or JSON escaped inside a shell string (`\"…\"`).
 * It stops at shell metacharacters outside a container, at `, ] }` that follow the word, and at the quote that encloses the argument
 * (`-H "X-Api-Key: value"`). An unterminated quote at the word's start runs to the line end; one mid-word ends the word.
 * One pass, so redaction stays linear.
 */
function shellWordEnd(text: string, start: number, enclosing: string, closeOf: (from: number, quote: string) => number = enclosingClose(text)): number {
  const lineEnd = (from: number): number => { const n = text.indexOf('\n', from); return n === -1 ? text.length : n }
  // Inside an enclosing quote a bare value is literal up to that quote's close, spaces and newlines included; a quoted,
  // container or escaped-JSON value keeps its own piece structure.
  if (enclosing && !/^(?:\$?["'`]|[[{(]|\\")/.test(text.slice(start, start + 2))) {
    const close = closeOf(start, enclosing)
    if (close === -1) return lineEnd(start)
    // The word goes on past the enclosing quote when an adjacent piece follows (`'--password=foo'bar`).
    // An empty continuation (`"…", "x"`: JSON structure) leaves the word, and the enclosing quote, at the close.
    const next = text[close + 1] ?? ''
    const after = next && !/[\s&;|<>()]/.test(next) ? shellWordEnd(text, close + 1, '', closeOf) : close
    return after === close + 1 ? close : after
  }
  let depth = 0
  let i = start
  while (i < text.length) {
    const c = text[i]!
    if (i !== start && c === enclosing.slice(-1)) return i
    // `\"…\"` is a piece (JSON escaped inside a shell string) at the value's start or in a container; mid-word, `\"` is
    // an escaped quote like any other escape.
    if (c === '\\' && text[i + 1] === '"' && i !== start && depth === 0) i += 2
    else if (c === '\\' && text[i + 1] === '"') {
      const close = escapedJsonClose(text, i + 2)
      if (close === -1) return lineEnd(i)
      i = close + 2
    } else if (c === '\\') i += 2
    // ANSI-C `$'…'`: a backslash escapes the next character, `\'` included.
    else if (c === '$' && text[i + 1] === "'") {
      let k = i + 2
      while (k < text.length && text[k] !== "'") k += text[k] === '\\' ? 2 : 1
      if (k >= text.length) return i === start ? lineEnd(i) : i
      i = k + 1
    } else if (c === '$' && text[i + 1] === '"') i += 1
    // A command substitution (`$(…)`, backticks) cannot be bounded without a shell parser (`case` patterns carry unmatched
    // `)`, backticks nest by escaping, and either may span lines): mask to the end of the text. `${…}` is balanced, quote-
    // and escape-aware.
    else if (c === '$' && text[i + 1] === '(') return text.length
    // Process substitution (`<(…)`, `>(…)`) likewise.
    else if ((c === '<' || c === '>') && text[i + 1] === '(') return text.length
    else if (c === '$' && text[i + 1] === '{') {
      let k = i + 2
      let d = 1
      while (k < text.length && d > 0) {
        const ch = text[k]!
        if (ch === '\\') k += 2
        else if (ch === "'") { const q = text.indexOf("'", k + 1); k = q === -1 ? text.length : q + 1 }
        else if (ch === '"') { k += 1; while (k < text.length && text[k] !== '"') k += text[k] === '\\' ? 2 : 1; k += 1 }
        // A command substitution inside the expansion can hold a literal `}`: mask to the line end.
        else if ((ch === '$' && text[k + 1] === '(') || ch === '`') return text.length
        else { if (ch === '{') d += 1; else if (ch === '}') d -= 1; k += 1 }
      }
      if (d > 0) return lineEnd(i)
      i = k
    } else if (c === '`') return text.length
    else if (c === "'") {
      const close = text.indexOf("'", i + 1)
      if (close === -1) return i === start ? lineEnd(i) : i
      i = close + 1
    } else if (c === '"') {
      let k = i + 1
      while (k < text.length && text[k] !== '"') k += text[k] === '\\' ? 2 : 1
      if (k >= text.length) return i === start ? lineEnd(i) : i
      i = k + 1
    } else if ((c === '[' || c === '{' || (c === '(' && i === start)) && (i === start || depth > 0)) { depth += 1; i += 1 }
    else if (c === '(' && depth > 0) { depth += 1; i += 1 }
    else if ((c === ']' || c === '}' || c === ')') && depth > 0) {
      depth -= 1; i += 1
      // A leading container is the whole value.
      if (depth === 0) return i
    } else if (c === '\n') return i
    // Shell metacharacters end a word outside a container.
    else if (depth === 0 && /[\s&;|<>()]/.test(c)) return i
    // `,` `]` `}` inside a bare word are part of it (`correct]horse`); before a space, quote or the end they are structure.
    else if (depth === 0 && /[,\]}]/.test(c) && !/^[^\s,\]})"'\\]/.test(text[i + 1] ?? '')) return i
    else i += 1
  }
  return Math.min(i, text.length)
}

/**
 * The shell quote open at each position, read left to right once: `advance(index)` returns the quote (`'` or `"`) that
 * encloses `index`, or `''`. Quotes span lines (a multi-line argument); an apostrophe inside a word is prose.
 */
function quoteTracker(text: string): (index: number) => string {
  let pos = 0
  let state = ''
  let escaped = -1
  return (index: number): string => {
    for (; pos < index; pos += 1) {
      const c = text[pos]
      if (c === '\\' && state !== "'") escaped = pos += 1
      // An apostrophe between two letters is prose (`don't`), not a quote.
      else if (c === "'" && /\p{L}/u.test(text[pos - 1] ?? '') && /\p{L}/u.test(text[pos + 1] ?? '')) continue
      // `$'…'` is ANSI-C quoted: a backslash inside escapes the next character, `\'` included.
      else if (state === '' && c === "'" && text[pos - 1] === '$' && escaped !== pos - 1) state = "$'"
      else if (state === '' && (c === "'" || c === '"')) state = c
      else if (c === state.slice(-1)) state = ''
    }
    return state
  }
}

/** A masked shell word: a single quoted piece keeps its quotes (`'***'`), anything else is `***`. */
function maskShellWord(value: string): string {
  const quoted = splitQuoted(value)
  return quoted && !/^\$?(["']).*\1.+/s.test(value) ? `${quoted.open}***${quoted.close}` : '***'
}

/** A shell word's content, for the "nothing to mask" checks: the inside of a single quoted piece, else the word. */
const shellWordInner = (value: string): string => splitQuoted(value)?.inner ?? value

/** Credential parameters (`CRED_PARAM_RE`) with their whole shell-word value fully masked. */
function redactCredentialParams(text: string): string {
  let out = ''
  let last = 0
  const quoteAt = quoteTracker(text)
  const closeOf = enclosingClose(text)
  let queryWordEnd = -1
  CRED_PARAM_RE.lastIndex = 0
  for (let m = CRED_PARAM_RE.exec(text); m; m = CRED_PARAM_RE.exec(text)) {
    const [head, dash = '', key = '', sep = ''] = m
    const keyEnd = m.index + head.length
    // A computed piece may supply the separator itself (`--password${SEP}hunter2` with `SEP='='`) or the name
    // (`--${KEY}${SEP}hunter2`): from the key's first computed piece, the rest of the key is masked (and the value after a
    // real `=`/`:`) when the static part before it names a credential, or when a flag's name goes on after it.
    const computedAt = key.search(COMPUTED_PIECE_RE)
    const staticTail = computedAt >= 0 && key.slice(computedAt).replace(COMPUTED_PIECES_RE, '') !== ''
    // A long flag computed whole (`--${KEY} hunter2`) may name a credential and take the next word; a short one
    // (`ls -$OPTS dir`) is an option bundle.
    const computedLongFlag = computedAt === 0 && dash === '--' && /^\s+$/.test(sep)
    if (computedAt >= 0 && ((computedAt > 0 && isCredentialKey(key.slice(0, computedAt))) || (dash && staticTail) || computedLongFlag)) {
      // A flag whose name ends in the computed piece (`--password${X} hunter2`) takes its value from the next word.
      const nextWord = dash && !staticTail && /^\s+$/.test(sep)
      const end = /[=:]/.test(sep) || nextWord ? shellWordEnd(text, keyEnd, quoteAt(keyEnd), closeOf) : m.index + dash.length + key.length
      out += `${text.slice(last, m.index + dash.length + computedAt)}***${nextWord ? `${sep}***` : ''}`
      last = end
      CRED_PARAM_RE.lastIndex = Math.max(last, CRED_PARAM_RE.lastIndex)
      continue
    }
    // A key the shell computes from its first piece (`--$(printf password)=`, `--${KEY}=`, a header `${HEADER}: x`) is one
    // only with `=` or a `:` and a space: `$HOST:$PORT`, `-$OPTS dir` and a Markdown `` `code`: `` are not assignments. A
    // leading backtick needs a flag besides.
    const computedStart = /^(?:\$[({A-Za-z_0-9@*#?$!-]|\$'(?=[^'\s=:]*\\)|\x60|\{)/.test(key)
    // A `-H`/`--header` argument is a header even with the value tight against its colon (`-H "${HEADER}:Basic x"`).
    const headerArg = sep.startsWith(':') && /(?:^|\s)(?:-H|--header)[ \t]*["']?$/.test(text.slice(Math.max(0, m.index - 16), m.index))
    if (computedStart && ((!/=|:\s/.test(sep) && !headerArg) || (key.startsWith('\x60') && !dash)) && sep) continue
    // A substitution the key grammar cannot parse (`$(` nested or quoted, `${` nested) may still build a credential name:
    // fail closed to the end of the text, as `shellWordEnd` does for a substitution in a value. An unclosed backtick or a
    // nested brace expansion does so only after a flag: in prose a backtick is a Markdown code span's close
    // (`` `code` ``). A backtick piece inside a key has no outer spaces, so the prose between two code spans
    // (`` ` and ` ``) is never read as one.
    if (!sep && ((/^\$[({]/.test(text.slice(keyEnd, keyEnd + 2)) && (dash || !computedStart)) || (dash && /^[\x60{]/.test(text[keyEnd] ?? '')))) {
      out += `${text.slice(last, keyEnd)}***`
      last = text.length
      break
    }
    // No separator: the identifier is matched whole anyway, so the scan never restarts inside it (`a'a'a'…` stays linear).
    if (!sep) continue
    // Prose (`secret sauce`): a bare space only separates a CLI flag from its value.
    if (!/[=:]/.test(sep) && !dash) continue
    // A key with a substitution or variable piece may name a credential once the shell expands it: fail closed.
    if (!computedStart && !DYNAMIC_KEY_PIECE_RE.test(key) && !isCredentialKey(key)) continue
    const valueStart = m.index + head.length
    // A bare `Authorization: <scheme> <credential>` header is `AUTH_HDR_RE`'s (decided before scanning the value).
    if (/authorization$/i.test(key) && /^:\s*$/.test(sep) && !/^\$?["']/.test(text.slice(valueStart, valueStart + 2))) continue
    const query = /[?&]/.test(text[m.index - 1] ?? '') && sep === '='
    // A URL query parameter's value ends at the next `&` or `#` inside its shell word (`?token=foo'bar&x=1` passes
    // `foobar`). The URL's word end is shared by its parameters, so many parameters still scan it once.
    const wordEnd = query && valueStart < queryWordEnd ? queryWordEnd : shellWordEnd(text, valueStart, quoteAt(valueStart), closeOf)
    if (query) queryWordEnd = wordEnd
    const queryCut = query ? text.slice(valueStart, wordEnd).search(/[&#]/) : -1
    let valueEnd = queryCut === -1 ? wordEnd : valueStart + queryCut
    // An `Authorization` header `AUTH_HDR_RE` cannot read (`Authorization : Basic x`, `'Authoriz'ation': Basic x`): its
    // scheme word and the credential after it are masked together.
    if (!query && sep.includes(':') && /authorization$/i.test(dequote(key)) && AUTH_SCHEME_WORD_RE.test(text.slice(valueStart, valueEnd))) {
      AUTH_SCHEME_GAP_RE.lastIndex = valueEnd
      if (AUTH_SCHEME_GAP_RE.exec(text)) valueEnd = shellWordEnd(text, AUTH_SCHEME_GAP_RE.lastIndex, quoteAt(AUTH_SCHEME_GAP_RE.lastIndex), closeOf)
    }
    const value = text.slice(valueStart, valueEnd)
    const inner = shellWordInner(value)
    const quoted = /["']/.test(value)
    // Nothing to mask: empty or already masked.
    if (!inner.trim() || inner === '***') continue
    // `ENV_RE` masks an unquoted upper-case `KEY=value` it covers when the whole value is one plain `\S+` token.
    if (!quoted && sep.includes('=') && !sep.includes('+') && key === key.toUpperCase() && !/["'\\$`]/.test(key) && ENV_KEY_NAME_RE.test(key) && /[A-Za-z0-9]/.test(inner) && /^[^\s\\]+$/.test(value)) continue
    // Fully masked: a partial mask would leak part of a password or passphrase.
    out += text.slice(last, valueStart) + (/^[[{(]/.test(value) ? '***' : maskShellWord(value))
    last = valueEnd
    CRED_PARAM_RE.lastIndex = Math.max(valueEnd, CRED_PARAM_RE.lastIndex)
  }
  return out + text.slice(last)
}

/**
 * `curl -u user:secret` (also `-uuser:secret`, `--user user:secret`, `-U` / `--proxy-user`): the whole argument is read
 * with the shell-word scanner, and everything after its first `:` is masked. A single quoted pair keeps its quotes
 * (`"bob:***"`).
 */
function redactUserFlags(text: string): string {
  let out = ''
  let last = 0
  const quoteAt = quoteTracker(text)
  const closeOf = enclosingClose(text)
  USER_FLAG_RE.lastIndex = 0
  for (let m = USER_FLAG_RE.exec(text); m; m = USER_FLAG_RE.exec(text)) {
    const wordStart = m.index + m[0].length
    const wordEnd = shellWordEnd(text, wordStart, quoteAt(wordStart), closeOf)
    const word = text.slice(wordStart, wordEnd)
    // One quoted pair (`"bob:pw"`) is split inside its quotes; otherwise the word's first `:` separates user and secret
    // (`'bob':'pw'`, `bob:'pw'`).
    const quoted = splitQuoted(word)
    const body = quoted ? quoted.inner : word
    const colon = body.indexOf(':')
    // No literal `:`, but an expansion may supply it (`bob${SEP}hunter2`): literal text after it may be the password.
    const at = colon === -1 ? firstExpansion(word) : -1
    if (at >= 0 && expansionEnd(word, at) < word.length) {
      out += `${text.slice(last, wordStart)}${word.slice(0, at)}***`
      last = wordEnd
      USER_FLAG_RE.lastIndex = Math.max(wordEnd, USER_FLAG_RE.lastIndex)
      continue
    }
    const secret = colon === -1 ? '' : body.slice(colon + 1)
    if (!secret || secret === '***' || shellWordInner(secret) === '***') continue
    const masked = quoted ? `${quoted.open}${body.slice(0, colon + 1)}***${quoted.close}` : `${body.slice(0, colon + 1)}${maskShellWord(secret)}`
    out += text.slice(last, wordStart) + masked
    last = wordEnd
    USER_FLAG_RE.lastIndex = Math.max(wordEnd, USER_FLAG_RE.lastIndex)
  }
  return out + text.slice(last)
}

/**
 * Header credentials (`AUTH_HDR_RE`, `BEARER_RE`: a head group, then the credential). A parameterized credential is masked
 * whole; a single credential is read to the end of its shell word, so an adjacent quoted piece (`Bearer foo'bar`, which
 * the shell passes as `foobar`) is masked with it.
 */
function redactHeaderCredentials(text: string, re: RegExp): string {
  let out = ''
  let last = 0
  const quoteAt = quoteTracker(text)
  const closeOf = enclosingClose(text)
  re.lastIndex = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const [whole, head = '', token = ''] = m
    const start = m.index + head.length
    const matchEnd = m.index + whole.length
    let masked: string
    let end = matchEnd
    if (/^[A-Za-z0-9_-]+=/.test(token)) masked = '***'
    else {
      end = Math.max(matchEnd, shellWordEnd(text, start, quoteAt(start), closeOf))
      masked = end === matchEnd && !/["'\\]/.test(token) ? mask(token) : maskShellWord(text.slice(start, end))
    }
    out += text.slice(last, start) + masked
    last = end
    re.lastIndex = Math.max(end, re.lastIndex)
  }
  return out + text.slice(last)
}

/** Stands in for a quoted or escaped space in a dequoted word, so the rules read it as part of one token. */
const WORD_SPACE = '\u2423'

/**
 * A shell word as the program receives it: quotes and `$` quote prefixes removed, escapes resolved (ANSI-C escapes
 * decoded), and a quoted or escaped space kept inside the token as `WORD_SPACE`.
 */
/** An ANSI-C `$'…'` escape after its backslash (at `j`): the character Bash decodes and how many characters it spans. */
function ansiEscape(word: string, j: number): [string, number] {
  const c = word[j]!
  const named: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }
  if (named[c] !== undefined) return [named[c], 1]
  const hex = (max: number): string => /^[0-9A-Fa-f]+/.exec(word.slice(j + 1, j + 1 + max))?.[0] ?? ''
  if (c === 'x' || c === 'u' || c === 'U') {
    const digits = hex(c === 'x' ? 2 : c === 'u' ? 4 : 8)
    if (digits) return [String.fromCodePoint(Math.min(parseInt(digits, 16), 0x10ffff)), 1 + digits.length]
  }
  const octal = /^[0-7]{1,3}/.exec(word.slice(j, j + 3))?.[0]
  if (octal) return [String.fromCharCode(parseInt(octal, 8) & 0xff), octal.length]
  if (c === 'c' && j + 1 < word.length) return [String.fromCharCode(word.charCodeAt(j + 1) & 0x1f), 2]
  return [`\\${c}`, 1]
}

function shellDequote(word: string): string {
  let out = ''
  let quote = ''
  for (let i = 0; i < word.length; i += 1) {
    const c = word[i]!
    // ANSI-C `$'…'`: escapes are decoded (`\x3d` is `=`), so an escaped key name or delimiter reads as the program's.
    if (!quote && c === '$' && word[i + 1] === "'") {
      for (i += 2; i < word.length && word[i] !== "'"; i += 1) {
        let ch = word[i]!
        if (ch === '\\' && i + 1 < word.length) {
          const [decoded, span] = ansiEscape(word, i + 1)
          ch = decoded
          i += span
        }
        out += /\s/.test(ch) ? WORD_SPACE : ch
      }
      continue
    }
    if (!quote && c === '$' && word[i + 1] === '"') continue
    if (!quote && (c === "'" || c === '"')) quote = c
    else if (quote && c === quote) quote = ''
    else if (c === '\\' && quote !== "'" && i + 1 < word.length) {
      i += 1
      const escaped = word[i]!
      // A line continuation (`\` then a newline) is removed, joining the word's pieces.
      if (escaped !== '\n') out += /\s/.test(escaped) ? WORD_SPACE : escaped
    } else out += quote && /\s/.test(c) ? WORD_SPACE : c
  }
  return out
}

/** A text's word tokens, counted. */
function tokenCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of text.split(/[^\p{L}\p{N}_]+/u)) if (token) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

/** Whether `got` shows a whole token of `plain` more often than `wanted` does: a credential the rules masked in `wanted` survives. */
function revealsMore(plain: string, got: string, wanted: string): boolean {
  const source = tokenCounts(plain)
  const allowed = tokenCounts(wanted)
  for (const [token, count] of tokenCounts(got)) if (source.has(token) && count > (allowed.get(token) ?? 0)) return true
  return false
}

/** The index of a shell word's first parameter or command expansion outside single and ANSI-C quotes (`-1` if none). */
function firstExpansion(word: string, from = 0): number {
  let quote = ''
  for (let i = from; i < word.length; i += 1) {
    const c = word[i]!
    if (quote === "'") { if (c === "'") quote = ''; continue }
    if (c === '\\') { i += 1; continue }
    if (!quote && c === '$' && word[i + 1] === "'") {
      for (i += 2; i < word.length && word[i] !== "'"; i += word[i] === '\\' ? 2 : 1);
      continue
    }
    if (c === '"') quote = quote ? '' : '"'
    else if (!quote && c === "'") quote = "'"
    else if (c === '`' || (c === '$' && /[({A-Za-z_0-9@*#?$!-]/.test(word[i + 1] ?? ''))) return i
  }
  return -1
}

/**
 * A word whose expansion may supply a delimiter, masked from where the expansion could reveal a credential: after a
 * credential key (`--password"${SEP}"hunter2`), or in a URL's authority after a `:` and non-port text
 * (`https://bob:hunter2${AT}host`). `null` when neither applies (`$HOST:8080`, `$USER:$PASS@host`, `--token-file=$HOME`).
 */
function redactExpansionWord(word: string, at: number): string | null {
  // Only a quoted expansion after the key: an unquoted one is the computed-key rules' (`--password${SEP}x`).
  const before = shellDequote(word.slice(0, at)).replaceAll(WORD_SPACE, ' ')
  const key = /(?:^|[^A-Za-z0-9_.[\]-])-{0,2}([A-Za-z0-9_][A-Za-z0-9_.[\]-]*)[=:]?$/.exec(before)
  if (key && /["']/.test(word.slice(0, at)) && isCredentialKey(key[1]!)) return `${word.slice(0, at)}***`
  const url = /:\/\/([^\s/]*)/.exec(word)
  if (!url) return expansionBeforeAt(word)
  const authEnd = url.index + url[0].length
  const authStart = authEnd - url[1]!.length
  const inAuthority = firstExpansion(word.slice(authStart, authEnd))
  if (inAuthority < 0) return expansionBeforeAt(word)
  const expansion = authStart + inAuthority
  const colon = word.lastIndexOf(':', expansion - 1)
  if (colon >= authStart && /[^0-9]/.test(word.slice(colon + 1, expansion))) return `${word.slice(0, colon + 1)}***${word.slice(authEnd)}`
  // The expansion may supply the user/password `:` itself (`bob${SEP}hunter2@host`): static text between it and a later
  // `@` or expansion may be a password (`$HOST:8080`, `$SUB.example.com` and `${U}:${P}@` hold none).
  const after = expansionEnd(word, expansion)
  const stop = word.slice(after, authEnd).search(/\\?@|\$[({A-Za-z_0-9@*#?$!-]|`/)
  if (stop <= 0 || !/[^:]/.test(word.slice(after, after + stop))) return expansionBeforeAt(word)
  return word[after + stop] === '$' || word[after + stop] === '`' ? `${word.slice(0, expansion)}***${word.slice(authEnd)}` : `${word.slice(0, expansion)}***${word.slice(after + stop)}`
}

/**
 * Literal text between a word's last expansion before its `@` and that `@` (`${SCHEME}${USER}hunter2@host`): the
 * expansions may supply the scheme and the user/password `:`, so it may be a password (`${U}:${P}@`, `$HOME/a@b` hold
 * none).
 */
function expansionBeforeAt(word: string): string | null {
  const atSign = word.search(/\\?@/)
  if (atSign <= 0) return null
  let last = -1
  for (let k = firstExpansion(word); k >= 0 && k < atSign; k = firstExpansion(word, expansionEnd(word, k))) last = k
  if (last < 0) return null
  const end = expansionEnd(word, last)
  const segment = word.slice(end, atSign)
  if (!segment || !/[^:]/.test(segment) || /[\s/]/.test(segment)) return null
  // A literal `:` in it separates a visible user from the password (`${SCHEME}bob:hunter2@`).
  const keep = end + segment.indexOf(':') + 1
  return `${word.slice(0, keep)}***${word.slice(atSign)}`
}

/** The end (exclusive) of the parameter or command expansion starting at `i`. */
function expansionEnd(word: string, i: number): number {
  const next = word[i + 1] ?? ''
  const close = (c: string, from: number): number => { const k = word.indexOf(c, from); return k === -1 ? word.length : k + 1 }
  if (word[i] === '`') return close('`', i + 1)
  if (next === '{') return close('}', i + 2)
  if (next === '(') {
    let depth = 0
    for (let k = i + 1; k < word.length; k += 1) {
      if (word[k] === '(') depth += 1
      else if (word[k] === ')' && --depth === 0) return k + 1
    }
    return word.length
  }
  if (/[A-Za-z_]/.test(next)) return i + 1 + (/^[A-Za-z0-9_]*/.exec(word.slice(i + 1))?.[0].length ?? 0)
  return i + 2
}

/**
 * Shell words whose quoting or escapes compose a delimiter, key or credential (`--password'='x`, `bob:pw'@'host`): each
 * is redacted as the program receives it. When the word as written, once redacted, still shows a token the dequoted
 * redaction masks, the redacted dequoted form replaces it, so no quoting variant hides a credential from the rules. A
 * quoted flag is read with the value word after it (`'--password' x`). A single quoted argument and a data container
 * (JSON, a Python repr) are not composed words and keep their quoting. A word with an expansion is not what the program
 * receives once dequoted: it fails closed where the expansion may supply a delimiter (`redactExpansionWord`), and a
 * substitution is otherwise the computed-key rules'.
 */
function redactComposedWords(text: string): string {
  if (!/["'\\$`]/.test(text)) return text
  const closeOf = enclosingClose(text)
  const words: [start: number, end: number][] = []
  for (let i = 0; i < text.length; ) {
    if (/\s/.test(text[i]!)) { i += 1; continue }
    const end = Math.max(i + 1, shellWordEnd(text, i, '', closeOf))
    words.push([i, end])
    i = end
  }
  let out = ''
  let last = 0
  for (let k = 0; k < words.length; k += 1) {
    const [start, end] = words[k]!
    const word = text.slice(start, end)
    if (/^[[{(]/.test(word)) continue
    const at = firstExpansion(word)
    const expanded = at >= 0 ? redactExpansionWord(word, at) : null
    if (expanded !== null) {
      out += text.slice(last, start) + expanded
      last = end
      continue
    }
    if (!/["'\\]/.test(word) || /\$[({]|`/.test(word)) continue
    const glued = shellDequote(word)
    // A quoted flag (`'--password'`, `"--us"er`) takes its value from the next word: the two are read together.
    const next = words[k + 1]
    const flag = /^-[^=:]*$/.test(glued) && next !== undefined && /^[ \t]+$/.test(text.slice(end, next[0]))
    // A single quoted argument keeps its quoting, unless it is ANSI-C quoted with escapes (`$'--password\x3dx'`).
    if (!flag && (!/["'\\]/.test(word.slice(1)) || (splitQuoted(word) && !/\$'[^']*\\/.test(word)))) continue
    const spanEnd = flag ? next[1] : end
    const span = text.slice(start, spanEnd)
    const unit = flag ? `${glued} ${shellDequote(text.slice(next[0], next[1]))}` : glued
    // The leak check reads quoted spaces as spaces (prose apostrophes pair up across words); the replacement keeps them
    // inside the token, so a quoted value is masked whole.
    const plain = unit.replaceAll(WORD_SPACE, ' ')
    const wanted = redactRules(plain)
    if (wanted === plain) continue
    const asWritten = shellDequote(redactRules(span)).replaceAll(WORD_SPACE, ' ')
    if (!revealsMore(plain, asWritten, wanted)) continue
    out += text.slice(last, start) + redactRules(unit).replaceAll(WORD_SPACE, ' ')
    last = spanEnd
    if (flag) k += 1
  }
  return out + text.slice(last)
}

/**
 * `NAME=` at a word start: an assignment wherever the shell may read one (after `;`, `{`, `then`, `export`, as a prefix
 * …). Reading more assignments than the shell runs only adds masks.
 */
const ASSIGNMENT_RE = /(?<![^\s;&|(){}!\x60])([A-Za-z_][A-Za-z0-9_]*)(\+?)=/g
/** `$NAME` or `${NAME}`; a parameter operator (`${NAME:-x}`, `${#NAME}`) is not a plain reference. */
const VAR_REF_RE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/y
const VAR_REFS_RE = new RegExp(VAR_REF_RE.source, 'g')
/** Blanks before the next word. */
const BLANK_RUN_RE = /[ \t]+(?=\S)/y
/** A builtin that takes `NAME=value` operands, quoted ones included (`export "KEY=x"`). */
const ASSIGNMENT_BUILTIN_RE = /(?<![^\s;&|(){}!\x60])(?:export|declare|typeset|readonly|local)(?=[ \t])/g

/** The end of the `$NAME` / `${NAME}` reference at `at`. */
const VAR_REF_END = (text: string, at: number): number => {
  VAR_REF_RE.lastIndex = at
  return VAR_REF_RE.exec(text) ? VAR_REF_RE.lastIndex : at + 1
}

/** An assignment the text makes: its value word, and from `at` on, `$name` is `value` (`undefined` once the shell computes it). */
interface Assignment { name: string; start: number; end: number; at: number; value: string | undefined; template?: string }

/**
 * The end of an assignment's value word, and whether it is literal (bare, quoted and escaped pieces) or a template that
 * also holds plain references (`$OPT`, `"${A}x"`). Any other expansion, a substitution or an unterminated quote makes it
 * neither, and the scan stops there, so no value is scanned twice.
 */
function assignedWord(text: string, start: number): { end: number; literal: boolean; template: boolean } {
  const unknown = (end: number): { end: number; literal: boolean; template: boolean } => ({ end, literal: false, template: false })
  if (text[start] === '(') return unknown(start)
  let template = false
  let i = start
  while (i < text.length) {
    const c = text[i]!
    if (/[\s;&|<>()]/.test(c)) break
    if (c === '\\') i += 2
    else if (c === '$' && text[i + 1] === "'") {
      let k = i + 2
      while (k < text.length && text[k] !== "'") k += text[k] === '\\' ? 2 : 1
      if (k >= text.length) return unknown(i)
      i = k + 1
    } else if (c === '$' || c === '`') {
      VAR_REF_RE.lastIndex = i
      if (c === '`' || !VAR_REF_RE.exec(text)) return unknown(i)
      template = true
      i = VAR_REF_RE.lastIndex
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1)
      if (close === -1) return unknown(i)
      i = close + 1
    } else if (c === '"') {
      let k = i + 1
      while (k < text.length && text[k] !== '"') {
        if (text[k] === '`') return unknown(k)
        if (text[k] === '$') {
          VAR_REF_RE.lastIndex = k
          if (!VAR_REF_RE.exec(text)) return unknown(k)
          template = true
          k = VAR_REF_RE.lastIndex
        } else k += text[k] === '\\' ? 2 : 1
      }
      if (k >= text.length) return unknown(i)
      i = k + 1
    } else i += 1
  }
  return { end: Math.min(i, text.length), literal: !template, template }
}

/**
 * A template value (`"${A}x"`) with its references replaced through `lookup`, dequoted; `undefined` when a reference is
 * unknown or the value grows past `cap`.
 */
function expandTemplate(word: string, lookup: (name: string) => string | undefined, cap: number): string | undefined {
  let out = ''
  let last = 0
  let quote = ''
  for (let i = 0; i < word.length; i += 1) {
    const c = word[i]!
    if (c === '\\') i += 1
    else if (!quote && c === "'") i = Math.max(i, word.indexOf("'", i + 1))
    else if (!quote && c === '$' && word[i + 1] === "'") for (i += 2; i < word.length && word[i] !== "'"; i += word[i] === '\\' ? 2 : 1);
    else if (c === '"') quote = quote ? '' : '"'
    else if (c === '$') {
      VAR_REF_RE.lastIndex = i
      const ref = VAR_REF_RE.exec(word)
      const value = ref ? lookup(ref[1] ?? ref[2]!) : undefined
      if (value === undefined || out.length + value.length > cap) return undefined
      out += word.slice(last, i) + substitutedWord(value, quote)
      last = VAR_REF_RE.lastIndex
      i = last - 1
    }
  }
  return shellDequote(out + word.slice(last)).replaceAll(WORD_SPACE, ' ')
}

/**
 * The assignments (`NAME=value`) outside quotes, in text order. A value is one shell word, dequoted, or a template of
 * plain references; one with another expansion, a substitution or an append (`+=`) is unknown. One pass.
 */
function inlineAssignments(text: string): Assignment[] {
  const found: Assignment[] = []
  const quoteAt = quoteTracker(text)
  ASSIGNMENT_RE.lastIndex = 0
  for (let m = ASSIGNMENT_RE.exec(text); m; m = ASSIGNMENT_RE.exec(text)) {
    const start = m.index + m[0].length
    // An assignment inside a quoted argument, or after an escaped separator (`A=foo\;B=x` is one word), is text.
    if (quoteAt(m.index)) continue
    let escapes = 0
    for (let k = m.index - 2; k >= 0 && text[k] === '\\'; k -= 1) escapes += 1
    if (escapes % 2) continue
    const { end, literal, template } = assignedWord(text, start)
    const word = text.slice(start, end)
    // An append (`OPT+=u`) is a template of the previous value and the word.
    if (!literal && !template) found.push({ name: m[1]!, start, end, at: start, value: undefined })
    else if (m[2]) found.push({ name: m[1]!, start, end, at: end, value: undefined, template: `\${${m[1]!}}${word}` })
    else found.push({ name: m[1]!, start, end, at: end, value: literal ? shellDequote(word).replaceAll(WORD_SPACE, ' ') : undefined, ...(template ? { template: word } : {}) })
  }
  // A quoted operand of an assignment builtin (`export "KEY=--password"`) is an assignment too; the whole operand is its
  // value word.
  const closeOf = enclosingClose(text)
  const builtinAt = quoteTracker(text)
  ASSIGNMENT_BUILTIN_RE.lastIndex = 0
  for (let m = ASSIGNMENT_BUILTIN_RE.exec(text); m; m = ASSIGNMENT_BUILTIN_RE.exec(text)) {
    if (builtinAt(m.index)) continue
    let i = m.index + m[0].length
    for (;;) {
      while (text[i] === ' ' || text[i] === '\t') i += 1
      if (i >= text.length || /[;&|<>()\n#]/.test(text[i]!)) break
      const end = Math.max(i + 1, shellWordEnd(text, i, '', closeOf))
      const word = text.slice(i, end)
      const operand = /^\$?["']/.test(word) ? /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=([\s\S]*)$/.exec(shellDequote(word).replaceAll(WORD_SPACE, ' ')) : null
      if (operand && firstExpansion(word) >= 0) found.push({ name: operand[1]!, start: i, end, at: i, value: undefined })
      else if (operand?.[2]) found.push({ name: operand[1]!, start: i, end, at: end, value: undefined, template: `\${${operand[1]!}}${substitutedWord(operand[3]!, '')}` })
      else if (operand) found.push({ name: operand[1]!, start: i, end, at: end, value: operand[3] })
      i = end
    }
    ASSIGNMENT_BUILTIN_RE.lastIndex = Math.max(i, ASSIGNMENT_BUILTIN_RE.lastIndex)
  }
  return found.sort((a, b) => a.start - b.start)
}

/** The text with each shell comment (`#` at a word start, outside quotes, to the line end) replaced by spaces. */
function blankComments(text: string): string {
  let out = ''
  let last = 0
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!
    if (c === '\\' && quote !== "'") i += 1
    else if (quote) { if (c === quote.slice(-1)) quote = '' }
    else if (c === "'" || c === '"') quote = text[i - 1] === '$' && c === "'" ? "$'" : c
    else if (c === '#' && /^[\s;&|()]?$/.test(text[i - 1] ?? '')) {
      const end = text.indexOf('\n', i)
      const stop = end === -1 ? text.length : end
      out += text.slice(last, i) + ' '.repeat(stop - i)
      last = i = stop
    }
  }
  return last ? out + text.slice(last) : text
}

/**
 * A substituted value as the shell passes it: escaped inside `"…"`; outside, split into fields at blanks, each field
 * single-quoted unless it is plain.
 */
function substitutedWord(value: string, quote: string): string {
  if (quote) return value.replace(/["\\$`]/g, '\\$&')
  return value.split(/[ \t\n]+/).filter(Boolean).map((field) => (/^[\w.:/@%+,=-]*$/.test(field) ? field : `'${field.replaceAll("'", `'\\''`)}'`)).join(' ')
}

/** A substituted value's place in the expanded text, the assignment that defined it, and the value. */
type Span = [start: number, end: number, assignment: number, value: string]

/**
 * The text with each `$NAME` / `${NAME}` replaced by a value assigned to it earlier, outside single and ANSI-C quotes,
 * as the shell expands it, and where each substituted value sits in it. `pick` chooses among the name's assignments so
 * far (in text order, an unknown one included) and returns `-1` to leave the reference as written, as unknown names and
 * parameter operators are. One pass. A substitution past the size cap (a long value referenced many times) is left as
 * written, and its assignment is reported, as is each reference to a `watch`ed name.
 */
function expandAssignments(text: string, assignments: Assignment[], pick: (name: string, history: number[]) => number, watch = new Set<string>()): { expanded: string; spans: Span[]; overflow: Set<number>; watched: number[] } {
  const spans: Span[] = []
  const watched: number[] = []
  const overflow = new Set<number>()
  const history = new Map<string, number[]>()
  const cap = text.length * 2 + 4096
  // A template's value is resolved in this view when it takes effect.
  const resolved = new Map<number, string | undefined>()
  // ponytail: templates share one size budget; past it a template is unknown.
  let templateBudget = cap
  const valueOf = (n: number): string | undefined => (assignments[n]!.template === undefined ? assignments[n]!.value : resolved.get(n))
  let next = 0
  let quote = ''
  let out = ''
  let last = 0
  for (let i = 0; i < text.length; i += 1) {
    for (; next < assignments.length && assignments[next]!.at <= i; next += 1) {
      const { name, template } = assignments[next]!
      if (template !== undefined) {
        const value = expandTemplate(template, (ref) => { const refs = history.get(ref); const n = refs ? pick(ref, refs) : -1; return n >= 0 ? valueOf(n) : undefined }, templateBudget)
        templateBudget -= value?.length ?? 0
        resolved.set(next, value)
      }
      const past = history.get(name)
      if (past) past.push(next)
      else history.set(name, [next])
    }
    const c = text[i]!
    if (c === '\\') i += 1
    else if (!quote && c === "'") {
      const close = text.indexOf("'", i + 1)
      if (close === -1) break
      i = close
    } else if (!quote && c === '$' && text[i + 1] === "'") {
      for (i += 2; i < text.length && text[i] !== "'"; i += text[i] === '\\' ? 2 : 1);
    } else if (c === '"') quote = quote ? '' : '"'
    else if (c === '$') {
      VAR_REF_RE.lastIndex = i
      const ref = VAR_REF_RE.exec(text)
      const name = ref ? ref[1] ?? ref[2]! : ''
      if (watch.has(name)) watched.push(i)
      const assignment = ref && history.has(name) ? pick(name, history.get(name)!) : -1
      const value = assignment < 0 ? undefined : valueOf(assignment)
      if (value === undefined) continue
      const word = out.length + value.length > cap ? '' : substitutedWord(value, quote)
      if (!word && value) {
        overflow.add(assignment)
        continue
      }
      out += text.slice(last, i)
      spans.push([out.length, out.length + word.length, assignment, value])
      out += word
      last = VAR_REF_RE.lastIndex
      i = last - 1
    }
  }
  return { expanded: out + text.slice(last), spans, overflow, watched }
}

/** A word, and a shell-word unit (a run between shell and URL delimiters, `hunter2!!!`); `*` is a mask's. */
const SECRET_WORD_RE = /[\p{L}\p{N}_]+/gu
const SECRET_UNIT_RE = /[^\s'"`$\\=:@/;&|<>(){}[\],*]+/gu
const HAS_SECRET_UNIT_RE = new RegExp(SECRET_UNIT_RE.source, 'u')

/** A text's words and units, counted together. */
function secretTokenCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const re of [SECRET_WORD_RE, SECRET_UNIT_RE]) for (const [token] of text.matchAll(re)) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

/**
 * Threat model: the redactor reads only the tool's text. Variables the text itself assigns (`SEP=:; curl -u bob${SEP}x`)
 * are resolved in text order; shell control flow (conditionals, loops, functions, `read`, `unset`) is not modelled.
 * Variables from the environment or from earlier tool calls are unknown: the fail-closed rules (computed key tails, `-u`
 * expansions, URL authorities built from expansions) are the only guard for them, and a secret assembled entirely from
 * unknown variables can still be published.
 */
export function redactSensitive(text: string): string {
  if (!text) return text
  // Line continuations join their lines as the shell runs them (`--user \⏎ bob:pw`, `--pass\⏎word=x`): that view is
  // redacted, and a text with nothing to mask keeps its lines as written.
  const joined = text.replace(/\\\r?\n/g, '')
  const out = redactRules(redactComposedWords(joined))
  const redacted = joined !== text && out === joined ? text : out
  if (!joined.includes('=') || !joined.includes('$')) return redacted
  // The views with the text's own assignments resolved only add masks to the redaction above, which keeps its own
  // fail-closed masks (an assignment the shell never runs, `false && KEY=x`, can unmask nothing): the whole value of an
  // assignment whose substitution a view masks, and every word and unit a view masks, wherever it appears.
  // Comments are blanked, keeping every position, so a quote in one (`# don't`) cannot hide what follows.
  const code = blankComments(joined)
  const assignments = inlineAssignments(code)
  const secretAssignments = new Set<number>()
  const secrets = new Set<string>()
  const delimiterSecrets = new Set<string>()
  const secretValues = new Set<string>()
  // Control flow is not modelled, so a reassigned name may hold any of its values, or an unknown one (`OPT=-u; false &&
  // OPT=echo`, `false && OPT=$(x)`). Besides the latest values, each combination of the reassigned names' values gets a
  // view: from its first assignment on, a name holds the chosen value.
  // Candidates are told apart by literal value, template text, or being unknown.
  const byName = new Map<string, Map<string, number>>()
  for (const [n, { name, value, template }] of assignments.entries()) {
    const values = byName.get(name) ?? new Map<string, number>()
    const key = value !== undefined ? `=${value}` : template !== undefined ? `$${template}` : '?'
    if (!values.has(key)) values.set(key, n)
    byName.set(name, values)
  }
  const reassigned = [...byName].filter(([, values]) => values.size > 1)
  // ponytail: past 8 combinations (2 in a text over 50k characters, to keep redaction fast), a word with a reassigned
  // name's reference fails closed instead.
  const budget = joined.length > 50_000 ? 2 : 8
  let combinations: Map<string, number>[] = [new Map<string, number>()]
  for (const [name, values] of reassigned) {
    combinations = combinations.flatMap((chosen) => [...values.values()].map((n) => new Map(chosen).set(name, n)))
    if (combinations.length > budget) break
  }
  const latest = (_: string, history: number[]): number => history.at(-1)!
  const views = [latest]
  const failClosed = combinations.length > budget
  if (reassigned.length && !failClosed) for (const chosen of combinations) views.push((name, history) => { const n = chosen.get(name); return n !== undefined && history.at(-1)! >= n ? n : history.at(-1)! })
  // Failing closed watches the reassigned names and, in text order, every name whose template refers to a watched one
  // (`ARG=$OPT`).
  // A name the text computes (`OPT=$(printf -- -u)`) is always watched.
  const watchedNames = new Set(failClosed ? reassigned.map(([name]) => name) : [])
  for (const { name, value, template } of assignments) if (value === undefined && template === undefined) watchedNames.add(name)
  if (watchedNames.size) for (const { name, template } of assignments) if (template !== undefined && [...template.matchAll(VAR_REFS_RE)].some((ref) => watchedNames.has(ref[1] ?? ref[2]!))) watchedNames.add(name)
  // Ranges of the text masked before redaction: secret assignment values, and words that fail closed.
  const masks: [start: number, end: number][] = []
  for (const [v, pick] of views.entries()) {
    const { expanded, spans, overflow, watched } = expandAssignments(code, assignments, pick, v === 0 ? watchedNames : undefined)
    // A reference to a watched name is masked to the end of its word, and a whole-word one with the next word
    // (`$OPT bob:hunter2`, `-H "${H}: x"`).
    if (watched.length) {
      const quoteAt = quoteTracker(code)
      const closeOf = enclosingClose(code)
      for (const at of watched) {
        const quote = quoteAt(at)
        let end = shellWordEnd(code, at, quote, closeOf)
        if (quote && code[end] === quote.slice(-1)) end += 1
        // A word of references and quotes only (`$OPT`, `"$OPT"`, `$A$B`) may be an option that takes the next word.
        if (/(?:^|\s)\$?["']*$/.test(code.slice(Math.max(0, at - 4), at)) && /^(?:["']|\$\{[A-Za-z_]\w*\}|\$[A-Za-z_]\w*)*$/.test(code.slice(VAR_REF_END(code, at), end))) {
          BLANK_RUN_RE.lastIndex = end
          if (BLANK_RUN_RE.exec(code)) end = shellWordEnd(code, BLANK_RUN_RE.lastIndex, '', closeOf)
        }
        // A reference inside the previous mask extends it (`$OPT $OPT2 bob:hunter2`).
        const previous = masks.at(-1)
        if (previous && at < previous[1] && previous[0] <= at) previous[1] = Math.max(previous[1], end)
        else masks.push([at, end])
      }
    }
    // Past the expansion cap, a value is taken as a secret.
    for (const n of overflow) secretAssignments.add(n)
    if (!spans.length) continue
    const view = redactRules(redactComposedWords(expanded))
    const shown = secretTokenCounts(view)
    const found = new Set<string>()
    for (const [token, count] of secretTokenCounts(expanded)) if (count > (shown.get(token) ?? 0)) found.add(token)
    // A masked unit that a substitution built (`P=hunt; …${P}er2`) masks its value's assignment, and its literal pieces.
    let k = 0
    for (const m of expanded.matchAll(SECRET_UNIT_RE)) {
      if (!found.has(m[0])) continue
      const end = m.index + m[0].length
      while (k < spans.length && spans[k]![1] <= m.index) k += 1
      // A piece after an unbraced reference reads as one unit with its name (`$P!!!`).
      let cut = m.index
      let name = ''
      for (let j = k; j < spans.length && spans[j]![0] < end; j += 1) {
        const piece = expanded.slice(cut, Math.max(spans[j]![0], m.index))
        if (piece) secrets.add(piece).add(name + piece)
        secretAssignments.add(spans[j]![2])
        secretValues.add(spans[j]![3])
        name = assignments[spans[j]![2]]!.name
        cut = Math.min(spans[j]![1], end)
      }
      if (cut > m.index && cut < end) secrets.add(expanded.slice(cut, end)).add(name + expanded.slice(cut, end))
    }
    for (const token of found) secrets.add(token)
    // A value of delimiters only (`P='@@@'`) has no unit to count: it is a secret when the view shows it fewer times,
    // counted as substituted, escapes included (`"$P"` with `P='$$$'` is `\$\$\$`). This fails closed on a delimiter a
    // masked credential also held (`SEP='='` beside `--token=x`).
    // ponytail: past 32 such values, each is taken as a secret rather than counted.
    const delimiterValues = new Map<string, boolean>()
    for (const [start, end, n, value] of spans) {
      const word = expanded.slice(start, end)
      if (!value || HAS_SECRET_UNIT_RE.test(value)) continue
      let secret = delimiterValues.get(word)
      if (secret === undefined) delimiterValues.set(word, (secret = delimiterValues.size >= 32 || expanded.split(word).length > view.split(word).length))
      if (secret) {
        secretAssignments.add(n)
        delimiterSecrets.add(value)
      }
    }
  }
  // A secret value is masked at every assignment of it, however spelled (`P=$'hunter\x32'`), and a delimiter-only one
  // wherever it stands as a whole word (`echo @@@`).
  for (const n of secretAssignments) {
    const { value } = assignments[n]!
    if (value !== undefined) secretValues.add(value)
  }
  for (const value of delimiterSecrets) secretValues.add(value)
  for (const [n, { value }] of assignments.entries()) if (value !== undefined && secretValues.has(value)) secretAssignments.add(n)
  secrets.delete('')
  if (!secrets.size && !secretAssignments.size && !masks.length && !delimiterSecrets.size) return redacted
  for (const [n, { start, end }] of assignments.entries()) if (secretAssignments.has(n)) masks.push([start, end])
  let base = out
  if (masks.length) {
    let masked = ''
    let last = 0
    for (const [start, end] of masks.sort((a, b) => a[0] - b[0])) {
      if (end <= last) continue
      const from = Math.max(start, last)
      masked += joined.slice(last, from) + maskShellWord(joined.slice(from, end))
      last = end
    }
    base = redactRules(redactComposedWords(masked + joined.slice(last)))
  }
  if (delimiterSecrets.size) base = base.replace(new RegExp(String.raw`(?<![^\s'"=])(?:${[...delimiterSecrets].map((value) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})(?![^\s'"])`, 'g'), '***')
  const masked = base.replace(SECRET_UNIT_RE, (unit) => (secrets.has(unit) ? '***' : unit.replace(SECRET_WORD_RE, (word) => (secrets.has(word) ? '***' : word))))
  return masked === out ? redacted : masked
}

function redactRules(text: string): string {
  if (!text) return text
  let out = maskControlSplitTokens(text).replace(CRED_RE, (_, t: string) => mask(t))
  out = out.replace(EMBEDDED_AWS_RE, (t) => mask(t))
  out = redactHeaderCredentials(out, AUTH_HDR_RE)
  out = out.replace(JWT_RE, (t) => mask(t))
  out = redactHeaderCredentials(out, BEARER_RE)
  for (const re of [COOKIE_ANSI_RE, COOKIE_SQ_RE, COOKIE_DQ_RE, COOKIE_BARE_RE]) out = out.replace(re, (whole, head: string, value: string) => (/[A-Za-z0-9]/.test(value) ? `${head}***` : whole))
  out = redactCredentialParams(out)
  out = out.replace(ENV_RE, (whole, key: string, quote: string, value: string) => (/[A-Za-z0-9]/.test(value) ? `${key}=${quote}${mask(value)}${quote}` : whole))
  const maskEnvSuffix = (whole: string, key: string, quote: string, value: string): string => (isEnvSecretAssignment(key, value) ? `${key}=${quote}${mask(value)}${quote}` : whole)
  out = out.replace(ENV_SUFFIX_RE, maskEnvSuffix)
  out = out.replace(ENV_SUFFIX_LOWER_RE, maskEnvSuffix)
  out = out.replace(LISTED_FLAG_RE, (whole, q: string, dash: string, key: string, gap: string, vq: string | undefined, quotedValue: string | undefined, bare: string | undefined) => {
    // An unquoted value (a number, `True`, a nested list) is masked whole.
    if (bare !== undefined) return bare !== '***' && (ARGV_USER_FLAG_RE.test(dash + key) || isCredentialKey(key)) ? `${q}${dash}${key}${q}${gap}***` : whole
    const value = quotedValue ?? ''
    if (!value || value === '***') return whole
    if (ARGV_USER_FLAG_RE.test(dash + key)) return value.includes(':') ? `${q}${dash}${key}${q}${gap}${vq}${value.replace(/:.*/s, ':***')}${vq}` : whole
    return isCredentialKey(key) ? `${q}${dash}${key}${q}${gap}${vq}***${vq}` : whole
  })
  out = out.replace(PERCENT_KEY_RE, (whole, head: string, value: string) => (value && value !== '***' && isCredentialKey(percentDecode(head.slice(0, -1))) ? `${head}***` : whole))
  out = out.replace(BARE_USERINFO_RE, (_, head: string, secret: string) => head + mask(secret))
  out = out.replace(URL_USERINFO_RE, (_, head: string, secret: string) => head + (/['"\\]/.test(secret) ? '***' : mask(secret)))
  out = out.replace(URL_BARE_TOKEN_RE, (_, head: string, token: string) => head + mask(token))
  out = out.replace(TELEGRAM_TOKEN_RE, (_, bot: string | undefined, id: string) => `${bot ?? ''}${id}:***`)
  out = out.replace(PHONE_RE, (phone) => { const keep = phone.length <= 8 ? 2 : 4; return `${phone.slice(0, keep)}****${phone.slice(-keep)}` })
  out = redactUserFlags(out)
  out = out.replace(QUERY_KEY_RE, (whole, head: string, value: string) => (/[A-Za-z0-9]/.test(value) ? head + mask(value) : whole))
  out = out.replace(PRIVKEY_RE, '[REDACTED PRIVATE KEY]').replace(PRIVKEY_OPEN_RE, '[REDACTED PRIVATE KEY]')
  return restoreCodeEnvKeyLiterals(text, out)
}

const CASE_MARKERS = [
  'sk-', 'ghp_', 'github_pat_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'AKIA', 'ASIA', 'xoxb-', 'xoxa-', 'xoxp-', 'xoxr-', 'xoxs-', 'AIza', 'pplx-', 'fal_', 'fc-',
  'bb_live_', 'gAAAA', 'sk_live_', 'sk_test_', 'rk_live_', 'SG.', 'hf_', 'r8_', 'npm_', 'pypi-', 'dop_v1_', 'doo_v1_', 'am_', 'sk_', 'tvly-', 'exa_',
  'gsk_', 'syt_', 'retaindb_', 'hsk-', 'mem0_', 'brv_', 'xapp-', 'xai-', 'ntn_', 'fw-', 'fw_', 'fpk_', 'glpat-', 'gloas-', 'gldt-', 'glrt-', 'glrtr-',
  'glcbt-', 'glptt-', 'glft-', 'glimt-', 'glagent-', 'glsoat-', 'glffct-', 'glwt-', 'GR1348941', 'pk-lf-', 'eyJ', '-----BEGIN',
]
const LOWER_MARKERS = [
  'authorization: bearer ', 'authorization: bot ', 'private key', 'postgres://', 'postgresql://', 'mysql://', 'mongodb://', 'redis://', 'amqp://', '://',
  'access_token', 'refresh_token', 'id_token', 'api_key', 'apikey', 'client_secret', 'auth_token', 'raw_secret', 'secret_input', 'key_material',
  'x-amz-signature', 'token=', 'secret=', 'password=', 'passwd', 'password', 'secret', 'token', 'api-key', 'apikey', 'clientsecret', 'private_key', 'credential', ' -u ', '--user ', 'authorization', 'signature', 'bearer ', 'cookie:', 'authorization=', 'key=', '"token"', '"secret"', '"password"', '"bearer"',
]
const DISCORD_RE = /<@!?\d{17,20}>/
const TELEGRAM_TEST_RE = new RegExp(TELEGRAM_TOKEN_RE.source)
const PHONE_TEST_RE = new RegExp(PHONE_RE.source)

export function mightContainSensitiveText(text: string): boolean {
  if (!text) return false
  // A control or zero-width character inside a prefix (`x\u200bai-…`) does not hide it: the redactor joins split tokens.
  const joined = text.replace(CONTROL_CHARS_RE, '')
  if (CASE_MARKERS.some((m) => joined.includes(m))) return true
  const lower = text.toLowerCase()
  if (LOWER_MARKERS.some((m) => lower.includes(m))) return true
  if (CRED_KEY_NAME_RE.test(text)) return true
  // A key or URL the shell assembles from pieces (`--pass'word'`, `https\:\/\/`) is recognizable only once dequoted.
  if (/["'\\]/.test(text)) {
    const plain = dequote(text)
    if (CRED_KEY_NAME_RE.test(plain) || plain.includes('://')) return true
  }
  if (/%[0-9A-Fa-f]{2}/.test(text) && CRED_KEY_NAME_RE.test(percentDecode(text))) return true
  if (text.includes('@') && new RegExp(BARE_USERINFO_RE.source).test(text)) return true
  if (DYNAMIC_KEY_PIECE_RE.test(text) || /\$[({A-Za-z_0-9@*#?$!'-]|`/.test(text)) return true
  if (USER_FLAG_TEST_RE.test(text)) return true
  if (text.includes(':') && TELEGRAM_TEST_RE.test(text)) return true
  if (text.includes('<@') && DISCORD_RE.test(text)) return true
  if (text.includes('+') && PHONE_TEST_RE.test(text)) return true
  if (text.includes('=') && ENV_SUFFIX_TEST_RES.some((re) => re.test(text))) return true
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
  // Structured results are redacted by key too (`{ result: { token } }`); text results keep the text redaction.
  for (const key of ['result', 'output'] as const) if (record[key] && typeof record[key] === 'object') out[key] = redactArgs(record[key], enabled)
  const fnArgs = record.function && typeof record.function === 'object' ? (record.function as Record<string, unknown>).arguments : undefined
  if (enabled && fnArgs !== undefined && out.function && typeof out.function === 'object') {
    // A JSON-string `arguments` is redacted as parsed args; an object-valued one (`ToolCallSchema` accepts any JSON) directly.
    if (typeof fnArgs !== 'string') out.function = { ...out.function, arguments: redactArgs(fnArgs, enabled) }
    else try { out.function = { ...out.function, arguments: JSON.stringify(redactArgs(JSON.parse(fnArgs), enabled)) } } catch { /* unparseable: the text redaction stands */ }
  }
  // The target is derived in the live order: the sidecar's snapshot (first four arguments, capped) before redaction.
  return { ...out, ...toolDisplay(toolName(record), redactArgs(snapshotArgs(toolArgs(record)), enabled)) } as T
}

/** Every non-empty scalar of a credential value masked, keeping its shape (`{ password: ['x'] }` → `['***']`). */
function maskLeaves(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskLeaves)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, maskLeaves(item)]))
  return (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') && String(value) !== '' ? '***' : value
}

/** An argv element that is a flag (`--password`), and one that takes `user:password` (`-u`, `--user`, `--proxy-user`). */
const ARGV_FLAG_RE = /^-{1,2}([A-Za-z0-9_][A-Za-z0-9_.-]*)$/
const ARGV_USER_FLAG_RE = /^(?:-[uU]|--user|--proxy-u(?:s(?:e(?:r)?)?)?)$/

/** The fields that name a header in a `{ name: 'Authorization', value }` record. */
const HEADER_LABEL_FIELDS = new Set(['name', 'key', 'header'])

/** Tool arguments redacted like any value, plus every scalar under a credential-named key (`{ password: 'x' }`). */
function redactArgs(value: unknown, enabled: boolean): unknown {
  if (!enabled) return value
  if (Array.isArray(value)) {
    // A `[name, value]` header tuple naming a credential.
    if (value.length === 2 && typeof value[0] === 'string' && isCredentialKey(value[0])) return [value[0], maskLeaves(value[1])]
    // An argv array (`['login', '--password', 'hunter2']`): a credential flag's value is the next element.
    return value.map((item, i) => {
      const flag: unknown = value[i - 1]
      if (typeof flag === 'string' && item !== '' && item !== null && item !== undefined) {
        if (ARGV_USER_FLAG_RE.test(flag)) return typeof item === 'string' ? item.replace(/:.*/s, ':***') : maskLeaves(item)
        const key = ARGV_FLAG_RE.exec(flag)?.[1]
        // Any value: a numeric password or a nested list is a credential too.
        if (key !== undefined && isCredentialKey(key)) return maskLeaves(item)
      }
      return redactArgs(item, enabled)
    })
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    // A `{ name: 'Authorization', value: ... }` pair (HAR and similar header lists).
    // Any label field naming a credential labels the value (`{ name: 'metadata', header: 'Authorization', value }`).
    const labelled = [...HEADER_LABEL_FIELDS].some((field) => typeof record[field] === 'string' && isCredentialKey(record[field]))
    // A labelled credential header masks every payload field (`value`, `values`, ...); its label fields stay.
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, isCredentialKey(key) || (labelled && !HEADER_LABEL_FIELDS.has(key)) ? maskLeaves(item) : redactArgs(item, enabled)]))
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

/** The open call a tool completion settles: the one with its Agent id, else the newest id-less call of the same name; -1 when none. */
export function completedToolIndex(calls: readonly Record<string, unknown>[], tid: string, name: unknown): number {
  const exact = tid ? calls.findLastIndex((call) => !call.done && call.tid === tid) : -1
  return exact >= 0 ? exact : calls.findLastIndex((call) => !call.done && !call.tid && call.name === name)
}

/** A tool frame carrying its public call `id` in place of the sidecar-internal `tid`. */
export function withToolId(data: Record<string, unknown>, id: string): Record<string, unknown> {
  const frame: Record<string, unknown> = { ...data, id }
  delete frame.tid
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
