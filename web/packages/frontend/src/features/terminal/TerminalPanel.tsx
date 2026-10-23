import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { m } from '../../paraglide/messages.js'
import { post } from '../../api/client'
import { openTerminalStream, type SseHandle } from '../../api/sse'
import { z } from 'zod'
import { Button } from '../../ui/Button'
import { showToast } from '../toast/toast'
import { showErrorToast } from '../toast/errorToast'
import { isDefiniteRefusal } from '../../contracts/common'
import { TerminalPanelFrame } from './TerminalPanelFrame'

const StartSchema = z.looseObject({ ok: z.boolean().optional(), running: z.boolean().optional(), error: z.string().optional(), message: z.string().optional() })
const OkSchema = z.looseObject({ ok: z.boolean().optional(), closed: z.boolean().optional(), error: z.string().optional() })

/**
 * Workspace terminal on bundled xterm (no CDN). Protocol: POST start, POST input
 * (serialised so keystrokes keep their order), SSE output, POST resize, POST close.
 */
export function TerminalPanel({ sessionId, workspace, onClose, onReopen = () => undefined }: { sessionId: string; workspace: string | undefined; onClose: () => void; onReopen?: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const [status, setStatus] = useState<'starting' | 'running' | 'closed' | 'error'>('starting')
  const [height, setHeight] = useState(260)
  const stream = useRef<SseHandle | null>(null)
  const reconnect = useRef<(() => void) | null>(null)
  const inputChain = useRef(Promise.resolve())

  useEffect(() => {
    const el = host.current
    if (!el) return
    const t = new Terminal({ cursorBlink: true, fontFamily: 'var(--font-mono)', fontSize: 12.5, theme: { background: 'transparent' }, allowTransparency: true, convertEol: true })
    const f = new FitAddon()
    t.loadAddon(f)
    t.loadAddon(new WebLinksAddon())
    t.open(el)
    f.fit()
    term.current = t
    fit.current = f
    // Start and restart resolve after awaits; once cleanup runs, a late connect would leak an EventSource.
    let cancelled = false
    const connect = () => {
      if (cancelled) return
      stream.current?.close()
      stream.current = openTerminalStream(sessionId, {
        onOutput: (text) => t.write(text),
        onClosed: () => { t.writeln(`\r\n[${m.terminal_close().toLowerCase()}]`); setStatus('closed') },
        onError: (err) => { t.writeln(`\r\n${err ?? m.terminal_title()}`); setStatus('error') },
      })
    }
    reconnect.current = connect
    void (async () => {
      try {
        const res = await post('api/terminal/start', { session_id: sessionId, workspace, cols: t.cols, rows: t.rows }, StartSchema, { retries: 0, timeoutMs: 20_000 })
        if (res.error) { setStatus('error'); t.writeln(res.error); return }
        setStatus('running')
        connect()
      } catch (e) {
        setStatus('error')
        t.writeln(e instanceof Error ? e.message : String(e))
      }
    })()
    const data = t.onData((d) => { inputChain.current = inputChain.current.then(() => post('api/terminal/input', { session_id: sessionId, data: d }, OkSchema, { retries: 0, timeoutMs: 10_000 })).then(() => undefined, () => undefined) })
    const resize = t.onResize(({ cols, rows }) => { void post('api/terminal/resize', { session_id: sessionId, cols, rows }, OkSchema, { retries: 0 }).catch(() => undefined) })
    const ro = new ResizeObserver(() => { try { f.fit() } catch { /* not attached */ } })
    ro.observe(el)
    return () => {
      cancelled = true
      stream.current?.close(); stream.current = null
      data.dispose(); resize.dispose(); ro.disconnect(); t.dispose()
      term.current = null
    }
  }, [sessionId, workspace])

  // The panel closes at once while the server stops the shell. A refusal reopens it with the error; closing is
  // idempotent, so an unknown outcome is settled by asking once more.
  const close = () => {
    onClose()
    const send = () => post('api/terminal/close', { session_id: sessionId }, OkSchema, { retries: 0 })
    void (async () => {
      try { await send() } catch (first) {
        let error = first
        if (!isDefiniteRefusal(first)) { try { await send(); return } catch (second) { error = second } }
        onReopen()
        showErrorToast(error)
      }
    })()
  }
  const restart = async () => {
    try {
      await post('api/terminal/start', { session_id: sessionId, workspace, restart: true, cols: term.current?.cols, rows: term.current?.rows }, StartSchema, { retries: 0 })
      term.current?.clear()
      setStatus('running')
      reconnect.current?.()
    } catch (e) {
      showErrorToast(e)
    }
  }
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = height
    const move = (ev: PointerEvent) => setHeight(Math.min(600, Math.max(120, startH - (ev.clientY - startY))))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <TerminalPanelFrame workspace={workspace} status={status} onClose={close} onResize={startResize} actions={<>
      <Button variant="ghost" onClick={() => term.current?.clear()}>{m.terminal_clear()}</Button>
      <Button variant="ghost" onClick={() => { const sel = term.current?.getSelection() ?? ''; void navigator.clipboard.writeText(sel).then(() => showToast(m.copied())) }}>{m.terminal_copy_output()}</Button>
      <Button variant="ghost" onClick={() => { void restart() }}>{m.terminal_restart()}</Button>
    </>}>
      <div ref={host} className="composer-terminal-surface px-2 py-1" style={{ height }} aria-label="Workspace terminal" role="application" />
    </TerminalPanelFrame>
  )
}
