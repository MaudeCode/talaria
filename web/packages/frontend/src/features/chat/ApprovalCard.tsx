import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, Loader2, X } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import type { ApprovalPending } from '../../contracts'
import * as api from '../../api/endpoints'
import { Menu, MenuItem } from '../../ui/Menu'
import { IconButton } from '../../ui/Button'
import { keys } from '../../api/queryKeys'
import { usePromptAnswer } from './usePromptAnswer'
import { cn } from '../../ui/cn'
import { isImeEnter } from '../../lib/isImeEnter'
import { showToast } from '../toast/toast'
import { prefersReducedMotion } from '../../lib/motion'
import { Keys } from '../../ui/Keys'
import { ToolKindIcon } from './toolKind'
import { FieldRows, toolCardLabel } from './blocks/ToolCard'
import { useLocale } from '../../i18n/useLocale'
import { HelpTip } from '../../ui/Field'

// Focusable, editable and ARIA widget ancestors own their keyboard activation, including nested icons.
const interactiveTarget = [
  'button', 'a', 'input', 'select', 'textarea', 'summary', '[tabindex]',
  'audio[controls]', 'video[controls]', 'iframe', 'object', 'embed',
  '[contenteditable]:not([contenteditable="false"])',
  ...['button', 'link', 'checkbox', 'combobox', 'grid', 'gridcell', 'listbox', 'menu', 'menubar',
    'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'radiogroup', 'scrollbar',
    'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'tablist', 'textbox', 'tree', 'treegrid', 'treeitem']
    .map((role) => `[role~="${role}"]`),
].join(',')

/** TAL-974: the server's scope as one sentence, with what Always allow keeps when the approval offers it. */
function scopeSentence(pending: ApprovalPending): string | null {
  const scope = pending.scope
  if (!scope) return null
  const subject = scope.subject ?? ''
  const session = {
    command_pattern: () => m.approval_scope_command_pattern({ subject }), tool_rule: () => m.approval_scope_tool_rule({ subject }),
    python: m.approval_scope_python, ssh_config: m.approval_scope_ssh_config, computer_use: () => m.approval_scope_computer_use({ subject }),
    security_finding: m.approval_scope_security_finding, unknown: m.approval_scope_unknown,
  }[scope.kind]()
  if (!pending.allowed_choices.includes('always')) return session
  return `${session} ${scope.always_is_session_only ? m.approval_scope_always_session_only() : m.approval_scope_always()}`
}

/** How long the exit waits for its transition to report its end: past the 320 ms slide in approvals.css. */
const EXIT_FALLBACK_MS = 500

/** TAL-2022: the server's "in plain words" summary under the command; only this line shows a busy state while it is written. */
function ApprovalExplanation({ explanation }: { explanation: NonNullable<ApprovalPending['explanation']> }) {
  return (
    <p className="approval-explanation mt-2 text-[13px] text-muted" data-state={explanation.state} aria-live="polite">
      <span className="font-medium text-text">{m.approval_explanation_label()}</span>{' '}
      {explanation.state === 'pending'
        ? <span className="inline-flex items-center gap-1.5"><Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />{m.approval_explanation_pending()}</span>
        : explanation.state === 'ready' ? explanation.text : m.approval_explanation_unavailable()}
    </p>
  )
}

/**
 * Destructive-command approval. Rendered inline above the composer (legacy
 * placement) with alertdialog semantics; Enter answers "allow once" when focus
 * is outside interactive controls. An answer slides it back behind the composer (TAL-1783), and it resolves once that
 * exit has finished and the server has taken the answer; a refusal brings it back. Cleared early by the terminal event.
 */
export function ApprovalCard({ sessionId, pending, onResolved, onLeaving, onDismissed, transport }: { sessionId: string; pending: ApprovalPending; onResolved: () => void; onLeaving?: (leaving: boolean) => void; onDismissed?: () => void; transport?: { send: (choice: 'once' | 'session' | 'always' | 'deny') => Promise<unknown>; waiting: () => Promise<boolean> } }) {
  const headingId = useId(), descriptionId = useId()
  const locale = useLocale()
  const [collapsed, setCollapsed] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  // The server says whether this deny can carry an instruction (TAL-1912); the text stays through a refusal or Esc.
  const canTell = pending.can_deny_with_instruction === true
  const [tellOpen, setTellOpen] = useState(false)
  const [instruction, setInstruction] = useState('')
  const telling = canTell && tellOpen
  const refocusTell = useRef(false)
  const [confirmed, setConfirmed] = useState<string | null>(null)
  const [exited, setExited] = useState(false)
  // The card starts leaving as soon as the user answers; a refused answer brings it back with the error.
  const resource = `approval:${sessionId}:${pending.approval_id ?? ''}`
  const { answer, answered: isAnswered } = usePromptAnswer({
    resource: () => resource, queryKey: keys.approval(sessionId),
    send: async ({ choice, yolo, instruction: told }: { choice: 'once' | 'session' | 'always' | 'deny'; yolo: boolean; instruction?: string }) => {
      if (transport) return transport.send(choice)
      const result = await api.respondApproval({ session_id: sessionId, choice, ...(pending.approval_id ? { approval_id: pending.approval_id } : {}), ...(told ? { instruction: told } : {}), ...(pending.run_id ? { run_id: pending.run_id } : {}), ...(pending.mirror_token ? { mirror_token: pending.mirror_token } : {}), ...(yolo ? { yolo: true } : {}) })
      if (result.instruction_outcome === 'unconfirmed') showToast(m.approval_tell_unconfirmed(), 4000, 'error')
      return result
    },
    waiting: transport?.waiting ?? (async () => { const { pending: head } = await api.fetchApprovalPending(sessionId); return !!head && (head.approval_id ?? '') === (pending.approval_id ?? '') }),
    onAnswered: () => { setConfirmed(resource) },
  })
  const answered = isAnswered(resource) || confirmed === resource
  if (exited && !answered) setExited(false)
  const gone = answered && (exited || prefersReducedMotion())
  useEffect(() => {
    if (!answered) return
    const fallback = setTimeout(() => { setExited(true) }, EXIT_FALLBACK_MS)
    return () => { clearTimeout(fallback) }
  }, [answered])
  const resolve = useEffectEvent(onResolved)
  useEffect(() => { if (confirmed === resource && gone) resolve() }, [confirmed, resource, gone])
  const reportLeaving = useEffectEvent((leaving: boolean) => { onLeaving?.(leaving) })
  useEffect(() => { reportLeaving(answered) }, [answered])
  // The server publishes the choices the approval accepts (TAL-1414, TAL-2481).
  const offers = (choice: 'once' | 'session' | 'always' | 'deny') => pending.allowed_choices.includes(choice)
  const respond = (choice: 'once' | 'session' | 'always' | 'deny', yolo = false) => { if (!answered && offers(choice)) answer({ choice, yolo }) }
  const tell = () => { const text = instruction.trim(); if (text && !answered) answer({ choice: 'deny', yolo: false, instruction: text }) }
  const closeTell = () => { refocusTell.current = true; setTellOpen(false) }
  const answerOnce = useEffectEvent(() => { respond('once') })
  const offersOnce = offers('once')
  useEffect(() => {
    // While the user types an instruction the command stays held: a stray Enter must not allow it.
    if (dismissed || answered || !offersOnce || telling) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || isImeEnter(e) || e.repeat) return
      if (e.composedPath().some((target) => target instanceof Element && target.closest(interactiveTarget))) return
      e.preventDefault()
      answerOnce()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [sessionId, pending.approval_id, dismissed, answered, offersOnce, telling])
  if (dismissed || gone) return null
  const command = pending.command ?? pending.action ?? ''
  // TAL-2333: the held call as its tool row shows it; a shell call keeps its command, any other call shows its argument rows.
  const tool = pending.tool
  const fields = tool?.args_fields?.length ? tool.args_fields : null
  const scope = scopeSentence(pending)
  return (
    <div className={cn(answered ? 'leaving' : 'visible', collapsed && 'collapsed', "approval-card mx-auto mb-2 w-full max-w-[var(--msg-max)] rounded-xl border border-warning bg-surface shadow-md")} role="alertdialog" aria-labelledby={headingId} aria-describedby={descriptionId} aria-hidden={answered || undefined} inert={answered} id="approvalCard">
      <div className="approval-inner p-3" onTransitionEnd={(e) => { if (answered && e.target === e.currentTarget && e.propertyName === 'transform') setExited(true) }}>
        <div className="approval-header flex items-center gap-2 text-sm font-semibold text-text">
          {tool ? <>
            <span className="tool-card-icon shrink-0"><ToolKindIcon kind={tool.kind} logoUrl={tool.app?.logo_url} /></span>
            <span id={headingId} className="min-w-0 truncate"><span className="sr-only">{`${pending.title ?? m.approval_heading()}:`}</span>{' '}{toolCardLabel({ ...tool, done: false, isError: false }, locale)}</span>
          </> : <>
            <AlertTriangle size={14} className="text-warning" aria-hidden="true" />
            <span id={headingId}>{pending.title ?? m.approval_heading()}</span>
          </>}
          {pending.pending_count && pending.pending_count > 1 && <span className="approval-counter text-xs text-muted">{m.approval_pending_count({ n: pending.pending_count })}</span>}
          {/* TAL-974: what Allow session and Always allow cover, behind help beside the heading. */}
          {scope && <HelpTip label={m.approval_scope_help()} className="approval-scope-help -ml-1 font-normal">{scope}</HelpTip>}
          <span className="flex-1" />
          <IconButton label={collapsed ? m.approval_expand() : m.approval_collapse()} className="h-7 w-7" aria-expanded={!collapsed} onClick={() => setCollapsed((c) => !c)}>{collapsed ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}</IconButton>
          <IconButton label={m.approval_dismiss()} className="h-7 w-7" onClick={() => { setDismissed(true); onDismissed?.() }}><X size={14} aria-hidden="true" /></IconButton>
        </div>
        <div className={cn(collapsed && 'hidden')}>
          {/* TAL-2333: what the approval holds scrolls in a short viewport (a folded phone's landscape), so its answers stay in view.
            ponytail: 290px is the chat header, tab bar, card chrome and two rows of answers; measure them if the layout moves. */}
          <div className="approval-body max-h-[max(4rem,calc(100dvh-290px))] overflow-y-auto">
            {pending.description && <div className="approval-desc mt-1 text-[13px] text-muted" id={descriptionId}>{pending.description}</div>}
            {fields ? <div className="approval-args mt-2 max-h-40 overflow-auto"><FieldRows fields={fields} /></div> : command && <pre className="approval-cmd mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code-bg p-2 font-mono text-[12.5px] text-pre-text">{command}</pre>}
            {pending.explanation && <ApprovalExplanation explanation={pending.explanation} />}
          </div>
          {telling ? <form className="approval-tell mt-3 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); tell() }}>
            <textarea
              autoFocus rows={2} aria-label={m.approval_tell_placeholder()} placeholder={m.approval_tell_placeholder()} value={instruction}
              onChange={(e) => { setInstruction(e.target.value) }}
              onKeyDown={(e) => {
                if (isImeEnter(e)) return
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); tell() }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeTell() }
              }}
              className="w-full resize-y rounded-md border border-border bg-input p-2 text-sm text-text"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" disabled={!instruction.trim()} className="approval-btn deny inline-flex items-center rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text hover:bg-hover">{m.approval_tell_send()}</button>
              <button type="button" onClick={closeTell} className="approval-btn more inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text hover:bg-hover">{m.back()} <Keys keys={['Esc']} /></button>
            </div>
          </form> : pending.allowed_choices.length === 0 ? <div className="approval-unavailable mt-3 text-[13px] text-muted">{m.approval_unavailable()}</div> : <div className="approval-btns mt-3 flex flex-wrap items-center gap-2">
            {offersOnce && <button type="button" onClick={() => { respond('once') }} className="approval-btn once inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg" title={m.approval_btn_once_title()}>{m.approval_btn_once()} <Keys keys={['↵']} /></button>}
            {offers('deny') && <button type="button" onClick={() => { respond('deny') }} className="approval-btn deny inline-flex items-center rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text hover:bg-hover">{m.approval_btn_deny()}</button>}
            {canTell && <button type="button" ref={(el) => { if (el && refocusTell.current) { refocusTell.current = false; el.focus() } }} onClick={() => { setTellOpen(true) }} className="approval-btn tell inline-flex items-center rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text hover:bg-hover">{m.approval_tell_instead()}</button>}
            {(pending.can_enable_yolo !== false || offers('session') || offers('always')) && <Menu label={m.approval_more()} side="top" trigger={<button type="button" className="approval-btn more inline-flex items-center rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text hover:bg-hover">{m.approval_more()}</button>}>
              {offers('session') && <MenuItem onClick={() => { respond('session') }}>{m.approval_btn_session()}</MenuItem>}
              {offers('always') && <MenuItem onClick={() => { respond('always') }}>{m.approval_btn_always()}</MenuItem>}
              {pending.can_enable_yolo !== false && <MenuItem onClick={() => { respond('once', true) }}>{m.approval_skip_all()}</MenuItem>}
            </Menu>}
          </div>}
        </div>
      </div>
    </div>
  )
}

/** The chat's approval, plus the answered one still leaving: the stream can clear or replace a card during its exit. */
export function ApprovalCards({ sessionId, pending, onResolved, onDismissed }: { sessionId: string; pending: ApprovalPending | null; onResolved: (approvalId: string | undefined) => void; onDismissed?: (approvalId: string | undefined) => void }) {
  const [leaving, setLeaving] = useState<ApprovalPending | null>(null)
  const cards = [...(leaving && leaving.approval_id !== pending?.approval_id ? [leaving] : []), ...(pending ? [pending] : [])]
  return cards.map((card) => {
    const forget = () => { setLeaving((held) => (held?.approval_id === card.approval_id ? null : held)) }
    return <ApprovalCard
      key={card.approval_id} sessionId={sessionId} pending={card}
      onLeaving={(on) => { if (on) setLeaving(card); else forget() }}
      onResolved={() => { forget(); onResolved(card.approval_id) }}
      onDismissed={() => { onDismissed?.(card.approval_id) }}
    />
  })
}
