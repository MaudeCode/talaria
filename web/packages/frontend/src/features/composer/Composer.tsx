import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Mic, Paperclip, Square, ArrowUp, TerminalSquare, SlidersHorizontal } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import type { Session, Settings } from '../../contracts'
import type { LiveTurn } from '../../stream/reducer'
import { isTerminal } from '../../stream/reducer'
import { adoptTurn, cancelTurn, startTurn } from '../../stream/connection'
import { forgetOwnSteer, onReturnToComposer, rememberOwnSteer } from './composerReturn'
import { dispatch } from '../../stream/store'
import { useBootstrap } from '../../app/bootstrap'
import { cn } from '../../ui/cn'
import { showToast } from '../toast/toast'
import { AttachmentTray, type PendingFile } from './Attachments'
import { CommandPaletteList, useCommandPalette } from './CommandPalette'
import { parseCommand, resolveCommand, runsOnServer, type CommandSuggestion } from './commands'
import { ContextRing, ContextRow, type ContextFigures, ModelChip, ReasoningChip, ToolsetsChip, WorkspaceChip } from './chips'
import { clearDraft, readLocalDraft, useDraftPersistence, useServerDraft } from './useDraft'
import { createRecognition, dictationSupported, classifyDictationError } from '../voice/dictation'
import { ProfileMenu } from '../../shell/ProfileMenu'
import { setTheme } from '../../app/appearance'
import { ThemeSchema } from '../../contracts/persisted'
import type { Clarify } from '../chat/useClarify'
import { LiveStatusPill } from '../chat/LiveTurnView'
import { ComposerTab, type ComposerNotice } from './ComposerTab'
import { useBtw } from './useBtw'
import { useCommandOutput } from './useCommandOutput'
import { BackgroundWorkCard, useBackgroundTasks } from '../background/BackgroundWork'
import { beginFirstSend, endFirstSend, failFirstSend, getFirstSend, ownsFirstSend, useFirstSend } from '../chat/firstSend'
import { REST_MS, onComposerRestRequest, requestScroll } from '../chat/sendMotion'
import { MOTION_EASE, prefersReducedMotion } from '../../lib/motion'
import { randomHex } from '../../lib/randomHex'
import { QueueCard } from './QueueCard'
import type { QueuedTurn } from './queue'
import { stopSpeaking } from '../voice/tts'

export type BusyMode = 'steer' | 'queue' | 'interrupt'

export interface ComposerProps {
  sessionId: string | null
  session: Session | null
  /** Choices made on the unsaved chat, shown by the chips until the session exists. */
  pendingChoices?: { model?: string; model_provider?: string | null; workspace?: string; enabled_toolsets?: string[] | null } | undefined
  live: LiveTurn | null
  settings: Settings | undefined
  /** Creates the unsaved chat's session; `onCreated` hears its id before the route changes to it. */
  onEnsureSession: (onCreated?: (sessionId: string) => void) => Promise<Session>
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
  /** The queue after an edit, removal or move. */
  onQueueChange: (queued: QueuedTurn[]) => void
  /** Sending is disabled (e.g. while a manual compression job runs). */
  locked?: boolean | undefined
  /** A pending clarification: the box becomes its answer input and the chat draft and attachments wait untouched. */
  clarify?: Clarify | null | undefined
  /** Entries for the top tab from outside the composer (connection and runtime state); they lead the tab. */
  notices?: ComposerNotice[] | undefined
}

const PHONE = '(max-width: 640px)'
const MESSAGE_ONLY_CONTROLS = new Set(['hide_composer_attach', 'hide_composer_mic', 'hide_composer_profile', 'hide_composer_workspace', 'hide_composer_model', 'hide_composer_reasoning'])
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

/** What a turn posts besides its text: the session's model and workspace, and the active profile. */
export function turnRequest(target: Session, profile: string): QueuedTurn['request'] {
  return { model: target.model ?? undefined, model_provider: target.model_provider ?? undefined, workspace: target.workspace, profile }
}

/**
 * Whether a one-line draft would soft-wrap in the box. Measured once per rest request with a canvas, never per
 * keystroke (UIUX guide, Composer sizing): a draft that wraps is multi-line and keeps the composer expanded.
 */
function draftWraps(el: HTMLTextAreaElement, text: string): boolean {
  if (!text) return false
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return false
  const style = getComputedStyle(el)
  ctx.font = style.font
  return ctx.measureText(text).width > el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
}

function fileKey(f: File): string {
  return `${f.name}:${f.size}:${f.lastModified}`
}

