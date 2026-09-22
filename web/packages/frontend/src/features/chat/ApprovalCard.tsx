import { useEffect, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, X } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import type { ApprovalPending } from '../../contracts'
import * as api from '../../api/endpoints'
import { Menu, MenuItem } from '../../ui/Menu'
import { IconButton } from '../../ui/Button'
import { showToast } from '../toast/toast'
import { cn } from '../../ui/cn'

/**
 * Destructive-command approval. Rendered inline above the composer (legacy
 * placement) with alertdialog semantics; Enter answers "allow once" when focus
 * is outside a text field. Cleared by the terminal event or a successful respond.
 */
export function ApprovalCard({ sessionId, pending, onResolved }: { sessionId: string; pending: ApprovalPending; onResolved: () => void }) {
  const [busy, setBusy] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const respond = async (choice: 'once' | 'session' | 'always' | 'deny', yolo = false) => {
    if (busy) return
    setBusy(true)
    try {
      const res = await api.respondApproval({ session_id: sessionId, choice, ...(pending.approval_id ? { approval_id: pending.approval_id } : {}), ...(pending.run_id ? { run_id: pending.run_id } : {}), ...(pending.mirror_token ? { mirror_token: pending.mirror_token } : {}), ...(yolo ? { yolo: true } : {}) })
      if (res.error) showToast(res.error, 4000, 'error')
      else onResolved()
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 4000, 'error')
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.shiftKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || t.tagName === 'A')) return
      e.preventDefault()
      void respond('once')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, pending.approval_id])
  if (dismissed) return null
  const command = pending.command ?? pending.action ?? ''
  return (
    <div className={cn('visible', collapsed && 'collapsed', "approval-card mx-auto mb-2 w-full max-w-[var(--msg-max)] rounded-xl border border-warning bg-surface shadow-md")} role="alertdialog" aria-labelledby="approvalHeading" aria-describedby="approvalDesc" id="approvalCard">
      <div className="approval-inner p-3">
        <div className="approval-header flex items-center gap-2 text-sm font-semibold text-text">
          <AlertTriangle size={14} className="text-warning" aria-hidden="true" />
          <span id="approvalHeading">{pending.title ?? m.approval_heading()}</span>
          {pending.pending_count && pending.pending_count > 1 && <span className="approval-counter text-xs text-muted">{m.approval_pending_count({ n: pending.pending_count })}</span>}
          <span className="flex-1" />
          <IconButton label={collapsed ? m.approval_expand() : m.approval_collapse()} className="h-7 w-7" aria-expanded={!collapsed} onClick={() => setCollapsed((c) => !c)}>{collapsed ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}</IconButton>
          <IconButton label={m.approval_dismiss()} className="h-7 w-7" onClick={() => setDismissed(true)}><X size={14} aria-hidden="true" /></IconButton>
        </div>
        <div className={cn(collapsed && 'hidden')}>
          {(pending.description ?? pending.question ?? pending.reason) && <div className="approval-desc mt-1 text-[13px] text-muted" id="approvalDesc">{pending.description ?? pending.question ?? pending.reason}</div>}
          {command && <pre className="approval-cmd mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code-bg p-2 font-mono text-[12.5px] text-pre-text">{command}</pre>}
          <div className="approval-btns mt-3 flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} onClick={() => { void respond('once') }} className="approval-btn once inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg" title={m.approval_btn_once_title()}>{m.approval_btn_once()} <kbd className="rounded border border-current/30 px-1 text-[10px]">↵</kbd></button>
            <button type="button" disabled={busy} onClick={() => { void respond('deny') }} className="approval-btn deny inline-flex items-center rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text hover:bg-hover">{m.approval_btn_deny()}</button>
            <Menu label={m.approval_more()} side="top" trigger={<button type="button" disabled={busy} className="approval-btn more inline-flex items-center rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text hover:bg-hover">{m.approval_more()}</button>}>
              <MenuItem onClick={() => { void respond('session') }}>{m.approval_btn_session()}</MenuItem>
              <MenuItem onClick={() => { void respond('always') }}>{m.approval_btn_always()}</MenuItem>
              <MenuItem onClick={() => { void respond('once', true) }}>{m.approval_skip_all()}</MenuItem>
            </Menu>
          </div>
        </div>
      </div>
    </div>
  )
}
