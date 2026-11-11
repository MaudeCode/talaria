/**
 * The single Markdown rendering adapter. Streamdown owns parsing and
 * sanitization; only the required plugins are enabled: code via Shiki,
 * Mermaid, math via KaTeX, and CJK. Hermes structures are typed components
 * elsewhere and are never passed through here as HTML.
 */
import { use, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Streamdown, parseMarkdownIntoBlocks, type AnimateOptions, type LinkSafetyConfig, type LinkSafetyModalProps } from 'streamdown'
import { cjk } from '@streamdown/cjk'
import { appUrl } from '../../../lib/appRoot'
import { CodeBlock, LineEndedContext } from './CodeBlock'
import { code, HIGHLIGHTED_LANGUAGES } from './codeHighlight'
import { JsonCodeBlock } from './JsonCodeBlock'
import { LinkCheckContext, type LinkCheck } from './LinkCheckContext'
import type { MarkdownProps } from './Markdown'
import { createIncrementalMarkdownParser } from './incrementalMarkdown'
import 'streamdown/styles.css'
import { Dialog } from '../../../ui/Dialog'
import { Button } from '../../../ui/Button'
import { m } from '../../../paraglide/messages.js'
import { ARRIVE_EASE, followHeight, prefersReducedMotion } from '../../../lib/motion'

const STREAM_WORDS = { animation: 'blurIn', sep: 'word', duration: 400, easing: ARRIVE_EASE, stagger: 12, maxBacklogMs: 120 } satisfies AnimateOptions

// Streamdown checks renderers before Mermaid, so `mermaid` keeps its diagram; unlabeled fences fall back to `code`.
const OWN_RENDERERS = new Set(['json', 'mermaid', 'mmd'])
const CODE_LANGUAGES = HIGHLIGHTED_LANGUAGES.filter((language) => !OWN_RENDERERS.has(language))
const PLUGINS = { code, cjk, renderers: [{ language: 'json', component: JsonCodeBlock }, { language: CODE_LANGUAGES, component: CodeBlock }] }
const loadMermaid = () => import('./diagramPlugin').then(({ mermaid }) => mermaid)
const loadMath = () => Promise.all([import('@streamdown/math'), import('katex/dist/katex.min.css')]).then(([{ math }]) => math)

/** Both optional renderers keep source text readable if loading fails or the view unmounts. */
function useLazyPlugin<T>(enabled: boolean, load: () => Promise<T>): T | null {
  const [plugin, setPlugin] = useState<T | null>(null)
  useEffect(() => {
    if (!enabled) return
    let active = true
    void load().then((loaded) => { if (active) setPlugin(() => loaded) }).catch(() => { /* Keep the plain Markdown fallback. */ })
    return () => { active = false }
  }, [enabled, load])
  return plugin
}
/**
 * TAL-186: server media URLs are relative to the app root (`./api/media?…`, which hardening turns into `/api/media?…`),
 * never to the current route or the origin root.
 */
const urlTransform = (url: string): string => (/^\.?\/api\//.test(url) ? appUrl(url.replace(/^\./, '')).href : url)
const SHIKI_THEMES: [string, string] = ['github-light', 'github-dark']
// Table Copy needs ClipboardItem, which only a secure context has and no shim can provide.
const CONTROLS = { code: { copy: true, download: true }, table: { copy: window.isSecureContext, download: true }, mermaid: { copy: true, download: true, fullscreen: true, panZoom: true } }

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

export default function MarkdownRenderer({ text, streaming = false, fade = false, className, dir = 'auto', liveTurn = false }: MarkdownProps) {
  const check = use(LinkCheckContext)
  const animated = streaming && fade && !prefersReducedMotion()
  const heightRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const wrapper = heightRef.current
    const content = wrapper?.firstElementChild
    if (animated && wrapper && content instanceof HTMLElement) return followHeight(wrapper, content)
  }, [animated])
  const parseBlocks = streaming ? createIncrementalMarkdownParser() : parseMarkdownIntoBlocks
  // Syntax detection selects display assets only; transcript state and link decisions remain server-owned.
  const mermaid = useLazyPlugin(/(?:`{3,}|~{3,})mermaid\b/.test(text), loadMermaid)
  // The existing plugin parses double-dollar math; ordinary prices must not load KaTeX.
  const math = useLazyPlugin(text.includes('$$'), loadMath)
  const plugins = ({ ...PLUGINS, ...(mermaid ? { mermaid } : {}), ...(math ? { math } : {}) })
  // Streamdown opens the dialog only after onLinkCheck settles, so the host is recorded before the dialog renders.
  const hosts = useRef(new Map<string, string | null>())
  // Streamdown re-renders blocks when this object's identity changes, so it follows the checker only.
  const linkSafety: LinkSafetyConfig = ({
    enabled: true,
    onLinkCheck: async (url) => {
      if (!check) return false
      const answer = await askServer(check, url)
      hosts.current.set(url, answer.host)
      return answer.opens_directly
    },
    renderModal: (props) => <LinkSafetyDialog {...props} host={hosts.current.get(props.url)} />,
  })
  const body = (
    <Streamdown
      // Static mode replaces the block tree. Keep live-turn widgets mounted after the active tail moves on.
      mode={streaming || liveTurn ? 'streaming' : 'static'}
      parseIncompleteMarkdown={streaming}
      isAnimating={streaming}
      // Streamdown skips `pre`, `svg` and math; inline code is held still in chat.css.
      {...(animated ? { animated: STREAM_WORDS } : {})}
      parseMarkdownIntoBlocksFn={parseBlocks}
      className={`${className ?? 'hermes-prose'}${animated ? ' flow-root' : ''}`}
      plugins={plugins}
      shikiTheme={SHIKI_THEMES}
      dir={dir}
      controls={CONTROLS}
      lineNumbers={false}
      linkSafety={linkSafety}
      urlTransform={urlTransform}
    >
      {text}
    </Streamdown>
  )
  return (
    <LineEndedContext value={streaming && text.endsWith('\n')}>
      <div ref={heightRef} data-stream-height={animated ? '' : undefined}>{body}</div>
    </LineEndedContext>
  )
}
