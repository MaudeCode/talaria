/**
 * TAL-1402: Shiki highlighting for chat code blocks. A streaming block tokenizes only its newly completed lines,
 * resuming from the grammar state after the last completed line, and results live in a bounded LRU keyed by the
 * full content. The `code` plugin keeps `@streamdown/code`'s interface for the blocks Streamdown renders itself.
 */
import { bundledLanguages, bundledLanguagesInfo, createHighlighter, type GrammarState, type HighlighterGeneric, type ThemedToken, type TokensResult } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { CodeHighlighterPlugin, HighlightOptions, ThemeInput } from 'streamdown'

/** Tokenizes `code`, continuing from `grammarState` when one is given. */
export type Tokenize = (code: string, grammarState: GrammarState | undefined) => TokensResult

/** One streaming block: the tokens of its completed lines and the grammar state after the last one. */
interface Stream { scope: string; prefix: string; lines: ThemedToken[][]; state: GrammarState | undefined; style: Omit<TokensResult, 'tokens'> }

const CACHE_LIMIT = 500
// ponytail: one block streams at a time; a few slots cover re-renders of neighbouring blocks.
const STREAM_LIMIT = 8

function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193)
  return hash >>> 0
}

const shift = (lines: ThemedToken[][], by: number): ThemedToken[][] => (by === 0 ? lines : lines.map((line) => line.map((token) => ({ ...token, offset: token.offset + by }))))

/**
 * Highlights code incrementally. `incomplete` marks a fence that is still streaming: its trailing line renders as
 * plain text until a newline completes it. A complete block tokenizes its last line too, so its tokens match one
 * full-block highlight.
 */
export function createIncrementalHighlighter(limit = CACHE_LIMIT) {
  const cache = new Map<string, { code: string; result: TokensResult }>()
  const streams: Stream[] = []

  function resume(code: string, scope: string): Stream {
    let best: Stream | undefined
    for (const stream of streams) {
      if (stream.scope === scope && code.startsWith(stream.prefix) && (!best || stream.prefix.length > best.prefix.length)) best = stream
    }
    if (best) streams.splice(streams.indexOf(best), 1)
    else best = { scope, prefix: '', lines: [], state: undefined, style: {} }
    streams.unshift(best)
    streams.length = Math.min(streams.length, STREAM_LIMIT)
    return best
  }

  function highlight(code: string, scope: string, incomplete: boolean, tokenize: Tokenize): TokensResult {
    const key = `${scope}:${code.length}:${fnv1a(code)}`
    const hit = cache.get(key)
    if (!incomplete && hit?.code === code) {
      cache.delete(key)
      cache.set(key, hit)
      return hit.result
    }
    // A CR may still become CRLF in the next chunk, so such code is always tokenized whole.
    const stream = code.includes('\r') ? { scope, prefix: '', lines: [], state: undefined, style: {} } : resume(code, scope)
    const end = code.lastIndexOf('\n') + 1
    if (end > stream.prefix.length) {
      // Omit the final newline, or Shiki tokenizes an extra empty line and advances the grammar state past it.
      const { tokens, grammarState, ...style } = tokenize(code.slice(stream.prefix.length, end - 1), stream.state)
      stream.lines = [...stream.lines, ...shift(tokens, stream.prefix.length)]
      stream.prefix = code.slice(0, end)
      stream.state = grammarState
      stream.style = style
    }
    const tail = code.slice(end)
    let last: ThemedToken[][] = [tail ? [{ content: tail, offset: end }] : []]
    let style = stream.style
    if (!incomplete && tail) {
      const { tokens, ...tailStyle } = tokenize(tail, stream.state)
      last = shift(tokens, end)
      style = tailStyle
    }
    const result: TokensResult = { ...style, tokens: [...stream.lines, ...last] }
    // A streaming prefix is never shown again, so only complete blocks take cache slots.
    if (!incomplete) {
      cache.set(key, { code, result })
      const oldest = cache.keys().next().value
      if (cache.size > limit && oldest !== undefined) cache.delete(oldest)
    }
    return result
  }

  return { highlight, size: () => cache.size }
}

type Themes = [ThemeInput, ThemeInput]
const engine = createJavaScriptRegexEngine({ forgiving: true })
const aliases = new Map(bundledLanguagesInfo.flatMap((info) => (info.aliases ?? []).map((alias) => [alias, info.id] as const)))
const supported = new Set(Object.keys(bundledLanguages))
const resolveLanguage = (language: string): string => { const name = language.trim().toLowerCase(); return aliases.get(name) ?? name }
const themeName = (theme: ThemeInput): string => (typeof theme === 'string' ? theme : (theme.name ?? 'custom'))

/** Every fence label Shiki highlights, aliases included; the code-block renderer claims these. */
export const HIGHLIGHTED_LANGUAGES = [...supported, ...aliases.keys()]

// Languages and themes are resolved at runtime, so the maps hold Shiki's string-keyed highlighter type.
type Highlighter = HighlighterGeneric<string, string>
const loading = new Map<string, Promise<Highlighter>>()
const loaded = new Map<string, Highlighter>()
const shared = createIncrementalHighlighter()

function scopeOf(language: string, themes: Themes) {
  const resolved = resolveLanguage(language)
  const lang = supported.has(resolved) ? resolved : 'text'
  return { lang, key: `${lang}:${themeName(themes[0])}:${themeName(themes[1])}` }
}

/** Loads the language and themes once; Shiki fetches each grammar lazily. */
export function loadHighlighter(language: string, themes: Themes): Promise<unknown> {
  const { lang, key } = scopeOf(language, themes)
  const pending = loading.get(key)
  if (pending) return pending
  const promise = createHighlighter({ themes: themes as Parameters<typeof createHighlighter>[0]['themes'], langs: [lang], engine }) as Promise<Highlighter>
  // A failed load stays failed, as in `@streamdown/code`; callers report it and keep the plain text.
  promise.then((highlighter) => { loaded.set(key, highlighter) }, () => undefined)
  loading.set(key, promise)
  return promise
}

/** Tokens for `code`, or null until its highlighter has loaded. */
export function highlightCode({ code, language, themes }: HighlightOptions, incomplete: boolean): TokensResult | null {
  const { lang, key } = scopeOf(language, themes)
  const highlighter = loaded.get(key)
  if (!highlighter) return null
  const target = highlighter.getLoadedLanguages().includes(lang) ? lang : 'text'
  const options = { lang: target, themes: { light: themeName(themes[0]), dark: themeName(themes[1]) } }
  return shared.highlight(code, key, incomplete, (part, grammarState) => highlighter.codeToTokens(part, grammarState ? { ...options, grammarState } : options))
}

const THEMES: Themes = ['github-light', 'github-dark']

/** Drop-in for `@streamdown/code`; Streamdown's own code blocks only ever ask for a complete highlight. */
export const code: CodeHighlighterPlugin = {
  name: 'shiki',
  type: 'code-highlighter',
  supportsLanguage: (language) => supported.has(resolveLanguage(language)),
  getSupportedLanguages: () => [...supported] as ReturnType<CodeHighlighterPlugin['getSupportedLanguages']>,
  getThemes: () => THEMES,
  highlight(options, callback) {
    const ready = highlightCode(options, false)
    if (ready) return ready
    loadHighlighter(options.language, options.themes).then(() => {
      const result = highlightCode(options, false)
      if (result) callback?.(result)
    }, (error: unknown) => { console.error('[Talaria code] Failed to highlight code:', error) })
    return null
  },
}
