/**
 * The single Markdown rendering adapter. Streamdown owns parsing and
 * sanitization; only the required plugins are enabled: code via Shiki,
 * Mermaid, math via KaTeX, and CJK. Hermes structures are typed components
 * elsewhere and are never passed through here as HTML.
 */
import { createContext, memo, use, useMemo } from 'react'
import { Streamdown, type LinkSafetyConfig, type LinkSafetyModalProps } from 'streamdown'
import { code } from '@streamdown/code'
import { math } from '@streamdown/math'
import { mermaid } from '@streamdown/mermaid'
import { cjk } from '@streamdown/cjk'
import 'streamdown/styles.css'
import 'katex/dist/katex.min.css'
import { Dialog } from '../../../ui/Dialog'
import { Button } from '../../../ui/Button'
import { m } from '../../../paraglide/messages.js'

const PLUGINS = { code, math, mermaid, cjk }
const SHIKI_THEMES: [string, string] = ['github-light', 'github-dark']

/** Asks the server whether a clicked link skips the warning; shared transcripts sit outside any provider and always warn. */
export const LinkCheckContext = createContext<((url: string) => Promise<boolean>) | null>(null)

// ponytail: fixed budget so a direct open stays inside the click's user activation (popup blockers); slower answers warn.
const LINK_CHECK_TIMEOUT_MS = 700

function askServer(check: (url: string) => Promise<boolean>, url: string): Promise<boolean> {
  const timeout = new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false) }, LINK_CHECK_TIMEOUT_MS) })
  return Promise.race([check(url).catch(() => false), timeout])
}

function hostOf(url: string): string {
  try { return new URL(url).hostname || url } catch { return url }
}

/** Streamdown's link warning in the app dialog; Base UI owns focus, Escape, and backdrop dismissal. */
function LinkSafetyDialog({ isOpen, onClose, onConfirm, url }: LinkSafetyModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose() }} title={m.link_safety_title()} description={m.link_safety_description({ host: hostOf(url) })}>
      <p className="break-all rounded-md border border-border-subtle bg-bg px-3 py-2 font-mono text-xs text-muted">{url}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>{m.cancel()}</Button>
        <Button variant="primary" onClick={() => { onConfirm(); onClose() }}>{m.link_safety_open()}</Button>
      </div>
    </Dialog>
  )
}

export interface MarkdownProps {
  text: string
  streaming?: boolean
  className?: string
  /** Hostile content stays escaped by Streamdown's sanitizer; raw HTML is never rendered. */
  dir?: 'auto' | 'ltr' | 'rtl'
}

export const Markdown = memo(function Markdown({ text, streaming = false, className, dir = 'auto' }: MarkdownProps) {
  const check = use(LinkCheckContext)
  // Streamdown re-renders blocks when this object's identity changes, so it follows the checker only.
  const linkSafety = useMemo<LinkSafetyConfig>(() => ({ enabled: true, onLinkCheck: (url) => (check ? askServer(check, url) : false), renderModal: (props) => <LinkSafetyDialog {...props} /> }), [check])
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
      linkSafety={linkSafety}
    >
      {text}
    </Streamdown>
  )
})
