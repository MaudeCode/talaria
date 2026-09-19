import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Mic, Paperclip, Square, ArrowUp, TerminalSquare, SlidersHorizontal } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import type { UploadResponse, Session, Settings } from '../../contracts'
import type { LiveTurn } from '../../stream/reducer'
import { isTerminal } from '../../stream/reducer'
import { cancelTurn, startTurn } from '../../stream/connection'
import { useBootstrap } from '../../app/bootstrap'
import { cn } from '../../ui/cn'
import { showToast } from '../toast/toast'
import { AttachmentTray, type PendingFile } from './Attachments'
import { CommandPaletteList, useCommandPalette } from './CommandPalette'
import { parseCommand, type CommandSuggestion } from './commands'
import { ContextRing, ContextRow, ModelChip, ReasoningChip, ToolsetsChip, WorkspaceChip } from './chips'
import { clearDraft, readLocalDraft, useDraftPersistence } from './useDraft'
import { createRecognition, dictationSupported, classifyDictationError } from '../voice/dictation'
import { ProfileMenu } from '../../shell/ProfileMenu'
import { setTheme } from '../../app/appearance'
import { ThemeSchema } from '../../contracts/persisted'

export type BusyMode = 'steer' | 'queue' | 'interrupt'
/** A message waiting for the live turn to settle: it owns its text, upload receipts and the request it was composed against. */
export interface QueuedTurn { text: string; attachments: UploadResponse[]; request: { model?: string | undefined; model_provider?: string | null | undefined; workspace?: string | undefined; profile: string } }

export interface ComposerProps {
  sessionId: string | null
  session: Session | null
  /** Choices made on the unsaved chat, shown by the chips until the session exists. */
  pendingChoices?: { model?: string; workspace?: string; enabled_toolsets?: string[] | null } | undefined
  live: LiveTurn | null
  settings: Settings | undefined
  onEnsureSession: () => Promise<Session>
  onLocalCommand: (name: string, args: string) => Promise<boolean>
  terminalOpen: boolean
  onToggleTerminal: () => void
  onModelChange: (model: string, provider: string | null) => void
  onWorkspaceChange: (path: string) => void
  onToolsetsChange: (toolsets: string[] | null) => void
  onReasoningChange: (level: string | null) => void
  reasoningLevels?: string[] | undefined
  /** False when the model has neither an effort ladder nor a thinking toggle; the chip is hidden, as legacy did. */
  reasoningSupported?: boolean | undefined
  reasoning: string | null
  yolo: boolean
  onToggleYolo: () => void
  queued: QueuedTurn[]
  onQueue: (entry: QueuedTurn) => void
  /** Sending is disabled (e.g. while a manual compression job runs). */
  locked?: boolean | undefined
}

