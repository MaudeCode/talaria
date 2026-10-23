import { CapturedCommandResultSchema, TerminalStartSchema } from '@maudecode/talaria-web-contracts'
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

const StartSchema = TerminalStartSchema.or(z.object({ mode: z.never().optional(), ok: z.boolean().optional(), running: z.boolean().optional(), error: z.string().optional(), message: z.string().optional() }))
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
  const applyStart = useRef<((result: z.infer<typeof StartSchema>, restart?: boolean) => void) | null>(null)
  const [captured, setCaptured] = useState<{ workspace: string; target_key: string } | null>(null)
  const [command, setCommand] = useState('')
  const [executing, setExecuting] = useState(false)
  const mode = useRef<'web_pty' | 'owner_command' | null>(null)
  const commandBusy = useRef(false)
  const inputChain = useRef(Promise.resolve())

  useEffect(() => {
    mode.current = null
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
    const started = (res: z.infer<typeof StartSchema>, restart = false) => {
      if (cancelled) return
      stream.current?.close(); stream.current = null
      mode.current = null
      if ('error' in res && res.error) { setStatus('error'); t.writeln(res.error); return }
      if (restart) t.clear()
      if (res.mode === 'owner_command') {
        mode.current = 'owner_command'
        setCaptured({ workspace: res.workspace, target_key: res.target_key })
        t.options.disableStdin = true
        t.options.screenReaderMode = true
      } else {
        mode.current = 'web_pty'
        setCaptured(null)
        t.options.disableStdin = false
        connect()
      }
      setStatus('running')
    }
    applyStart.current = started
    void (async () => {
      try {
        const res = await post('api/terminal/start', { session_id: sessionId, workspace, cols: t.cols, rows: t.rows }, StartSchema, { retries: 0, timeoutMs: 20_000 })
        started(res)
      } catch (e) {
        if (cancelled) return
        setStatus('error')
        t.writeln(e instanceof Error ? e.message : String(e))
      }
    })()
    const data = t.onData((d) => { if (mode.current !== 'web_pty') return; inputChain.current = inputChain.current.then(() => mode.current === 'web_pty' ? post('api/terminal/input', { session_id: sessionId, data: d }, OkSchema, { retries: 0, timeoutMs: 10_000 }) : undefined).then(() => undefined, () => undefined) })
    const resize = t.onResize(({ cols, rows }) => { if (mode.current !== 'web_pty') return; void post('api/terminal/resize', { session_id: sessionId, cols, rows }, OkSchema, { retries: 0 }).catch(() => undefined) })
    const ro = new ResizeObserver(() => { try { f.fit() } catch { /* not attached */ } })
    ro.observe(el)
    return () => {
      cancelled = true
      applyStart.current = null
      stream.current?.close(); stream.current = null
      data.dispose(); resize.dispose(); ro.disconnect(); t.dispose()
      term.current = null
    }
  }, [sessionId, workspace])

  // The panel closes at once while the server stops the shell. A refusal reopens it with the error; closing is
  // idempotent, so an unknown outcome is settled by asking once more.
  const close = () => {
    onClose()
    if (mode.current === 'owner_command') return
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
    const started = applyStart.current
    try {
      const res = await post('api/terminal/start', { session_id: sessionId, workspace, restart: true, cols: term.current?.cols, rows: term.current?.rows }, StartSchema, { retries: 0 })
      started?.(res, true)
    } catch (e) {
      showErrorToast(e)
    }
  }
  const execute = async () => {
    if (!captured || !command.trim() || commandBusy.current) return
    commandBusy.current = true
    setExecuting(true)
    const selected = term.current
    // Captured output is text, never terminal escape instructions from a peer.
    const text = (value: string) => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    try {
      const result = await post('api/terminal/exec', { session_id: sessionId, mode: 'owner_command', target_key: captured.target_key, command }, CapturedCommandResultSchema, { retries: 0, timeoutMs: 50_000 })
      if (term.current !== selected) return
      selected?.writeln(text(result.stdout))
      if (result.stderr) selected?.writeln(text(result.stderr))
      selected?.writeln(m.terminal_exit_code({ code: String(result.code) }))
    } catch (error) {
      if (term.current === selected) selected?.writeln(text(error instanceof Error ? error.message : String(error)))
    } finally { commandBusy.current = false; setExecuting(false) }
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
    <TerminalPanelFrame workspace={captured?.workspace ?? workspace} title={captured ? m.terminal_native_command() : undefined} status={status} onClose={close} onResize={startResize} actions={<>
      <Button variant="ghost" onClick={() => term.current?.clear()}>{m.terminal_clear()}</Button>
      <Button variant="ghost" onClick={() => { const sel = term.current?.getSelection() ?? ''; void navigator.clipboard.writeText(sel).then(() => showToast(m.copied())) }}>{m.terminal_copy_output()}</Button>
      {!captured && status !== 'starting' && <Button variant="ghost" onClick={() => { void restart() }}>{m.terminal_restart()}</Button>}
    </>}>
      {captured && <form className="flex gap-2 border-b border-border px-2 py-2" onSubmit={(event) => { event.preventDefault(); void execute() }}>
        <input aria-label={m.terminal_captured_command()} placeholder={m.terminal_captured_command()} className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 font-mono text-sm" value={command} onChange={(event) => setCommand(event.target.value)} autoComplete="off" />
        <Button type="submit" disabled={executing || !command.trim()}>{executing ? m.terminal_command_running() : m.terminal_run_command()}</Button>
      </form>}
      <div ref={host} className="composer-terminal-surface px-2 py-1" style={{ height }} aria-label="Workspace terminal" role="application" />
    </TerminalPanelFrame>
  )
}
