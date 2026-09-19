/**
 * The single Markdown rendering adapter. Streamdown owns parsing and
 * sanitization; only the required plugins are enabled: code via Shiki,
 * Mermaid, math via KaTeX, and CJK. Hermes structures are typed components
 * elsewhere and are never passed through here as HTML.
 */
import { memo } from 'react'
import { Streamdown } from 'streamdown'
import { code } from '@streamdown/code'
import { math } from '@streamdown/math'
import { mermaid } from '@streamdown/mermaid'
import { cjk } from '@streamdown/cjk'
import 'streamdown/styles.css'
import 'katex/dist/katex.min.css'
import { stripToolCallXml } from './text'

const PLUGINS = { code, math, mermaid, cjk }
const SHIKI_THEMES: [string, string] = ['github-light', 'github-dark']

export interface MarkdownProps {
  text: string
  streaming?: boolean
  className?: string
  /** Hostile content stays escaped by Streamdown's sanitizer; raw HTML is never rendered. */
  dir?: 'auto' | 'ltr' | 'rtl'
}

export const Markdown = memo(function Markdown({ text, streaming = false, className, dir = 'auto' }: MarkdownProps) {
  return (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      parseIncompleteMarkdown={streaming}
      isAnimating={streaming}
      className={className ?? 'hermes-prose'}
      plugins={PLUGINS}
      shikiTheme={SHIKI_THEMES}
      dir={dir}
      controls={{ code: { copy: true, download: true }, table: { copy: true, download: true }, mermaid: { copy: true, download: true, fullscreen: true, panZoom: true } }}
      linkSafety={{ enabled: true }}
    >
      {stripToolCallXml(text)}
    </Streamdown>
  )
})
