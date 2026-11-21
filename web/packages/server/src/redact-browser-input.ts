/**
 * TAL-2299: a display copy of the code a `browser_exec` call ran, with every value it types into a page masked (the Agent's
 * `agent/redact_browser_input.py`, which parses the snippet as Python; this scans its text). A password a snippet types is
 * a plain literal (`fill_input('#pass', 'hunter2')`) that matches no credential pattern, so it is masked whatever it looks
 * like, while selectors, URLs and the rest of the code stay readable.
 *
 * Recognised: the typed argument of `fill_input` and `type_text` by position, `text=` keyword or splat; the arguments of a
 * CDP `insertText` call; a literal assigned to `.value` (page script that assigns anything else is masked whole). A name the
 * typed value uses has every statement that mentions it masked too (its assignments, loops and mutations), with the body of
 * a function the snippet defines under that name and the calls of one that takes it as a parameter.
 * Withheld whole (`***`): a snippet whose brackets or quotes do not pair up, a typing helper used other than by calling it,
 * an `insertText` that is no call's argument, and a snippet that names more than `MAX_NAMES` bindings. Code the sidecar cut
 * at its cap has every literal masked, since the typing call may sit past the cut.
 * The stored call and the code the Agent ran are never touched.
 */
const WITHHELD = '***'
const MASK = "'***'"
/** Any way a snippet types into a page. */
const TYPING_RE = /\b(?:fill_input|type_text)\b|insertText|\.value\s*=(?!=)/
const NAME_RE = /[\p{L}_][\p{L}\p{N}_]*/gu
const NUMBER_RE = /(?<![\p{L}\p{N}_.])\d[\p{L}\p{N}_.]*/gu
const TYPING_CALL_RE = /(?<![\p{L}\p{N}_])(fill_input|type_text)(?![\p{L}\p{N}_])(\s*\()?/gu
const STRING_PREFIX_RE = /[fFrRbBuU]{1,2}(?=['"])/y
/** A keyword argument's `=`, right after its name. */
const KEYWORD_RE = /\s*=(?!=)/y
const DEF_RE = /^\s*(?:async\s+)?def\s+([\p{L}_][\p{L}\p{N}_]*)\s*\(/u
const IMPORT_RE = /^\s*(?:from|import)(?![\p{L}\p{N}_])/u
/** Words a typed expression uses that bind nothing. */
const KEYWORDS = new Set(['if', 'else', 'and', 'or', 'not', 'in', 'is', 'for', 'await', 'None', 'True', 'False'])
/** ponytail: past this many followed names the snippet is withheld; raise it if real snippets hit it. */
const MAX_NAMES = 256

/** Whether `text` (code, or the JSON text carrying it) types into a page by any recognised means. */
export const typesIntoPage = (text: string): boolean => TYPING_RE.test(text)

type Span = [start: number, end: number, replacement: string]
interface Literal { start: number; end: number; f: boolean; stmt: number }
interface Scan {
  /** The code with each string literal blanked to NULs and each comment to spaces, so a search of it sees only code. */
  skeleton: string
  literals: Literal[]
  /** Each open bracket's closing index (the end of the code for one the cut left open). */
  closes: Map<number, number>
  /** The innermost open bracket around each index, -1 outside any. */
  enclosing: Int32Array
  /** Where each statement starts: after a line break or `;` outside any bracket. */
  stmts: number[]
}

const OPEN = '([{'
const CLOSE = ')]}'
const isWord = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c)

/** The snippet's literals, brackets and statements; null when its quotes or brackets do not pair up. */
function scan(code: string): Scan | null {
  let skeleton = ''
  let kept = 0
  const blank = (start: number, end: number, fill: string): void => { skeleton += code.slice(kept, start) + fill.repeat(end - start); kept = end }
  const literals: Literal[] = []
  const closes = new Map<number, number>()
  const enclosing = new Int32Array(code.length + 1).fill(-1)
  const stack: number[] = []
  const stmts = [0]
  let i = 0
  while (i < code.length) {
    const c = code[i]!
    const top = stack.at(-1) ?? -1
    enclosing[i] = top
    if (c === '#') {
      let end = i
      while (end < code.length && code[end] !== '\n' && code[end] !== '\r') end++
      enclosing.fill(top, i, end)
      blank(i, end, ' ')
      i = end
      continue
    }
    if (c === '\\') { enclosing[i + 1] = top; i += 2; continue }
    STRING_PREFIX_RE.lastIndex = i
    const prefix = !isWord(code[i - 1]) ? STRING_PREFIX_RE.exec(code)?.[0] ?? '' : ''
    const q = i + prefix.length
    if (code[q] === "'" || code[q] === '"') {
      const quote = code.startsWith(code[q].repeat(3), q) ? code[q].repeat(3) : code[q]
      let j = q + quote.length
      // A literal the cut left open runs to the end.
      while (j < code.length && !code.startsWith(quote, j)) {
        if (quote.length === 1 && (code[j] === '\n' || code[j] === '\r')) return null
        j += code[j] === '\\' ? 2 : 1
      }
      j = Math.min(j + quote.length, code.length)
      enclosing.fill(top, i, j)
      literals.push({ start: i, end: j, f: /f/i.test(prefix), stmt: stmts.length - 1 })
      blank(i, j, '\0')
      i = j
      continue
    }
    if (OPEN.includes(c)) stack.push(i)
    else if (CLOSE.includes(c)) {
      const open = stack.pop()
      if (open === undefined || OPEN.indexOf(code[open]!) !== CLOSE.indexOf(c)) return null
      closes.set(open, i)
    } else if (!stack.length && (c === '\n' || c === '\r' || c === ';')) stmts.push(i + 1)
    i++
  }
  skeleton += code.slice(kept)
  for (const open of stack) closes.set(open, code.length)
  return { skeleton, literals, closes, enclosing, stmts }
}

/** The index of the last of the ascending `starts` at or before `at`. */
function lastAtOrBefore(starts: number[], at: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= at) lo = mid
    else hi = mid - 1
  }
  return lo
}

const INNER_PREFIX_RE = /[fFrRbBuU]{1,2}(?=["'`\\])/y
const INNER_QUOTES = ["'''", '"""', "\\'", '\\"', '\\`', "'", '"', '`']

/** The string literal starting at `start` in raw text (JavaScript inside a Python string included), masked; one that never closes runs to its line's end. */
function innerLiteral(code: string, start: number): Span | null {
  INNER_PREFIX_RE.lastIndex = start
  const prefix = INNER_PREFIX_RE.exec(code)?.[0] ?? ''
  const q = start + prefix.length
  const quote = INNER_QUOTES.find((candidate) => code.startsWith(candidate, q))
  if (!quote) return null
  let i = q + quote.length
  while (i < code.length) {
    if (code.startsWith(quote, i)) return [start, i + quote.length, `${prefix}${quote}***${quote}`]
    if (quote.length !== 3 && (code[i] === '\n' || code[i] === '\r')) break
    i += code[i] === '\\' ? 2 : 1
  }
  return [start, Math.min(i, code.length), `${prefix}***`]
}

class Withheld extends Error {}

/** The spans to mask in `code`; throws `Withheld` when a typed value cannot be told from the rest. */
function typedSpans(code: string, cut: boolean): Span[] {
  const scanned = scan(code)
  if (!scanned) throw new Withheld()
  const { skeleton, literals, closes, enclosing, stmts } = scanned
  const literalStarts = literals.map((literal) => literal.start)
  const names = new Map<string, number[]>()
  for (const match of skeleton.matchAll(NAME_RE)) {
    const at = names.get(match[0])
    if (at) at.push(match.index)
    else names.set(match[0], [match.index])
  }
  const spans: Span[] = []
  const masked = new Set<number>()
  const followed = new Set<string>()
  const queue: string[] = []
  /** The typed expressions and insertion calls already handled: a name used inside one binds nothing there. */
  const typed: [number, number][] = []
  let work = 0
  const spend = (amount: number): void => { if ((work += amount) > 16 * code.length + 1000) throw new Withheld() }

  const stmtRange = (k: number): [number, number] => [stmts[k]!, stmts[k + 1] ?? code.length]
  const stmtOf = (at: number): number => lastAtOrBefore(stmts, at)
  const literalAt = (at: number): Literal | undefined => {
    const literal = literals[lastAtOrBefore(literalStarts, at)]
    return literal && literal.start <= at && at < literal.end ? literal : undefined
  }
  function* literalsIn(start: number, end: number): Generator<Literal> {
    for (let i = lastAtOrBefore(literalStarts, start); i < literals.length && literals[i]!.start < end; i++) if (literals[i]!.end > start) yield literals[i]!
  }
  const follow = (name: string): void => {
    if (followed.has(name) || KEYWORDS.has(name)) return
    if (followed.size >= MAX_NAMES) throw new Withheld()
    followed.add(name)
    queue.push(name)
  }
  /** The names code between two indexes uses. A keyword argument's own name (inside a bracket) is not one; an assignment's target is, since it aliases the value. */
  const followIn = (start: number, end: number): void => {
    for (const match of skeleton.slice(start, end).matchAll(NAME_RE)) {
      KEYWORD_RE.lastIndex = start + match.index + match[0].length
      if (enclosing[start + match.index]! < 0 || !KEYWORD_RE.test(skeleton)) follow(match[0])
    }
  }
  /** A string may read any name it spells: an f-string's fields, page script, text handed to `eval` or `exec`. */
  const followLiteral = (literal: Literal): void => { for (const match of code.slice(literal.start, literal.end).matchAll(NAME_RE)) follow(match[0]) }
  const maskLiteral = (literal: Literal): void => { spans.push([literal.start, literal.end, MASK]); followLiteral(literal) }
  /** A statement that binds a typed value: its literals and numbers masked, its names followed. */
  const maskStatement = (k: number): void => {
    if (masked.has(k)) return
    masked.add(k)
    const [start, end] = stmtRange(k)
    for (const literal of literalsIn(start, end)) maskLiteral(literal)
    for (const match of skeleton.slice(start, end).matchAll(NUMBER_RE)) spans.push([start + match.index, start + match.index + match[0].length, WITHHELD])
    followIn(start, end)
  }
  /** A typed expression, masked whole. */
  const maskValue = (from: number, to: number): void => {
    const text = skeleton.slice(from, to)
    const start = from + text.length - text.trimStart().length
    const end = from + text.trimEnd().length
    if (start >= end) return
    spend(end - start)
    typed.push([start, end])
    spans.push([start, end, MASK])
    followIn(start, end)
    for (const literal of literalsIn(start, end)) followLiteral(literal)
  }
  /** A typing call's arguments: the one at `position`, a `text=` keyword and every splat are typed; all of them when none is. */
  const maskTypedArguments = (open: number, position: number): void => {
    const close = closes.get(open)!
    spend(close - open)
    const args: [number, number][] = []
    let depth = 0
    let start = open + 1
    for (let i = open + 1; i < close; i++) {
      const c = skeleton[i]!
      if (OPEN.includes(c)) depth++
      else if (CLOSE.includes(c)) depth--
      else if (c === ',' && !depth) { args.push([start, i]); start = i + 1 }
    }
    args.push([start, close])
    const values: [number, number][] = []
    let index = 0
    let splat = false
    let found = false
    for (const [from, to] of args) {
      const text = skeleton.slice(from, to)
      if (!text.trim()) continue
      const keyword = /^\s*([\p{L}_][\p{L}\p{N}_]*)\s*=(?!=)/u.exec(text)
      const star = keyword ? null : /^\s*\*{1,2}/.exec(text)
      const value: [number, number] = [from + ((keyword ?? star)?.[0].length ?? 0), to]
      values.push(value)
      // A positional argument after a splat sits at an unknown position.
      const typed = star ? true : keyword ? keyword[1] === 'text' : splat || index === position
      if (star) splat = true
      else if (!keyword) index++
      if (typed) { found = true; maskValue(...value) }
    }
    if (!found) for (const value of values) maskValue(...value)
  }

  for (const match of skeleton.matchAll(TYPING_CALL_RE)) {
    if (match[2]) maskTypedArguments(match.index + match[0].length - 1, match[1] === 'fill_input' ? 1 : 0)
    // A helper named without a call (an alias, an argument) types through a name this scan cannot follow.
    else if (!IMPORT_RE.test(skeleton.slice(...stmtRange(stmtOf(match.index))))) throw new Withheld()
  }
  // A helper called inside a string (code handed to `exec`) types a value this scan cannot reach; one only named there
  // (`locals()['type_text']`) is looked up into a name it cannot follow.
  for (const match of code.matchAll(/\b(?:fill_input|type_text)\b(\s*\()?/g)) {
    const literal = literalAt(match.index)
    if (!literal) continue
    if (!match[1]) throw new Withheld()
    followLiteral(literal)
    maskStatement(literal.stmt)
  }
  for (const match of code.matchAll(/insertText/g)) {
    const literal = literalAt(match.index)
    if (!literal) {
      if (skeleton.startsWith('insertText', match.index)) {
        const call = /\s*\(/y
        call.lastIndex = match.index + match[0].length
        if (!call.test(skeleton)) throw new Withheld()
        maskTypedArguments(call.lastIndex - 1, -1)
      }
      continue
    }
    // A longer string carrying the word holds the typing expression itself (JavaScript's `execCommand('insertText', ...)`).
    if (!/insertText['"]{1,3}$/.test(code.slice(literal.start, literal.end))) { followLiteral(literal); maskStatement(literal.stmt); continue }
    const open = enclosing[literal.start]!
    if (open < 0 || code[open] !== '(') throw new Withheld()
    const close = closes.get(open)!
    spend(close - open)
    const key = /\s*:/y
    for (const other of literalsIn(open + 1, close)) {
      key.lastIndex = other.end
      // Only the payload's own `text` field name is kept: any other key may be the value (`next(iter({'pw': 1}))`).
      if (other !== literal && !(key.test(skeleton) && /^['"]text['"]$/.test(code.slice(other.start, other.end)))) maskLiteral(other)
    }
    typed.push([open + 1, close])
    const region = skeleton.slice(open + 1, close)
    // A number the payload types (`str(123456)`) is masked like a string.
    for (const number of region.matchAll(NUMBER_RE)) spans.push([open + 1 + number.index, open + 1 + number.index + number[0].length, WITHHELD])
    followIn(open + 1, close)
  }
  for (const match of code.matchAll(/\.value\s*=(?!=)\s*/g)) {
    const literal = literalAt(match.index)
    if (!literal && skeleton[match.index] !== '.') continue
    const value = innerLiteral(code, match.index + match[0].length)
    // The assigned expression is one literal only when its statement ends there: at a `;`, a line end, or the string's own close.
    // Page script is fixed text only as a plain string passed straight to a call: an f-string, `%`, `.format`, a
    // concatenation or a name it is assigned to builds it from the statement around it.
    const fixed = !literal || (!literal.f && /[(,]\s*$/.test(skeleton.slice(Math.max(0, literal.start - 200), literal.start)) && /^\s*[),]/.test(skeleton.slice(literal.end, literal.end + 200)))
    // A template that interpolates (`${pw}`) takes its value from the script around it, and a line break ends a Python
    // statement but not a page-script expression (`''\n + 'pw'`).
    const ends = literal ? /^[ \t]*(?:;|['"]{1,3}$)/ : /^[ \t]*(?:[;\r\n#]|$)/
    const isolated = value !== null && fixed && !code.slice(value[0], value[1]).includes('${') && ends.test(code.slice(value[1], literal ? literal.end : code.length))
    if (value && isolated) { spans.push(value); continue }
    // Anything else (a variable, a concatenation) takes its value from the script or statement around it, masked whole.
    if (literal) maskLiteral(literal)
    maskStatement(literal ? literal.stmt : stmtOf(match.index))
  }
  if (cut) for (let k = 0; k < stmts.length; k++) maskStatement(k)

  const defs = new Set<string>()
  const call = /\s*\(/y
  /** A function's `def` and its body: the statements indented under it. */
  const maskFunction = (k: number): void => {
    const indent = (j: number): number => skeleton.slice(...stmtRange(j)).search(/\S/)
    const own = indent(k)
    maskStatement(k)
    for (let j = k + 1; j < stmts.length; j++) {
      const depth = indent(j)
      if (depth < 0) continue
      if (depth <= own) break
      maskStatement(j)
    }
  }
  // Every statement that mentions a followed name may bind or build the typed value: an assignment, a loop, a mutation.
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    const uses = (names.get(name) ?? []).filter((at) => { spend(typed.length); return !typed.some(([start, end]) => start <= at && at < end) }).map((at) => {
      const k = stmtOf(at)
      const [start, end] = stmtRange(k)
      const def = DEF_RE.exec(skeleton.slice(start, Math.min(end, start + 400)))
      call.lastIndex = at + name.length
      return { at, k, def, defines: def !== null && at === start + def[0].lastIndexOf(def[1]!), params: def ? start + def[0].length - 1 : -1, called: call.test(skeleton) }
    })
    // A name the snippet only ever calls (`str`, `goto`) is a helper from outside it. One it binds anywhere (an alias
    // `add = pw.append`, a `def`) may carry the value through each call too.
    const bound = uses.some((use) => use.defines || !use.called)
    for (const { at, k, def, defines, params, called } of uses) {
      // A function the snippet defines under the name produces the value.
      if (defines) { maskFunction(k); continue }
      if (def && enclosing[at] === params && !defs.has(def[1]!)) {
        // A parameter of a function the snippet defines is bound by every call of it.
        defs.add(def[1]!)
        for (const use of names.get(def[1]!) ?? []) {
          call.lastIndex = use + def[1]!.length
          if (use !== params - def[0].length + 1 + def[0].lastIndexOf(def[1]!) && call.test(skeleton)) maskStatement(stmtOf(use))
        }
      }
      if (bound || !called) maskStatement(k)
    }
  }
  return spans
}

/**
 * `code` with every value it types into a page masked, or `***` when one cannot be told from the rest. `cut` marks code the
 * sidecar capped, whose typing call may sit past the cut.
 */
export function maskTypedBrowserText(code: string, cut = false): string {
  if (!cut && !typesIntoPage(code)) return code
  let spans: Span[]
  try { spans = typedSpans(code, cut) } catch { return WITHHELD }
  let out = ''
  let pos = 0
  for (const [start, end, replacement] of spans.sort((a, b) => a[0] - b[0] || b[1] - a[1])) {
    if (start >= pos) out += code.slice(pos, start) + replacement
    // A span reaching past one already masked masks its remainder.
    else if (end > pos) out += WITHHELD
    else continue
    pos = end
  }
  return out + code.slice(pos)
}
