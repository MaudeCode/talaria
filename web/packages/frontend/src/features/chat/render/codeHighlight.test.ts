import { createHighlighter, type GrammarState } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { describe, expect, it } from 'vitest'
import { createIncrementalHighlighter, type Tokenize } from './codeHighlight'

/** Splits code into one token per line and records every line it was given. */
function recordingTokenizer() {
  const seen: string[] = []
  const tokenize: Tokenize = (code) => {
    const lines = code.split('\n')
    seen.push(...lines)
    let offset = 0
    return { tokens: lines.map((content) => { const token = { content, offset }; offset += content.length + 1; return [token] }), grammarState: {} as GrammarState }
  }
  return { seen, tokenize }
}

/** `text` cut into `count` slices at fixed character positions, so most cuts land mid-line. */
const increments = (text: string, count: number) => Array.from({ length: count }, (_, index) => text.slice(0, Math.round((text.length * (index + 1)) / count)))

describe('incremental code highlighting (TAL-1402)', () => {
  it('tokenizes each completed line of a streaming 500-line block once', () => {
    const lines = Array.from({ length: 500 }, (_, index) => `const value${index} = ${index}`)
    const code = lines.join('\n')
    const { seen, tokenize } = recordingTokenizer()
    const highlighter = createIncrementalHighlighter()
    for (const prefix of increments(code, 100)) highlighter.highlight(prefix, 'ts', true, tokenize)
    const done = highlighter.highlight(code, 'ts', false, tokenize)

    expect(seen).toEqual(lines)
    expect(done.tokens.map((line) => line.map((token) => token.content).join(''))).toEqual(lines)
  })

  it('renders the in-progress line as plain text and re-tokenizes from the start when the prefix changes', () => {
    const { seen, tokenize } = recordingTokenizer()
    const highlighter = createIncrementalHighlighter()
    expect(highlighter.highlight('one\ntw', 'ts', true, tokenize).tokens).toEqual([[{ content: 'one', offset: 0 }], [{ content: 'tw', offset: 4 }]])
    expect(seen).toEqual(['one'])
    highlighter.highlight('uno\ntwo\n', 'ts', true, tokenize)
    expect(seen).toEqual(['one', 'uno', 'two'])
  })

  it('matches one full-block highlight when a comment and a template string close in later increments', async () => {
    const shiki = await createHighlighter({ themes: ['github-light', 'github-dark'], langs: ['typescript'], engine: createJavaScriptRegexEngine({ forgiving: true }) })
    const options = { lang: 'typescript', themes: { light: 'github-light', dark: 'github-dark' } } as const
    const tokenize: Tokenize = (part, grammarState) => shiki.codeToTokens(part, grammarState ? { ...options, grammarState } : options)
    const code = 'const a = 1\n/* opens a comment\nstill inside\n*/\nconst b = `template\n${a} line\n`\nconst c = 2'
    const full = shiki.codeToTokens(code, options)
    const highlighter = createIncrementalHighlighter()
    const steps = ['const a = 1\n/* opens a comment\n', 'still inside\n*/\nconst b = `templ', 'ate\n${a} line\n', '`\nconst c = 2']
    let text = ''
    for (const step of steps) {
      text += step
      const partial = highlighter.highlight(text, 'ts', true, tokenize)
      const completed = text.split('\n').length - 1
      expect(partial.tokens.slice(0, completed)).toEqual(full.tokens.slice(0, completed))
    }
    const done = highlighter.highlight(code, 'ts', false, tokenize)

    expect(done.tokens).toEqual(full.tokens)
    expect(done.fg).toBe(full.fg)
    expect(done.bg).toBe(full.bg)
    // The comment and template lines carry their own scopes, not plain-code colors.
    expect(done.tokens[2]).toEqual(full.tokens[2])
    expect(done.tokens[5]).not.toEqual(shiki.codeToTokens('${a} line', options).tokens[0])
  })

  it('resumes across CRLF line endings, including a chunk that ends between CR and LF', async () => {
    const shiki = await createHighlighter({ themes: ['github-light', 'github-dark'], langs: ['typescript'], engine: createJavaScriptRegexEngine({ forgiving: true }) })
    const options = { lang: 'typescript', themes: { light: 'github-light', dark: 'github-dark' } } as const
    const seen: string[] = []
    const tokenize: Tokenize = (part, grammarState) => { seen.push(...part.split(/\r?\n/)); return shiki.codeToTokens(part, grammarState ? { ...options, grammarState } : options) }
    const lines = ['const a = 1', '/* a comment', 'that spans lines */', 'const b = 2']
    const code = lines.join('\r\n')
    const highlighter = createIncrementalHighlighter()
    for (const end of [12, 13, 27, 40, 47, code.length]) highlighter.highlight(code.slice(0, end), 'ts', true, tokenize)
    const done = highlighter.highlight(code, 'ts', false, tokenize)

    expect(code[11]).toBe('\r')
    expect(seen).toEqual(lines)
    expect(done.tokens).toEqual(shiki.codeToTokens(code, options).tokens)
  })

  it('never holds more than its bound of complete blocks', () => {
    const { tokenize } = recordingTokenizer()
    const highlighter = createIncrementalHighlighter(500)
    for (let index = 0; index < 2000; index++) {
      highlighter.highlight(`block ${index}\nbody`, 'ts', false, tokenize)
      expect(highlighter.size()).toBeLessThanOrEqual(500)
    }
    expect(highlighter.size()).toBe(500)
    const recent = highlighter.highlight('block 1999\nbody', 'ts', false, tokenize)
    expect(highlighter.highlight('block 1999\nbody', 'ts', false, tokenize)).toBe(recent)
  })
})
