/**
 * The single Markdown rendering adapter. Streamdown owns parsing and
 * sanitization; only the required plugins are enabled: code via Shiki,
 * Mermaid, math via KaTeX, and CJK. Hermes structures are typed components
 * elsewhere and are never passed through here as HTML.
 */
import { use, useEffect, useRef, useState } from 'react'
import { Streamdown, parseMarkdownIntoBlocks, type LinkSafetyConfig, type LinkSafetyModalProps } from 'streamdown'
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

// Streamdown checks renderers before Mermaid, so `mermaid` keeps its diagram; unlabeled fences fall back to `code`.
const OWN_RENDERERS = new Set(['json', 'mermaid', 'mmd'])
const CODE_LANGUAGES = HIGHLIGHTED_LANGUAGES.filter((language) => !OWN_RENDERERS.has(language))
const PLUGINS = { code, cjk, renderers: [{ language: 'json', component: JsonCodeBlock }, { language: CODE_LANGUAGES, component: CodeBlock }] }
const loadMermaid = () => import('@streamdown/mermaid').then(({ mermaid }) => mermaid)
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
const CONTROLS = { code: { copy: true, download: true }, table: { copy: true, download: true }, mermaid: { copy: true, download: true, fullscreen: true, panZoom: true } }

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

export default function MarkdownRenderer({ text, streaming = false, className, dir = 'auto' }: MarkdownProps) {
  const check = use(LinkCheckContext)
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
  return (
    <LineEndedContext value={streaming && text.endsWith('\n')}>
      <Streamdown
        mode={streaming ? 'streaming' : 'static'}
        parseIncompleteMarkdown={streaming}
        isAnimating={streaming}
        parseMarkdownIntoBlocksFn={parseBlocks}
        className={className ?? 'hermes-prose'}
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
    </LineEndedContext>
  )
}
