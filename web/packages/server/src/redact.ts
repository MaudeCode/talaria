import { str } from './util.js'
import { snapshotArgs, toolArgs, toolDisplay, toolName } from './sessions/tool-display.js'
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
/** A JSON Web Token anywhere (`eyJ<header>.<payload>.<signature>`). */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g
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
const PRIVKEY_RE = /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g
/** A private key whose end marker is missing (a display cap cut it off): masked to the end of the text. */
const PRIVKEY_OPEN_RE = /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*$/
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

export function redactSensitive(text: string): string {
  if (!text) return text
  // Line continuations join their lines as the shell runs them (`--user \⏎ bob:pw`, `--pass\⏎word=x`): that view is
  // redacted, and a text with nothing to mask keeps its lines as written.
  const joined = text.replace(/\\\r?\n/g, '')
  const out = redactRules(redactComposedWords(joined))
  return joined !== text && out === joined ? text : out
}

function redactRules(text: string): string {
  if (!text) return text
  let out = text.replace(CRED_RE, (_, t: string) => mask(t))
  out = out.replace(EMBEDDED_AWS_RE, (t) => mask(t))
  out = redactHeaderCredentials(out, AUTH_HDR_RE)
  out = out.replace(JWT_RE, (t) => mask(t))
  out = redactHeaderCredentials(out, BEARER_RE)
  for (const re of [COOKIE_ANSI_RE, COOKIE_SQ_RE, COOKIE_DQ_RE, COOKIE_BARE_RE]) out = out.replace(re, (whole, head: string, value: string) => (/[A-Za-z0-9]/.test(value) ? `${head}***` : whole))
  out = redactCredentialParams(out)
  out = out.replace(ENV_RE, (whole, key: string, quote: string, value: string) => (/[A-Za-z0-9]/.test(value) ? `${key}=${quote}${mask(value)}${quote}` : whole))
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
  out = redactUserFlags(out)
  out = out.replace(QUERY_KEY_RE, (whole, head: string, value: string) => (/[A-Za-z0-9]/.test(value) ? head + mask(value) : whole))
  out = out.replace(PRIVKEY_RE, '[REDACTED PRIVATE KEY]').replace(PRIVKEY_OPEN_RE, '[REDACTED PRIVATE KEY]')
  return restoreCodeEnvKeyLiterals(text, out)
}

const CASE_MARKERS = [
  'sk-', 'ghp_', 'github_pat_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'AKIA', 'ASIA', 'xoxb-', 'xoxa-', 'xoxp-', 'xoxr-', 'xoxs-', 'AIza', 'pplx-', 'fal_', 'fc-',
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
  // A key or URL the shell assembles from pieces (`--pass'word'`, `https\:\/\/`) is recognizable only once dequoted.
  if (/["'\\]/.test(text)) {
    const plain = dequote(text)
    if (CRED_KEY_NAME_RE.test(plain) || plain.includes('://')) return true
  }
  if (/%[0-9A-Fa-f]{2}/.test(text) && CRED_KEY_NAME_RE.test(percentDecode(text))) return true
  if (text.includes('@') && new RegExp(BARE_USERINFO_RE.source).test(text)) return true
  if (DYNAMIC_KEY_PIECE_RE.test(text) || /\$[({A-Za-z_0-9@*#?$!'-]|`/.test(text)) return true
  if (USER_FLAG_TEST_RE.test(text)) return true
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
