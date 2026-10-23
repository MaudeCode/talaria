import { memo, use, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { CodeBlockContainer, CodeBlockCopyButton, CodeBlockDownloadButton, CodeBlockHeader, StreamdownContext, type CustomRendererProps } from 'streamdown'
import type { ThemedToken, TokensResult } from 'shiki'
import { highlightCode, loadHighlighter } from './codeHighlight'

// Streamdown's own code-block chrome, so custom blocks sit in the same frame as its built-in ones.
export const ACTIONS = 'pointer-events-none sticky top-2 z-10 -mt-10 flex h-8 items-center justify-end'
export const ACTION_BAR = 'pointer-events-auto flex shrink-0 items-center gap-2 rounded-md border border-sidebar bg-sidebar/80 px-1.5 py-1 supports-[backdrop-filter]:bg-sidebar/70 supports-[backdrop-filter]:backdrop-blur'
export const BODY = 'overflow-x-auto rounded-md border border-border bg-background p-4 text-sm'
// Tokens carry Streamdown's color properties (`--sdm-c`, `--shiki-dark`), with no color or line-number
// utilities: those come from Streamdown's dist, which Tailwind does not scan, so the current look stays unchanged (TAL-1513).

/** Shiki's root style string (`color:…;--shiki-dark:…`) as React style entries. */
function rootStyle(result: TokensResult): CSSProperties {
  const style: Record<string, string> = {}
  if (result.bg) style['--sdm-bg'] = result.bg
  if (result.fg) style['--sdm-fg'] = result.fg
  for (const rule of result.rootStyle ? result.rootStyle.split(';') : []) {
    const colon = rule.indexOf(':')
    if (colon > 0) style[rule.slice(0, colon).trim()] = rule.slice(colon + 1).trim()
  }
  return style
}

function tokenStyle(token: ThemedToken): CSSProperties {
  const style: Record<string, string> = {}
  if (token.color) style['--sdm-c'] = token.color
  if (token.bgColor) style['--sdm-tbg'] = token.bgColor
  for (const [name, value] of Object.entries(token.htmlStyle ?? {})) {
    if (name === 'color') style['--sdm-c'] = value
    else if (name === 'background-color') style['--sdm-tbg'] = value
    else style[name] = value
  }
  return style
}

/** One line; completed lines keep their token array, so a streaming block re-renders only its changed rows. */
const CodeLine = memo(function CodeLine({ tokens }: { tokens: ThemedToken[] }) {
  return (
    <span className="block">
      {tokens.length <= 1 && !tokens[0]?.content ? '\n' : tokens.map((token, index) => <span key={index} style={tokenStyle(token)} {...token.htmlAttrs}>{token.content}</span>)}
    </span>
  )
})

function plain(code: string): TokensResult {
  return { tokens: code.split('\n').map((content) => [{ content, offset: 0 }]) }
}

/** Highlighted tokens; plain lines until the language's highlighter has loaded. */
function useTokens(code: string, language: string, incomplete: boolean): TokensResult {
  const themes = use(StreamdownContext).shikiTheme
  // Bumped once the highlighter loads; the shared highlighter keeps repeat calls cheap.
  const [, setReady] = useState(0)
  const highlighted = highlightCode({ code, language, themes }, incomplete)
  const missing = highlighted === null
  useEffect(() => {
    if (!missing) return
    let live = true
    loadHighlighter(language, themes).then(() => { if (live) setReady((count) => count + 1) }, (error: unknown) => { console.error('[Talaria code] Failed to highlight code:', error) })
    return () => { live = false }
  }, [missing, language, themes])
  return highlighted ?? plain(code)
}

/** A fence body whose rows stay mounted while new lines stream in. */
function CodeBlockBody({ code, language, incomplete }: { code: string; language: string; incomplete: boolean }) {
  const result = useTokens(code, language, incomplete)
  return (
    <div className={BODY} data-language={language} data-streamdown="code-block-body">
      <pre style={rootStyle(result)}>
        <code>{result.tokens.map((tokens, index) => <CodeLine key={index} tokens={tokens} />)}</code>
      </pre>
    </div>
  )
}

/** Every highlighted fence: Streamdown's header and controls around an incrementally highlighted body. */
export function CodeBlock({ code, language, isIncomplete, children }: CustomRendererProps & { children?: ReactNode }) {
  // Streamdown drops trailing newlines before display.
  const shown = useMemo(() => code.replace(/\n+$/, ''), [code])
  return (
    <CodeBlockContainer dir="ltr" language={language} isIncomplete={isIncomplete}>
      <CodeBlockHeader language={language} />
      <div className={ACTIONS}>
        <div className={ACTION_BAR} data-streamdown="code-block-actions">
          {children ?? <><CodeBlockDownloadButton code={code} language={language} /><CodeBlockCopyButton code={code} /></>}
        </div>
      </div>
      <CodeBlockBody code={shown} language={language} incomplete={isIncomplete} />
    </CodeBlockContainer>
  )
}