const PHONE = '(max-width: 640px)'
/** Phone-width viewport: the footer runs the icon/burger stage and collapses when idle (legacy _isPhoneWidthViewport). */
function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(PHONE).matches)
  useEffect(() => {
    const mq = window.matchMedia(PHONE)
    const on = () => setPhone(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return phone
}

function fileKey(f: File): string {
  return `${f.name}:${f.size}:${f.lastModified}`
}

/**
 * The composer: textarea with send-key preference, attachments (click, drop,
 * paste), slash commands, busy modes (steer / queue / interrupt), dictation,
 * and the model, reasoning, toolsets, workspace and profile chips.
 */
/** Draft and files handed from the empty chat's composer to the one mounted for the session it just created. */
let handoff: { text: string; files: File[] } | null = null

export function Composer(props: ComposerProps) {
  const { sessionId, session, live, settings, onEnsureSession, onLocalCommand, terminalOpen, onToggleTerminal, onModelChange, onWorkspaceChange, onToolsetsChange, onReasoningChange, reasoning, reasoningLevels, reasoningSupported = true, pendingChoices, locked = false, yolo, onToggleYolo, queued, onQueue } = props
  const bootstrap = useBootstrap()
  const qc = useQueryClient()
  const [text, setText] = useState(() => (sessionId ? readLocalDraft(sessionId) : ''))
  const [files, setFiles] = useState<PendingFile[]>([])
  const [sending, setSending] = useState(false)
  const [dictating, setDictating] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [focusWithin, setFocusWithin] = useState(false)
  const [stage, setStage] = useState<'full' | 'icons' | 'burger'>('full')
  const footer = useRef<HTMLDivElement>(null)
  // Fit pass (legacy _fitComposerFooter): try full labels, then icon-only chips, then move the chips into the panel.
  const fitFooter = useCallback(() => {
    const f = footer.current
    const left = f?.querySelector<HTMLElement>('.composer-left')
    if (!f || !left?.clientWidth) return
    // Sum the in-flow children: scrollWidth also counts tooltip pseudo-elements that hang off the buttons.
    const overflows = () => {
      const kids = Array.from(left.children).filter((e) => getComputedStyle(e).position !== 'absolute')
      const gap = parseFloat(getComputedStyle(left).columnGap) || 0
      const need = kids.reduce((sum, e) => sum + e.getBoundingClientRect().width, 0) + gap * Math.max(0, kids.length - 1)
      return need > left.clientWidth + 1
    }
    f.classList.remove('cf-icons', 'cf-burger')
    let next: 'full' | 'icons' | 'burger' = 'full'
    if (window.matchMedia(PHONE).matches) next = 'burger'
    else if (overflows()) { f.classList.add('cf-icons'); next = 'icons'; if (overflows()) next = 'burger' }
    // Restore the classes here: React only re-renders when the stage actually changes.
    f.classList.toggle('cf-icons', next !== 'full')
    f.classList.toggle('cf-burger', next === 'burger')
    setStage(next)
  }, [])
  useLayoutEffect(() => { fitFooter() })
  useEffect(() => {
    const f = footer.current
    if (!f) return
    const ro = new ResizeObserver(() => fitFooter())
    ro.observe(f)
    return () => ro.disconnect()
  }, [fitFooter])
  const phone = usePhone()
  const box = useRef<HTMLDivElement>(null)
  // The overflow panel closes on any pointer-down outside the composer box.
  useEffect(() => {
    if (!configOpen) return
    const on = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setConfigOpen(false) }
    document.addEventListener('pointerdown', on)
    return () => document.removeEventListener('pointerdown', on)
  }, [configOpen])
  const textarea = useRef<HTMLTextAreaElement>(null)
  const recognition = useRef<ReturnType<typeof createRecognition>>(null)
  const busy = !!live && !isTerminal(live.status)
  const busyMode: BusyMode = (settings?.default_message_mode as BusyMode | undefined) ?? 'steer'
  const sendKey = settings?.send_key ?? 'enter'
  const palette = useCommandPalette(text)
  useDraftPersistence(sessionId, text)

  // Session change resets the draft and tray, unless this session's composer just adopted a hand-off (below); the
  // guard also keeps StrictMode's effect replay from wiping the adopted state.
  const adopted = useRef<string | null>(null)
  useEffect(() => {
    if (adopted.current === sessionId) return
    setText(sessionId ? readLocalDraft(sessionId) : '')
    setFiles([])
  }, [sessionId])

  // Autosize.
  useEffect(() => {
    const el = textarea.current
    if (!el) return
    // Native sizing where supported (upstream #6760); otherwise measure. An empty composer keeps its resting
    // height rather than the placeholder's wrapped height.
    if (!text || (typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content'))) { el.style.height = ''; return }
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`
  }, [text])

  const maxBytes = bootstrap.max_upload_bytes
  const addFiles = useCallback((incoming: FileList | File[]) => {
    const list = Array.from(incoming)
    if (list.length === 0) return
    // Attaching to the empty chat: the index route and the session route mount separate composers, so the navigation
    // that lazy session creation causes would drop this state. Hand the draft and files to the composer that mounts
    // for the new session; it runs the uploads with the session in hand.
    if (!session) {
      handoff = { text, files: list }
      void onEnsureSession().catch((e: unknown) => { handoff = null; showToast(e instanceof Error ? e.message : String(e), 4000, 'error') })
      return
    }
    for (const f of list) {
      if (f.size > maxBytes) { showToast(m.composer_too_large({ name: f.name, max: Math.round(maxBytes / 1024 / 1024) }), 4000, 'error'); continue }
      const key = fileKey(f)
      setFiles((prev) => (prev.some((p) => p.key === key) ? prev : [...prev, { key, file: f, status: 'uploading' }]))
      void (async () => {
        try {
          const target = session ?? (await onEnsureSession())
          const upload = await api.uploadFile(target.session_id, f)
          setFiles((prev) => prev.map((p) => (p.key === key ? { ...p, status: 'done', upload } : p)))
        } catch (e) {
          setFiles((prev) => prev.map((p) => (p.key === key ? { ...p, status: 'error', error: e instanceof Error ? e.message : String(e) } : p)))
          showToast(m.composer_upload_failed({ name: f.name }), 4000, 'error')
        }
      })()
    }
  }, [maxBytes, session, onEnsureSession, text])

  // Adopt a hand-off from the empty chat's composer (see addFiles). Runs after the session-change reset above.
  useEffect(() => {
    if (!sessionId || !session || !handoff) return
    const h = handoff; handoff = null
    adopted.current = sessionId
    setText(h.text)
    addFiles(h.files)
  }, [sessionId, session, addFiles])

  const removeFile = (key: string) => {
    const f = files.find((p) => p.key === key)
    setFiles((prev) => prev.filter((p) => p.key !== key))
    if (f?.upload?.rollback_token && session) void api.rollbackUpload(session.session_id, [f.upload.rollback_token]).catch(() => undefined)
  }

  // Steer: deliver mid-run; if the server did not accept it, the draft stays in the box.
  const steer = useMutation({ mutationFn: (text: string) => api.steerChat({ session_id: sessionId ?? '', text }) })
  const trySteer = useCallback(async (text: string): Promise<boolean> => {
    const r = await steer.mutateAsync(text)
    if (!r.accepted) { showToast(r.fallback === 'gateway_steer_queued' ? m.steer_leftover_queued() : m.busy_steer_fallback(), 2500); return false }
    showToast(m.cmd_steer_delivered(), 1500)
    return true
  }, [steer])

  // Snapshot of what a send would post right now, for the queue.
  const queueEntry = useCallback((text: string): QueuedTurn => ({ text, attachments: files.flatMap((f) => (f.status === 'done' && f.upload ? [f.upload] : [])), request: { model: session?.model ?? undefined, model_provider: session?.model_provider ?? undefined, workspace: session?.workspace, profile: bootstrap.profile?.name ?? 'default' } }), [files, session, bootstrap.profile])

  const send = useCallback(async () => {
    if (locked) { showToast(m.live_compressing(), 1500); return }
    const value = text.trim()
    if (sending) return
    if (!value && files.length === 0) return
    if (files.some((f) => f.status === 'uploading')) { showToast(m.loading()); return }
    const cmd = parseCommand(value)
    if (cmd) {
      if (['stop', 'new', 'clear', 'terminal', 'title', 'retry', 'undo', 'compress', 'compact', 'usage', 'theme', 'yolo', 'branch', 'voice', 'reasoning', 'model', 'workspace', 'help', 'status', 'personality', 'goal', 'skills', 'use'].includes(cmd.name)) {
        if (cmd.name === 'theme') { const v = ThemeSchema.safeParse(cmd.args); if (v.success) setTheme(v.data); setText(''); return }
        const handled = await onLocalCommand(cmd.name, cmd.args)
        if (handled) { setText(''); return }
      }
      if (cmd.name === 'queue' && busy) { onQueue(queueEntry(cmd.args)); setText(''); setFiles([]); return }
      if (cmd.name === 'steer' && busy && sessionId) { if (!cmd.args) { showToast(m.cmd_steer_no_msg(), 2000); return } if (await trySteer(cmd.args)) setText(''); return }
      if (cmd.name === 'interrupt' && busy && sessionId) { await cancelTurn(sessionId); onQueue(queueEntry(cmd.args)); setText(''); setFiles([]); return }
    }
    if (busy && sessionId) {
      if (busyMode === 'queue') { onQueue(queueEntry(value)); setText(''); setFiles([]); return }
      if (busyMode === 'steer') { if (await trySteer(value)) setText(''); return }
      await cancelTurn(sessionId)
      onQueue(queueEntry(value))
      setText('')
      setFiles([])
      return
    }
    setSending(true)
    try {
      const target = session ?? (await onEnsureSession())
      const attachments = files.flatMap((f) => (f.status === 'done' && f.upload ? [f.upload] : []))
      await startTurn({ sessionId: target.session_id, message: value, request: { model: target.model ?? undefined, model_provider: target.model_provider ?? undefined, workspace: target.workspace, profile: bootstrap.profile?.name ?? 'default', ...(attachments.length ? { attachments } : {}) } })
      setText('')
      setFiles([])
      clearDraft(target.session_id)
      void qc.invalidateQueries({ queryKey: keys.sessions.all })
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 5000, 'error')
    } finally {
      setSending(false)
      textarea.current?.focus()
    }
  }, [text, files, sending, session, onEnsureSession, busy, busyMode, sessionId, trySteer, locked, queueEntry, onQueue, onLocalCommand, bootstrap.profile, qc])

  const applySuggestion = (s: CommandSuggestion) => { setText(`/${s.name} `); textarea.current?.focus() }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (palette.handleKey(e, applySuggestion)) return
    if (e.key !== 'Enter') return
    const isNumpad = e.code === 'NumpadEnter'
    const mobile = window.matchMedia('(max-width: 640px)').matches
    if (sendKey === 'ctrl+enter' || mobile) {
      if (isNumpad || e.ctrlKey || e.metaKey) { e.preventDefault(); void send() }
      return
    }
    if (!e.shiftKey) { e.preventDefault(); void send() }
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items)
    const images = items.filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f)
    if (images.length) { e.preventDefault(); addFiles(images); return }
    const pasted = e.clipboardData.getData('text/plain')
    if (settings?.large_text_paste_as_attachment !== false && pasted.length > 8000) {
      e.preventDefault()
      addFiles([new File([pasted], `pasted-${Date.now()}.txt`, { type: 'text/plain' })])
      showToast(m.text_pasted() + `pasted-${Date.now()}.txt`, 2500)
    }
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files) }

  const toggleDictation = () => {
    if (!dictationSupported()) { showToast(m.composer_dictation_unsupported(), 3000, 'error'); return }
    if (dictating) { recognition.current?.stop(); return }
    const r = createRecognition(document.documentElement.lang || 'en-US')
    if (!r) return
    recognition.current = r
    const base = text
    r.onresult = (ev) => {
      let transcript = ''
      for (const result of Array.from(ev.results)) transcript += result[0]?.transcript ?? ''
      setText(settings?.dictation_append === false ? transcript : `${base}${base && !base.endsWith(' ') ? ' ' : ''}${transcript}`)
    }
    r.onerror = (ev) => { const kind = classifyDictationError(ev.error); showToast(kind === 'denied' ? m.mic_denied() : kind === 'no_speech' ? m.mic_no_speech() : kind === 'network' ? m.mic_network() : m.mic_error() + ev.error, 3000, 'error'); setDictating(false) }
    r.onend = () => { setDictating(false); recognition.current = null }
    r.start()
    setDictating(true)
  }

  const hide = (k: string) => !!(settings as Record<string, unknown> | undefined)?.[k]
  const placeholder = busy ? (busyMode === 'queue' ? m.composer_placeholder_busy_queue() : busyMode === 'interrupt' ? m.composer_placeholder_busy_interrupt() : m.composer_placeholder_busy_steer()) : m.composer_placeholder()
  const compressedEstimate = session?.post_compression_context_tokens_estimate
  const contextUsed = compressedEstimate && compressedEstimate > 0 ? compressedEstimate : (session?.last_prompt_tokens ?? null)
  const contextTotal = session?.context_length ?? null
  const canSend = (text.trim() !== '' || files.some((f) => f.status === 'done')) && !sending && !locked

  return (
    <div className="composer-wrap" id="composerWrap">
      {queued.length > 0 && (
        <div className="queue-card" role="region" aria-label={m.queued_count({ n: queued.length })} aria-live="polite">
          <div className="queue-card-title">{m.queued_count({ n: queued.length })}</div>
          <ul className="queue-card-list">{queued.map((q, i) => <li key={i}>{q.text}{q.attachments.length ? ` (+${q.attachments.length})` : ''}</li>)}</ul>
        </div>
      )}
      <div
        className={cn('composer-box relative z-[2] flex flex-col mx-auto max-w-(--msg-max) bg-(--composer-bg) border-(length:--composer-border-width) border-(--composer-border-color) rounded-(--composer-radius) shadow-(--composer-shadow) transition-[border-color,box-shadow] duration-(--dur) ease-(--ease) focus-within:border-(--composer-focus-border) focus-within:shadow-(--composer-focus-shadow) focus-within:outline-none max-[641px]:rounded-[12px]', dragOver && 'drag-over')}
        id="composerBox"
        ref={box}
        onFocus={() => setFocusWithin(true)}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocusWithin(false) }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {palette.open && <CommandPaletteList items={palette.items} active={palette.active} listId={palette.listId} onPick={applySuggestion} onHover={palette.setActive} />}
        {dragOver && <div className="drop-hint active" id="dropHint" aria-hidden="true">{m.drop_files_to_attach()}</div>}
        <AttachmentTray files={files} onRemove={removeFile} />
        {dictating && <div className="mic-status active" id="micStatus" role="status"><span className="mic-dot" aria-hidden="true" /> {m.voice_listening()}</div>}
        <textarea
          ref={textarea}
          id="msg"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          aria-label={m.composer_placeholder()}
          aria-autocomplete={palette.open ? 'list' : undefined}
          aria-controls={palette.open ? palette.listId : undefined}
          aria-activedescendant={palette.activeId}
          role={palette.open ? 'combobox' : undefined}
          aria-expanded={palette.open ? true : undefined}
        />
        <div ref={footer} className={cn('composer-footer', stage !== 'full' && 'cf-icons', stage === 'burger' && 'cf-burger', phone && !text && files.length === 0 && !busy && !focusWithin && !configOpen && !dragOver && 'cf-collapsed')}>
          <div className="composer-left flex items-center gap-1 min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] max-[641px]:flex-[1_1_auto] max-[641px]:w-auto max-[641px]:flex-nowrap max-[641px]:items-center max-[641px]:gap-x-2.5 max-[641px]:gap-y-0 max-[641px]:max-h-none max-[641px]:[-webkit-overflow-scrolling:touch] max-[341px]:gap-x-0.5">
            {!hide('hide_composer_attach') && (
              <>
                <input type="file" id="fileInput" multiple className="file-input-visually-hidden" onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }} accept="image/*,text/*,application/pdf,application/json,.csv,.md,.docx,.xlsx,.pptx" />
                <button type="button" className="icon-btn has-tooltip" id="btnAttach" data-tooltip={m.composer_control_attach()} aria-label={m.composer_control_attach()} onClick={() => document.getElementById('fileInput')?.click()}><Paperclip size={16} aria-hidden="true" /></button>
              </>
            )}
            {!hide('hide_composer_mic') && dictationSupported() && <button type="button" className={cn('icon-btn mic-btn has-tooltip', dictating && 'active')} id="btnMic" data-tooltip={dictating ? m.voice_dictate_active() : m.voice_dictate()} aria-label={dictating ? m.voice_dictate_active() : m.voice_dictate()} aria-pressed={dictating} onClick={toggleDictation}><Mic size={16} aria-hidden="true" /></button>}
            <button type="button" className={cn('icon-btn has-tooltip', terminalOpen && 'active')} id="btnTerminalInline" data-tooltip={m.composer_terminal_toggle()} aria-label={m.composer_terminal_toggle()} aria-pressed={terminalOpen} onClick={onToggleTerminal}><TerminalSquare size={16} aria-hidden="true" /></button>
            {yolo && !hide('hide_composer_yolo') && <button type="button" onClick={onToggleYolo} className="yolo-pill" id="yoloPill" title={m.yolo_pill_title_active()}><span className="yolo-pill-icon" aria-hidden="true">⚡</span><span className="yolo-pill-label">{m.yolo_pill_label()}</span></button>}
            {!hide('hide_composer_profile') && <div className="composer-profile-wrap" id="profileChipWrap"><ProfileMenu /></div>}
            {!hide('hide_composer_workspace') && <div className="composer-ws-wrap"><WorkspaceChip value={session?.workspace ?? pendingChoices?.workspace ?? settings?.default_workspace} onChange={onWorkspaceChange} /></div>}
            {!hide('hide_composer_model') && <div className="composer-model-wrap"><ModelChip value={session?.model ?? pendingChoices?.model ?? null} defaultModel={settings?.default_model} onChange={onModelChange} /></div>}
            {!hide('hide_composer_reasoning') && reasoningSupported && <div className="composer-reasoning-wrap"><ReasoningChip value={reasoning} levels={reasoningLevels} onChange={onReasoningChange} /></div>}
            {!hide('hide_composer_toolsets') && <div className="composer-toolsets-wrap"><ToolsetsChip value={session?.enabled_toolsets ?? pendingChoices?.enabled_toolsets ?? null} onChange={onToolsetsChange} /></div>}
            <button className="icon-btn composer-mobile-config-btn has-tooltip" id="composerMobileConfigBtn" type="button" data-tooltip={m.composer_config_title()} aria-label={m.composer_config_title()} aria-expanded={configOpen} aria-controls="composerMobileConfigPanel" onClick={() => setConfigOpen((o) => !o)}>
              <SlidersHorizontal size={16} aria-hidden="true" />
            </button>
          </div>
          <div className="composer-right flex gap-2 items-center shrink-0 max-[641px]:flex-none max-[641px]:w-auto max-[641px]:justify-end max-[641px]:gap-1.5 max-[641px]:min-w-0">
            {!hide('hide_composer_context') && <ContextRing used={contextUsed} total={contextTotal} threshold={session?.threshold_tokens} />}
            {busy ? (
              <button type="button" onClick={() => { if (sessionId) void cancelTurn(sessionId) }} className="send-btn stop has-tooltip has-tooltip--left" id="btnStop" data-tooltip={m.composer_stop()} aria-label={m.composer_stop()} title={m.composer_stop()}>
                <Square size={14} aria-hidden="true" />
              </button>
            ) : (
              <button type="button" onClick={() => { void send() }} disabled={!canSend} className="send-btn has-tooltip has-tooltip--left" id="btnSend" data-tooltip={m.composer_send()} aria-label={m.composer_send()} title={m.composer_send()}>
                <ArrowUp size={16} aria-hidden="true" />
              </button>
            )}
          </div>
          <div className={cn('composer-mobile-config-panel', configOpen && 'open')} id="composerMobileConfigPanel" role="group" aria-label={m.composer_config_title()}>
            {stage === 'burger' && !hide('hide_composer_profile') && <ProfileMenu row />}
            {stage === 'burger' && !hide('hide_composer_workspace') && <WorkspaceChip row value={session?.workspace ?? pendingChoices?.workspace ?? settings?.default_workspace} onChange={onWorkspaceChange} />}
            {stage === 'burger' && !hide('hide_composer_model') && <ModelChip row value={session?.model ?? pendingChoices?.model ?? null} defaultModel={settings?.default_model} onChange={onModelChange} />}
            {stage === 'burger' && !hide('hide_composer_reasoning') && reasoningSupported && <ReasoningChip row value={reasoning} levels={reasoningLevels} onChange={onReasoningChange} />}
            {stage === 'burger' && <button type="button" className={cn('icon-btn', terminalOpen && 'active')} id="btnTerminal" title={m.composer_terminal_toggle()} aria-label={m.composer_terminal_toggle()} aria-pressed={terminalOpen} onClick={() => { setConfigOpen(false); onToggleTerminal() }}><TerminalSquare size={16} aria-hidden="true" /><span className="composer-mobile-config-value">{m.composer_terminal_toggle()}</span></button>}
            {stage === 'burger' && !hide('hide_composer_toolsets') && <ToolsetsChip row value={session?.enabled_toolsets ?? pendingChoices?.enabled_toolsets ?? null} onChange={onToolsetsChange} />}
            {stage === 'burger' && !hide('hide_composer_context') && <ContextRow used={contextUsed} total={contextTotal} threshold={session?.threshold_tokens} />}
          </div>
        </div>
      </div>
    </div>
  )
}