/**
 * The composer: textarea with send-key preference, attachments (click, drop,
 * paste), slash commands, busy modes (steer / queue / interrupt), dictation,
 * and the model, reasoning, toolsets, workspace and profile chips.
 */
/**
 * Draft and files handed from the empty chat's composer to the one mounted for the session it just created, and only
 * that one: `sessionId` is set once the session exists. The draft is read at adoption, so text typed or pasted while
 * the session is created comes along too.
 */
let handoff: { draft: { readonly current: string }; files: File[]; sessionId: string | null } | null = null

export function Composer(props: ComposerProps) {
  const { sessionId, session, live, settings, onEnsureSession, onLocalCommand, terminalOpen, onToggleTerminal, onModelChange, onWorkspaceChange, onToolsetsChange, onReasoningChange, reasoning, reasoningLevels, reasoningSupported = true, pendingChoices, locked = false, yolo, onToggleYolo, queued, onQueue, onQueueChange, clarify, notices = [] } = props
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
  // Refit only when the footer's geometry or content changes (viewport, chips, buttons, labels). Typing and stream
  // renders change neither, so they never force the measuring layout pass (TAL-278). Class changes are not observed:
  // the fit pass sets them itself.
  const readOnly = !!session?.read_only
  useLayoutEffect(() => {
    const f = footer.current
    const left = f?.querySelector('.composer-left')
    if (!f || !left) return
    fitFooter()
    const ro = new ResizeObserver(() => fitFooter())
    ro.observe(f)
    ro.observe(left)
    const mo = new MutationObserver(() => fitFooter())
    mo.observe(f, { childList: true, subtree: true, characterData: true })
    return () => { ro.disconnect(); mo.disconnect() }
  }, [fitFooter, readOnly])
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
  // When a clarification takes the box over, dictation into the parked draft stops: its control is hidden, and
  // later results must not land in the draft. `onend` then clears the dictating state.
  const answering = !!clarify
  useEffect(() => {
    const r = recognition.current
    if (!answering || !r) return
    r.onresult = null
    r.stop()
  }, [answering])
  const busy = !!live && !isTerminal(live.status)
  const busyMode: BusyMode = (settings?.default_message_mode as BusyMode | undefined) ?? 'steer'
  const sendKey = settings?.send_key ?? 'enter'
  // While a clarification is pending the box edits its answer; the chat draft keeps its own state.
  const value = clarify ? clarify.text : text
  const setValue = clarify ? clarify.setText : setText
  const palette = useCommandPalette(clarify ? '' : text)
  const catalog = palette.catalog
  useDraftPersistence(sessionId, text)
  useServerDraft(sessionId, setText)

  // T3 Code's resting composer: a hand scroll of an overflowing transcript flattens the card to one row until the next
  // composer interaction. Losing focus never rests it. A request is decided when it arrives and never left pending, so
  // closing a menu later cannot flatten the card without a new scroll.
  const [restRequested, setRestRequested] = useState(false)
  const restBlocked = useRef<() => boolean>(() => true)
  useEffect(() => onComposerRestRequest(() => { if (!restBlocked.current()) setRestRequested(true) }), [])
  const wake = () => { if (restRequested) setRestRequested(false) }

  // Session change resets the draft and tray, unless this session's composer just adopted a hand-off (below); the
  // guard also keeps StrictMode's effect replay from wiping the adopted state.
  const adopted = useRef<string | null>(null)
  // Each chip's upload in flight; a receipt whose attempt is gone (chip removed, tray reset) is rolled back.
  const inflight = useRef(new Map<string, object>())
  useEffect(() => {
    if (adopted.current === sessionId) return
    setText(sessionId ? readLocalDraft(sessionId) : '')
    setFiles([])
    inflight.current.clear()
    setRestRequested(false)
  }, [sessionId])

  // Autosize.
  useEffect(() => {
    const el = textarea.current
    if (!el) return
    // Native sizing where supported (upstream #6760); otherwise measure. An empty composer keeps its resting
    // height rather than the placeholder's wrapped height.
    if (!value || (typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content'))) { el.style.height = ''; return }
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`
  }, [value])

  const draft = useRef(text)
  useLayoutEffect(() => { draft.current = text })
  const maxBytes = bootstrap.max_upload_bytes
  const upload = useCallback((key: string, file: File) => {
    if (!sessionId) return
    const attempt = {}
    inflight.current.set(key, attempt)
    void api.uploadFile(sessionId, file).then(
      (receipt) => {
        if (inflight.current.get(key) !== attempt) {
          if (receipt.rollback_token) void api.rollbackUpload(sessionId, [receipt.rollback_token]).catch(() => undefined)
          return
        }
        inflight.current.delete(key)
        setFiles((prev) => prev.map((p) => (p.key === key ? { ...p, status: 'done', upload: receipt } : p)))
      },
      (e: unknown) => {
        if (inflight.current.get(key) !== attempt) return
        inflight.current.delete(key)
        setFiles((prev) => prev.map((p) => (p.key === key ? { ...p, status: 'error', error: e instanceof Error ? e.message : String(e) } : p)))
        showToast(m.composer_upload_failed({ name: file.name }), 4000, 'error')
      },
    )
  }, [sessionId])
  const addFiles = useCallback((incoming: FileList | File[]) => {
    // One chip and one upload per file, however often it is picked, pasted or handed off.
    const list = Array.from(incoming).filter((file, i, all) => all.findIndex((f) => fileKey(f) === fileKey(file)) === i)
    if (list.length === 0) return
    const pending = list.map((file): PendingFile => ({ key: fileKey(file), file, status: 'uploading' }))
    const add = (rows: PendingFile[]) => setFiles((prev) => [...prev, ...rows.filter((r) => !prev.some((p) => p.key === r.key))])
    // Attaching to the empty chat: the index route and the session route mount separate composers, so the navigation
    // that lazy session creation causes would drop this state. Hand the draft and files to the composer that mounts
    // for the new session; it runs the uploads. A selected session uploads by its id, loaded or not, so attaching
    // while its transcript loads never creates another session.
    if (!sessionId) {
      add(pending)
      // One session per hand-off: files attached while it is created join it.
      if (handoff) { const h = handoff; h.files.push(...list.filter((file) => !h.files.some((f) => fileKey(f) === fileKey(file)))); return }
      const h = { draft, files: list, sessionId: null as string | null }
      handoff = h
      void onEnsureSession((id) => { h.sessionId = id }).catch((e: unknown) => {
        const error = e instanceof Error ? e.message : String(e)
        if (handoff === h) handoff = null
        setFiles((prev) => prev.map((p) => (p.status === 'uploading' ? { ...p, status: 'error', error } : p)))
        showToast(error, 4000, 'error')
      })
      return
    }
    const fresh = pending.filter((p) => {
      if (files.some((f) => f.key === p.key)) return false
      if (p.file.size <= maxBytes) return true
      showToast(m.composer_too_large({ name: p.file.name, max: Math.round(maxBytes / 1024 / 1024) }), 4000, 'error')
      return false
    })
    add(fresh)
    for (const p of fresh) upload(p.key, p.file)
  }, [maxBytes, sessionId, onEnsureSession, files, upload])

  // Adopt a hand-off from the empty chat's composer (see addFiles). Runs after the session-change reset above.
  useEffect(() => {
    if (!sessionId || handoff?.sessionId !== sessionId) return
    const h = handoff; handoff = null
    adopted.current = sessionId
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time adoption of module state left by the composer that unmounted
    setText(h.draft.current)
    addFiles(h.files)
  }, [sessionId, addFiles])

  // A first send that failed hands its text back to the composer now mounted for it (sendMotion.ts).
  const firstSend = useFirstSend()
  useEffect(() => {
    if (!firstSend?.failed || !ownsFirstSend(firstSend, sessionId)) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hand-back from the first-send store
    setText(firstSend.text)
    endFirstSend()
  }, [firstSend, sessionId])

  const removeFile = (key: string) => {
    const f = files.find((p) => p.key === key)
    setFiles((prev) => prev.filter((p) => p.key !== key))
    inflight.current.delete(key)
    // Removed before the new chat exists: the file must not ride the hand-off into it.
    if (handoff) handoff.files = handoff.files.filter((file) => fileKey(file) !== key)
    if (f?.upload?.rollback_token && sessionId) void api.rollbackUpload(sessionId, [f.upload.rollback_token]).catch(() => undefined)
  }
  // A failed upload runs again; without a session yet, the file goes back through the hand-off.
  const retryFile = (key: string) => {
    const f = files.find((p) => p.key === key)
    if (!f) return
    if (!sessionId) { setFiles((prev) => prev.filter((p) => p.key !== key)); addFiles([f.file]); return }
    setFiles((prev) => prev.map((p) => (p.key === key ? { ...p, status: 'uploading', error: undefined } : p)))
    upload(key, f.file)
  }

  // Steer: deliver mid-run, shown in the turn as a pending user message; if the server did not accept it, the draft stays in the box.
  const trySteer = useCallback(async (text: string): Promise<boolean> => {
    if (!sessionId) return false
    const steerId = `steer-${randomHex()}`
    // TAL-425: shown as sending until the server reports it; a Stop that withdraws it gives the text back to this tab.
    dispatch({ type: 'steer_sending', sessionId, steerId, text })
    rememberOwnSteer(steerId)
    try {
      const r = await api.steerChat({ session_id: sessionId, text, steer_id: steerId })
      // TAL-460: sent during a background turn, the message became the user's own turn; follow it like a send.
      if (r.started_turn) { adoptTurn(sessionId, text, r.started_turn); return true }
      if (r.accepted) return true
      dispatch({ type: 'steer_refused', sessionId, steerId })
      forgetOwnSteer(steerId)
      showToast(r.fallback === 'gateway_steer_queued' ? m.steer_leftover_queued() : m.busy_steer_fallback(), 2500)
    } catch (e) {
      dispatch({ type: 'steer_refused', sessionId, steerId })
      forgetOwnSteer(steerId)
      showToast(e instanceof Error ? e.message : String(e), 4000, 'error')
    }
    return false
  }, [sessionId])

  // Snapshot of what a send would post right now, for the queue.
  const queueEntry = useCallback((text: string): QueuedTurn => ({ id: randomHex(), text, attachments: files.flatMap((f) => (f.status === 'done' && f.upload ? [f.upload] : [])), request: session ? turnRequest(session, bootstrap.profile?.name ?? 'default') : { profile: bootstrap.profile?.name ?? 'default' } }), [files, session, bootstrap.profile])

  // TAL-425: a steer taken back (Edit, or a Stop of this tab's steer) returns after the draft, with a blank line between.
  useEffect(() => {
    if (!sessionId) return
    return onReturnToComposer(sessionId, (returned) => {
      setText((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')}\n\n${returned}` : returned))
      textarea.current?.focus()
    })
  }, [sessionId])

  const { ask: askBtw, notice: btwNotice } = useBtw(sessionId)
  const { run: runCommand, notice: commandNotice } = useCommandOutput(sessionId)

  const send = useCallback(async () => {
    if (locked) { showToast(m.live_compressing(), 1500); return }
    const value = text.trim()
    if (sending) return
    if (!value && files.length === 0) return
    if (files.some((f) => f.status === 'uploading')) { showToast(m.loading()); return }
    const parsed = parseCommand(value)
    // TAL-314: a typed alias resolves to its server catalog entry; one Web cannot run shows the server's message.
    const entry = parsed ? resolveCommand(parsed.name, catalog) : undefined
    if (entry && !entry.clients.includes('web')) { showToast(entry.unsupported_message ?? m.cmd_unsupported(), 3000); return }
    // TAL-561: an entry the server runs shows its output in the composer tab; it never reaches the model.
    if (entry && runsOnServer(entry)) { setText(''); void runCommand(value); return }
    const cmd = parsed && { ...parsed, name: entry?.name ?? parsed.name }
    if (cmd) {
      if (cmd.name === 'theme') { const v = ThemeSchema.safeParse(cmd.args); if (v.success) setTheme(v.data); setText(''); return }
      if (await onLocalCommand(cmd.name, cmd.args)) { setText(''); return }
      // TAL-372: `/background` runs the prompt in a hidden session; its record and result show in the background card.
      if (cmd.name === 'background') {
        if (!cmd.args) { showToast(m.bg_usage(), 2000); return }
        try {
          const target = session ?? (await onEnsureSession())
          await api.startBackground(target.session_id, cmd.args)
          setText('')
          void qc.invalidateQueries({ queryKey: keys.background(target.session_id) })
        } catch (e) { showToast(e instanceof Error ? e.message : String(e), 4000, 'error') }
        return
      }
      // TAL-518: a side question never steers or sends; its answer shows in the composer tab, running or idle.
      if (cmd.name === 'btw') {
        if (!cmd.args) { showToast(m.cmd_btw_usage(), 2000); return }
        if (!sessionId) { showToast(m.btw_needs_chat(), 2000); return }
        setText('')
        void askBtw(cmd.args)
        return
      }
      if (cmd.name === 'queue' && busy) { requestScroll('end'); onQueue(queueEntry(cmd.args)); setText(''); setFiles([]); return }
      if (cmd.name === 'steer' && busy && sessionId) { if (!cmd.args) { showToast(m.cmd_steer_no_msg(), 2000); return } requestScroll('end'); if (await trySteer(cmd.args)) setText(''); return }
      if (cmd.name === 'interrupt' && busy && sessionId) { requestScroll('end'); await cancelTurn(sessionId); onQueue(queueEntry(cmd.args)); setText(''); setFiles([]); return }
    }
    requestScroll('end')
    if (busy && sessionId) {
      if (busyMode === 'queue') { onQueue(queueEntry(value)); setText(''); setFiles([]); return }
      if (busyMode === 'steer') { if (await trySteer(value)) setText(''); return }
      await cancelTurn(sessionId)
      onQueue(queueEntry(value))
      setText('')
      setFiles([])
      return
    }
    // The selected session's transcript is still loading: sending must not start a new chat in its place.
    if (sessionId && !session) { showToast(m.loading()); return }
    // First send from the unsaved chat: the hero gives way and the text shows as the pending user row at once, before
    // the session or the turn exists. The index view unmounts mid-send, so a failure returns the text through the store.
    if (!session) {
      if (getFirstSend()) return
      beginFirstSend(value)
      setText('')
      try {
        const target = await onEnsureSession()
        const started = await startTurn({ sessionId: target.session_id, message: value, request: turnRequest(target, bootstrap.profile?.name ?? 'default') })
        // A turn admitted without a stream leaves no live row; hold the pending one until the session payload carries it.
        if (!started.stream_id) await qc.refetchQueries({ queryKey: keys.sessions.detail(target.session_id) })
        clearDraft(target.session_id)
        endFirstSend()
        void qc.invalidateQueries({ queryKey: keys.sessions.all })
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e), 5000, 'error')
        failFirstSend()
      }
      return
    }
    setSending(true)
    try {
      const target = session
      const attachments = files.flatMap((f) => (f.status === 'done' && f.upload ? [f.upload] : []))
      await startTurn({ sessionId: target.session_id, message: value, request: { ...turnRequest(target, bootstrap.profile?.name ?? 'default'), ...(attachments.length ? { attachments } : {}) } })
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
  }, [text, files, sending, session, onEnsureSession, busy, busyMode, sessionId, trySteer, locked, queueEntry, onQueue, onLocalCommand, bootstrap.profile, qc, askBtw, runCommand, catalog])

  const applySuggestion = (s: CommandSuggestion) => { setText(`/${s.name} `); textarea.current?.focus() }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    wake()
    if (palette.handleKey(e, applySuggestion)) return
    if (e.key !== 'Enter') return
    // A clarification answer is short: Enter answers on every width, whatever the chat send-key rule.
    if (clarify) { if (!e.shiftKey) { e.preventDefault(); clarify.send() } return }
    const isNumpad = e.code === 'NumpadEnter'
    const mobile = window.matchMedia('(max-width: 640px)').matches
    if (sendKey === 'ctrl+enter' || mobile) {
      if (isNumpad || e.ctrlKey || e.metaKey) { e.preventDefault(); void send() }
      return
    }
    if (!e.shiftKey) { e.preventDefault(); void send() }
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    // A clarification answer is text only: pasted files and long text stay out of the parked message.
    if (clarify) return
    // Real files attach; string items (rich-text HTML and the like) never do. Accompanying plain text pastes natively.
    const pastedFiles = Array.from(e.clipboardData.items).filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f)
    const pasted = e.clipboardData.getData('text/plain')
    if (settings?.large_text_paste_as_attachment !== false && pasted.length > 8000) {
      e.preventDefault()
      const name = `pasted-${Date.now()}.txt`
      pastedFiles.push(new File([pasted], name, { type: 'text/plain' }))
      showToast(m.text_pasted() + name, 2500)
    } else if (pastedFiles.length && !pasted) e.preventDefault()
    addFiles(pastedFiles)
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragOver(false); if (!clarify) addFiles(e.dataTransfer.files) }

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

  // While a clarification owns the box, the message-only controls leave the footer (docs/ui-ux clarify-card).
  const hide = (k: string) => (!!clarify && MESSAGE_ONLY_CONTROLS.has(k)) || !!(settings as Record<string, unknown> | undefined)?.[k]
  const modelChoice = session?.model ? { model: session.model, optionId: session.model_option_id ?? null } : { model: pendingChoices?.model ?? null, optionId: pendingChoices?.model ?? null }
  const placeholder = clarify ? (clarify.step.choices.length ? m.clarify_composer_placeholder_choices() : m.clarify_composer_placeholder()) : busy ? (busyMode === 'queue' ? m.composer_placeholder_busy_queue() : busyMode === 'interrupt' ? m.composer_placeholder_busy_interrupt() : m.composer_placeholder_busy_steer()) : m.composer_placeholder()
  const context: ContextFigures = { percent: session?.context_usage_percent, used: session?.context_used_tokens, window: session?.context_window_tokens, thresholdPercent: session?.context_threshold_percent }
  const canSend = (text.trim() !== '' || files.some((f) => f.status === 'done')) && !sending && !locked
  // Phone composer at rest: one prompt row (UIUX guide), and the strip under it folds away too.
  const collapsed = phone && !text && files.length === 0 && !busy && !focusWithin && !configOpen && !dragOver
  // Phones keep their own collapsed row; a multi-line draft, attachments, an open menu, or a clarification stay expanded.
  const restAllowed = !phone && !value.includes('\n') && files.length === 0 && !configOpen && !palette.open && !clarify && !dragOver
  const resting = restRequested && restAllowed
  useEffect(() => { restBlocked.current = () => !restAllowed || (!!textarea.current && draftWraps(textarea.current, value)) })
  // Flattening and lifting ease the card's height (~200 ms) instead of snapping; reduced motion snaps. A ResizeObserver
  // keeps the last settled height, so typing never forces a layout read (UIUX guide, Composer sizing).
  const lastHeight = useRef(0)
  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const wrap = el.parentElement
    // The same observer records the card's bottom edge (`--composer-card-bottom`), where the wash under the composer turns
    // opaque: layout is settled inside the callback, so reading the card's offset costs nothing on the typing path.
    const ro = new ResizeObserver(() => {
      lastHeight.current = el.offsetHeight
      wrap?.style.setProperty('--composer-card-bottom', `${el.offsetTop + el.offsetHeight}px`)
    })
    ro.observe(el)
    if (wrap) ro.observe(wrap)
    return () => ro.disconnect()
  }, [])
  const restMounted = useRef(false)
  const restAnimation = useRef<Animation | null>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!restMounted.current) { restMounted.current = true; return }
    if (!el || !lastHeight.current || typeof el.animate !== 'function' || prefersReducedMotion()) return
    // A toggle mid-animation starts from where the card is now, not from a height it never reached.
    const from = restAnimation.current ? el.getBoundingClientRect().height : lastHeight.current
    restAnimation.current?.cancel()
    const to = el.offsetHeight
    if (Math.abs(to - from) < 1) { restAnimation.current = null; return }
    const animation = el.animate([{ height: `${from}px`, overflow: 'hidden' }, { height: `${to}px`, overflow: 'hidden' }], { duration: REST_MS, easing: MOTION_EASE })
    restAnimation.current = animation
    animation.onfinish = () => { if (restAnimation.current === animation) restAnimation.current = null }
  }, [resting])
  const showYolo = yolo && !hide('hide_composer_yolo')
  const backgroundTasks = useBackgroundTasks(sessionId).data?.tasks ?? []
  // The top tab (T3 Code's attached banner): the running turn first, then runtime notices and this message's state.
  const tabNotices: ComposerNotice[] = [
    ...(busy && live ? [{ id: 'live', content: <LiveStatusPill turn={live} background={session?.active_turn_origin === 'background' && session.active_stream_id === live.streamId} /> }] : []),
    ...notices,
    ...(btwNotice ? [btwNotice] : []),
    ...(commandNotice ? [commandNotice] : []),
    ...(dictating ? [{ id: 'dictation', content: <span className="inline-flex items-center gap-1.5" role="status"><span className="mic-dot" aria-hidden="true" />{m.voice_listening()}</span> }] : []),
    ...(showYolo ? [{ id: 'yolo', tone: 'warning' as const, content: <><span aria-hidden="true">⚡</span><span className="truncate">{m.yolo_tab_active()}</span></>, action: { label: m.yolo_turn_off(), run: onToggleYolo } }] : []),
    ...(sessionId && backgroundTasks.some((t) => t.pinned) ? [{ id: 'background', content: <BackgroundWorkCard sessionId={sessionId} tasks={backgroundTasks} /> }] : []),
    ...(sessionId && queued.length > 0 ? [{ id: 'queue', content: <QueueCard sessionId={sessionId} queued={queued} onChange={onQueueChange} /> }] : []),
  ]
  // A `/btw` draft asks beside the turn instead of steering, queueing or interrupting it (TAL-518).
  const busyLabel = parseCommand(text)?.name === 'btw' ? m.composer_send() : busyMode === 'queue' ? m.composer_queue() : busyMode === 'interrupt' ? m.composer_interrupt() : m.composer_steer()

  // The server marks sessions Web may not continue (TAL-312); it would refuse every send, so none is offered.
  if (session?.read_only) return <div className="composer-wrap" id="composerWrap"><div className="mx-auto max-w-(--msg-max) px-3 py-2 text-center text-xs text-muted" role="note">{m.session_read_only_notice()}</div></div>

  return (
    <div className="composer-wrap" id="composerWrap">
      <ComposerTab notices={tabNotices} />
      <div
        className={cn('composer-box relative z-[2] flex flex-col mx-auto max-w-(--msg-max) border-(length:--composer-border-width) border-(--composer-border-color) rounded-(--composer-radius) shadow-(--composer-shadow) transition-[border-color,box-shadow] duration-(--dur) ease-(--ease) focus-within:border-(--composer-focus-border) focus-within:shadow-(--composer-focus-shadow) focus-within:outline-none max-[641px]:rounded-(--composer-radius-phone)', dragOver && 'drag-over', clarify && 'clarify-active', resting && 'is-resting')}
        id="composerBox"
        ref={box}
        onFocus={() => { setFocusWithin(true); wake() }}
        onPointerDown={wake}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocusWithin(false) }}
        onDragOver={(e) => { e.preventDefault(); wake(); if (!clarify) setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {palette.open && <CommandPaletteList items={palette.items} active={palette.active} listId={palette.listId} onPick={applySuggestion} onHover={palette.setActive} />}
        {dragOver && <div className="drop-hint active" id="dropHint" aria-hidden="true">{m.drop_files_to_attach()}</div>}
        {!clarify && <AttachmentTray files={files} onRemove={removeFile} onRetry={retryFile} />}
        <textarea
          ref={textarea}
          id="msg"
          rows={1}
          value={value}
          // Typing silences a reply being read aloud (Settings > Speech).
          onChange={(e) => { stopSpeaking(); setValue(e.target.value) }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          aria-label={clarify ? clarify.step.question : m.composer_placeholder()}
          aria-autocomplete={palette.open ? 'list' : undefined}
          aria-controls={palette.open ? palette.listId : undefined}
          aria-activedescendant={palette.activeId}
          role={palette.open ? 'combobox' : undefined}
          aria-expanded={palette.open ? true : undefined}
        />
        <div ref={footer} className={cn('composer-footer', stage !== 'full' && 'cf-icons', stage === 'burger' && 'cf-burger', collapsed && 'cf-collapsed')}>
          <div className="composer-left flex items-center gap-1 min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] max-[641px]:flex-[1_1_auto] max-[641px]:w-auto max-[641px]:flex-nowrap max-[641px]:items-center max-[641px]:gap-x-2.5 max-[641px]:gap-y-0 max-[641px]:max-h-none max-[641px]:[-webkit-overflow-scrolling:touch] max-[341px]:gap-x-0.5">
            {!hide('hide_composer_model') && <div className="composer-model-wrap"><ModelChip {...modelChoice} onChange={onModelChange} /></div>}
            {!hide('hide_composer_reasoning') && reasoningSupported && <div className="composer-reasoning-wrap"><ReasoningChip value={reasoning} levels={reasoningLevels} onChange={onReasoningChange} /></div>}
            <button className="icon-btn composer-mobile-config-btn has-tooltip" id="composerMobileConfigBtn" type="button" data-tooltip={m.composer_config_title()} aria-label={m.composer_config_title()} aria-expanded={configOpen} aria-controls="composerMobileConfigPanel" onClick={() => setConfigOpen((o) => !o)}>
              <SlidersHorizontal size={16} aria-hidden="true" />
            </button>
          </div>
          <div className="composer-right flex gap-1.5 items-center shrink-0 max-[641px]:flex-none max-[641px]:w-auto max-[641px]:justify-end max-[641px]:min-w-0">
            <div className="composer-tools flex items-center gap-0.5">
              {!hide('hide_composer_attach') && (
                <>
                  <input type="file" id="fileInput" multiple className="file-input-visually-hidden" onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }} accept="image/*,text/*,application/pdf,application/json,.csv,.md" />
                  <button type="button" className="icon-btn has-tooltip" id="btnAttach" data-tooltip={m.composer_control_attach()} aria-label={m.composer_control_attach()} onClick={() => document.getElementById('fileInput')?.click()}><Paperclip size={16} aria-hidden="true" /></button>
                </>
              )}
              {!hide('hide_composer_mic') && dictationSupported() && <button type="button" className={cn('icon-btn mic-btn has-tooltip', dictating && 'active')} id="btnMic" data-tooltip={dictating ? m.voice_dictate_active() : m.voice_dictate()} aria-label={dictating ? m.voice_dictate_active() : m.voice_dictate()} aria-pressed={dictating} onClick={toggleDictation}><Mic size={16} aria-hidden="true" /></button>}
            </div>
            {!hide('hide_composer_context') && <ContextRing {...context} />}
            {clarify && (
              <button type="button" onClick={clarify.send} disabled={!clarify.canSend} className="send-btn has-tooltip has-tooltip--left" id="btnClarifySend" data-tooltip={clarify.index < clarify.total - 1 ? m.composer_clarify_next() : m.composer_clarify()} aria-label={clarify.index < clarify.total - 1 ? m.composer_clarify_next() : m.composer_clarify()}>
                <ArrowUp size={14} aria-hidden="true" />
              </button>
            )}
            {busy ? (
              <>
                <button type="button" onClick={() => { if (sessionId) void cancelTurn(sessionId) }} className="send-btn stop has-tooltip has-tooltip--left" id="btnStop" data-tooltip={m.composer_stop()} aria-label={m.composer_stop()} title={m.composer_stop()}>
                  <Square size={12} fill="currentColor" strokeWidth={0} aria-hidden="true" />
                </button>
                {/* A typed draft steers, queues or interrupts mid-turn like Enter does, so it gets a send arrow beside Stop. */}
                {!clarify && canSend && (
                  <button type="button" onClick={() => { void send() }} className="send-btn has-tooltip has-tooltip--left" id="btnSend" data-tooltip={busyLabel} aria-label={busyLabel} title={busyLabel}>
                    <ArrowUp size={14} aria-hidden="true" />
                  </button>
                )}
              </>
            ) : !clarify && (
              <button type="button" onClick={() => { void send() }} disabled={!canSend} className="send-btn has-tooltip has-tooltip--left" id="btnSend" data-tooltip={m.composer_send()} aria-label={m.composer_send()} title={m.composer_send()}>
                <ArrowUp size={14} aria-hidden="true" />
              </button>
            )}
          </div>
          <div className={cn('composer-mobile-config-panel', configOpen && 'open')} id="composerMobileConfigPanel" role="group" aria-label={m.composer_config_title()}>
            {stage === 'burger' && !hide('hide_composer_model') && <ModelChip row {...modelChoice} onChange={onModelChange} />}
            {stage === 'burger' && !hide('hide_composer_reasoning') && reasoningSupported && <ReasoningChip row value={reasoning} levels={reasoningLevels} onChange={onReasoningChange} />}
            {/* The chat header carries the terminal toggle above phone width. */}
            {stage === 'burger' && phone && <button type="button" className={cn('icon-btn', terminalOpen && 'active')} id="btnTerminal" title={m.composer_terminal_toggle()} aria-label={m.composer_terminal_toggle()} aria-pressed={terminalOpen} onClick={() => { setConfigOpen(false); onToggleTerminal() }}><TerminalSquare size={16} aria-hidden="true" /><span className="composer-mobile-config-value">{m.composer_terminal_toggle()}</span></button>}
            {stage === 'burger' && !hide('hide_composer_context') && <ContextRow {...context} />}
          </div>
        </div>
      </div>
      {/* T3 Code's context strip: where the message runs (workspace, toolsets, profile), tucked under the card. */}
      {!collapsed && (!hide('hide_composer_workspace') || !hide('hide_composer_toolsets') || !hide('hide_composer_profile')) && (
        <div className="composer-strip" role="group" aria-label={m.composer_config_title()}>
          {!hide('hide_composer_workspace') && <WorkspaceChip value={session?.workspace ?? pendingChoices?.workspace ?? settings?.default_workspace} name={session ? session.workspace_name ?? null : undefined} onChange={onWorkspaceChange} />}
          {!hide('hide_composer_toolsets') && <ToolsetsChip value={session?.enabled_toolsets ?? pendingChoices?.enabled_toolsets ?? null} onChange={onToolsetsChange} />}
          {!hide('hide_composer_profile') && <ProfileMenu />}
        </div>
      )}
    </div>
  )
}
