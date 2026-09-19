import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, HelpCircle } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import type { ClarifyPending } from '../../contracts'
import * as api from '../../api/endpoints'
import { IconButton } from '../../ui/Button'
import { TextInput } from '../../ui/Field'
import { showToast } from '../toast/toast'
import { cn } from '../../ui/cn'

function choiceText(c: unknown): string {
  if (typeof c === 'string') return c
  if (c && typeof c === 'object') {
    const o = c as { label?: unknown; value?: unknown; text?: unknown }
    for (const v of [o.label, o.text, o.value]) if (typeof v === 'string') return v
  }
  return ''
}

/** Structured clarification: choices as buttons plus a free-text answer, with the server countdown when present. */
export function ClarifyCard({ sessionId, pending, onResolved }: { sessionId: string; pending: ClarifyPending; onResolved: () => void }) {
  const [busy, setBusy] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [answer, setAnswer] = useState('')
  const [remaining, setRemaining] = useState<number | null>(pending.timeout_seconds ?? null)
  const hasTimeout = remaining !== null
  useEffect(() => {
    if (!hasTimeout) return
    const t = window.setInterval(() => setRemaining((r) => (r === null ? null : Math.max(0, r - 1))), 1000)
    return () => window.clearInterval(t)
  }, [hasTimeout])
  const respond = async (response: string) => {
    if (busy || !response.trim()) return
    setBusy(true)
    try {
      const res = await api.respondClarify({ session_id: sessionId, response: response.trim(), ...(pending.clarify_id ? { clarify_id: pending.clarify_id } : {}) })
      if (res.error) showToast(res.error, 4000, 'error')
      else { setAnswer(''); onResolved() }
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 4000, 'error')
    } finally {
      setBusy(false)
    }
  }
  const choices = (pending.choices ?? []).map(choiceText).filter(Boolean)
  return (
    <div className={cn('visible', collapsed && 'collapsed', "clarify-card mx-auto mb-2 w-full max-w-[var(--msg-max)] rounded-xl border border-info bg-surface shadow-md")} role="dialog" aria-labelledby="clarifyHeading" aria-describedby="clarifyQuestion" id="clarifyCard">
      <div className="clarify-inner p-3">
        <div className="clarify-header flex items-center gap-2 text-sm font-semibold text-text">
          <HelpCircle size={14} className="text-info" aria-hidden="true" />
          <span id="clarifyHeading">{pending.title ?? m.clarify_heading()}</span>
          {remaining !== null && <span className="clarify-countdown text-xs tabular-nums text-muted" aria-live="polite">{remaining}s</span>}
          {pending.total && pending.total > 1 && <span className="text-xs text-muted">{(pending.index ?? 0) + 1}/{pending.total}</span>}
          <span className="flex-1" />
          <IconButton label={collapsed ? m.approval_expand() : m.approval_collapse()} className="h-7 w-7" aria-expanded={!collapsed} onClick={() => setCollapsed((c) => !c)}>{collapsed ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}</IconButton>
        </div>
        <div className={cn(collapsed && 'hidden')}>
          <div className="clarify-question mt-1 whitespace-pre-wrap text-[13px] text-text" id="clarifyQuestion">{pending.question ?? pending.description ?? ''}</div>
          {choices.length > 0 && (
            <div className="clarify-choices mt-2 flex flex-wrap gap-2">
              {choices.map((c, i) => <button key={`${c}-${i}`} type="button" disabled={busy} onClick={() => { void respond(c) }} className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text hover:border-accent hover:text-accent-text">{c}</button>)}
            </div>
          )}
          <form onSubmit={(e) => { e.preventDefault(); void respond(answer) }} className="mt-2 flex gap-2">
            <TextInput value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={choices.length ? m.clarify_composer_placeholder_choices() : m.clarify_composer_placeholder()} aria-label={m.clarify_heading()} />
            <button type="submit" disabled={busy || !answer.trim()} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-50">{m.clarify_submit()}</button>
          </form>
          <div className="clarify-hint mt-1 text-[11px] text-muted">{m.clarify_hint()}</div>
        </div>
      </div>
    </div>
  )
}
