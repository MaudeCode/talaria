/**
 * The single Markdown rendering adapter. Streamdown owns parsing and
 * sanitization; only the required plugins are enabled: code via Shiki,
 * Mermaid, math via KaTeX, and CJK. Hermes structures are typed components
 * elsewhere and are never passed through here as HTML.
 */
import { createContext, memo, use, useMemo, useRef } from 'react'
import { Streamdown, type LinkSafetyConfig, type LinkSafetyModalProps } from 'streamdown'
import { code } from '@streamdown/code'
import { math } from '@streamdown/math'
import { mermaid } from '@streamdown/mermaid'
import { cjk } from '@streamdown/cjk'
import { appUrl } from '../../../lib/appRoot'
import { JsonCodeBlock } from './JsonCodeBlock'
import 'streamdown/styles.css'
import 'katex/dist/katex.min.css'
import { Dialog } from '../../../ui/Dialog'
import { Button } from '../../../ui/Button'
import { m } from '../../../paraglide/messages.js'

const PLUGINS = { code, math, mermaid, cjk, renderers: [{ language: 'json', component: JsonCodeBlock }] }
/**
 * TAL-186: server media URLs are relative to the app root (`./api/media?…`, which hardening turns into `/api/media?…`),
 * never to the current route or the origin root.
 */
const urlTransform = (url: string): string => (/^\.?\/api\//.test(url) ? appUrl(url.replace(/^\./, '')).href : url)
const SHIKI_THEMES: [string, string] = ['github-light', 'github-dark']

export interface LinkCheck { opens_directly: boolean; host: string | null }

/** Asks the server whether a clicked link skips the warning and which host it names; shared transcripts sit outside any provider and always warn. */
export const LinkCheckContext = createContext<((url: string) => Promise<LinkCheck>) | null>(null)

// ponytail: fixed budget so a direct open stays inside the click's user activation (popup blockers); slower answers warn.
const LINK_CHECK_TIMEOUT_MS = 700

const UNANSWERED: LinkCheck = { opens_directly: false, host: null }

function askServer(check: (url: string) => Promise<LinkCheck>, url: string): Promise<LinkCheck> {
  const timeout = new Promise<LinkCheck>((resolve) => { setTimeout(() => { resolve(UNANSWERED) }, LINK_CHECK_TIMEOUT_MS) })
  return Promise.race([check(url).catch(() => UNANSWERED), timeout])
}

/** Streamdown's link warning in the app dialog; Base UI owns focus, Escape, and backdrop dismissal. `host` is the server's answer, absent when it gave none. */
function LinkSafetyDialog({ isOpen, onClose, onConfirm, url, host }: LinkSafetyModalProps & { host: string | null | undefined }) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose() }} title={m.link_safety_title()} description={host ? m.link_safety_description({ host }) : m.link_safety_description_unknown()}>
      <p className="max-h-32 overflow-y-auto break-all rounded-md border border-border-subtle bg-bg px-3 py-2 font-mono text-xs text-muted">{url}</p>
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
  // Streamdown opens the dialog only after onLinkCheck settles, so the host is recorded before the dialog renders.
  const hosts = useRef(new Map<string, string | null>())
  // Streamdown re-renders blocks when this object's identity changes, so it follows the checker only.
  const linkSafety = useMemo<LinkSafetyConfig>(() => ({
    enabled: true,
    onLinkCheck: async (url) => {
      if (!check) return false
      const answer = await askServer(check, url)
      hosts.current.set(url, answer.host)
      return answer.opens_directly
    },
    renderModal: (props) => <LinkSafetyDialog {...props} host={hosts.current.get(props.url)} />,
  }), [check])
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
      urlTransform={urlTransform}
    >
      {text}
    </Streamdown>
  )
})
