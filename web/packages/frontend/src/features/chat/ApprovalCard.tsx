import { useEffect, useEffectEvent, useId, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, X } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import type { ApprovalPending } from '../../contracts'
import * as api from '../../api/endpoints'
import { Menu, MenuItem } from '../../ui/Menu'
import { IconButton } from '../../ui/Button'
import { keys } from '../../api/queryKeys'
import { usePromptAnswer } from './usePromptAnswer'
import { cn } from '../../ui/cn'

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

/**
 * Destructive-command approval. Rendered inline above the composer (legacy
 * placement) with alertdialog semantics; Enter answers "allow once" when focus
 * is outside interactive controls. Cleared by the terminal event or a successful respond.
 */
export function ApprovalCard({ sessionId, pending, onResolved, transport }: { sessionId: string; pending: ApprovalPending; onResolved: () => void; transport?: { send: (choice: 'once' | 'session' | 'always' | 'deny') => Promise<unknown>; waiting: () => Promise<boolean> } }) {
  const headingId = useId(), descriptionId = useId()
  const [collapsed, setCollapsed] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  // The card leaves as soon as the user answers; a refused answer brings it back with the error.
  const resource = `approval:${sessionId}:${pending.approval_id ?? ''}`
  const { answer, answered: isAnswered } = usePromptAnswer({
    resource: () => resource, queryKey: keys.approval(sessionId),
    send: ({ choice, yolo }: { choice: 'once' | 'session' | 'always' | 'deny'; yolo: boolean }) => transport ? transport.send(choice) : api.respondApproval({ session_id: sessionId, choice, ...(pending.approval_id ? { approval_id: pending.approval_id } : {}), ...(pending.run_id ? { run_id: pending.run_id } : {}), ...(pending.mirror_token ? { mirror_token: pending.mirror_token } : {}), ...(yolo ? { yolo: true } : {}) }),
    waiting: transport?.waiting ?? (async () => { const { pending: head } = await api.fetchApprovalPending(sessionId); return !!head && (head.approval_id ?? '') === (pending.approval_id ?? '') }),
    onAnswered: onResolved,
  })
  const answered = isAnswered(resource)
  const respond = (choice: 'once' | 'session' | 'always' | 'deny', yolo = false) => { if (!answered) answer({ choice, yolo }) }
  const answerOnce = useEffectEvent(() => { respond('once') })
  useEffect(() => {
    if (dismissed || answered) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.isComposing || e.repeat) return
      if (e.composedPath().some((target) => target instanceof Element && target.closest(interactiveTarget))) return
      e.preventDefault()
      answerOnce()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [sessionId, pending.approval_id, dismissed, answered])
  if (dismissed || answered) return null
  const command = pending.command ?? pending.action ?? ''
  return (
    <div className={cn('visible', collapsed && 'collapsed', "approval-card mx-auto mb-2 w-full max-w-[var(--msg-max)] rounded-xl border border-warning bg-surface shadow-md")} role="alertdialog" aria-labelledby={headingId} aria-describedby={descriptionId} id="approvalCard">
      <div className="approval-inner p-3">
        <div className="approval-header flex items-center gap-2 text-sm font-semibold text-text">
          <AlertTriangle size={14} className="text-warning" aria-hidden="true" />
          <span id={headingId}>{pending.title ?? m.approval_heading()}</span>
          {pending.pending_count && pending.pending_count > 1 && <span className="approval-counter text-xs text-muted">{m.approval_pending_count({ n: pending.pending_count })}</span>}
          <span className="flex-1" />
          <IconButton label={collapsed ? m.approval_expand() : m.approval_collapse()} className="h-7 w-7" aria-expanded={!collapsed} onClick={() => setCollapsed((c) => !c)}>{collapsed ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}</IconButton>
          <IconButton label={m.approval_dismiss()} className="h-7 w-7" onClick={() => setDismissed(true)}><X size={14} aria-hidden="true" /></IconButton>
        </div>
        <div className={cn(collapsed && 'hidden')}>
          {(pending.description ?? pending.question ?? pending.reason) && <div className="approval-desc mt-1 text-[13px] text-muted" id={descriptionId}>{pending.description ?? pending.question ?? pending.reason}</div>}
          {command && <pre className="approval-cmd mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code-bg p-2 font-mono text-[12.5px] text-pre-text">{command}</pre>}
          <div className="approval-btns mt-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => { respond('once') }} className="approval-btn once inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg" title={m.approval_btn_once_title()}>{m.approval_btn_once()} <kbd className="rounded border border-current/30 px-1 text-[10px]">↵</kbd></button>
            <button type="button" onClick={() => { respond('deny') }} className="approval-btn deny inline-flex items-center rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text hover:bg-hover">{m.approval_btn_deny()}</button>
            {(pending.can_enable_yolo !== false || (pending.allowed_choices?.includes('session') ?? true) || (pending.allowed_choices?.includes('always') ?? true)) && <Menu label={m.approval_more()} side="top" trigger={<button type="button" className="approval-btn more inline-flex items-center rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text hover:bg-hover">{m.approval_more()}</button>}>
              {(pending.allowed_choices?.includes('session') ?? true) && <MenuItem onClick={() => { respond('session') }}>{m.approval_btn_session()}</MenuItem>}
              {(pending.allowed_choices?.includes('always') ?? true) && <MenuItem onClick={() => { respond('always') }}>{m.approval_btn_always()}</MenuItem>}
              {pending.can_enable_yolo !== false && <MenuItem onClick={() => { respond('once', true) }}>{m.approval_skip_all()}</MenuItem>}
            </Menu>}
          </div>
        </div>
      </div>
    </div>
  )
}
