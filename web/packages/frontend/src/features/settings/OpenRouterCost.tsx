import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useSaveSettings } from '../../app/queries'
import { Button } from '../../ui/Button'
import { TextInput } from '../../ui/Field'
import { showToast } from '../toast/toast'
import { cn } from '../../ui/cn'

const LEVEL_FILL = { ok: 'bg-accent', warn: 'bg-warning', over: 'bg-error' } as const
const LEVEL_TEXT = { ok: 'text-muted', warn: 'text-warning', over: 'text-error' } as const

/** OpenRouter daily spend, monthly pace, and budget standing; every value is a `/api/provider/cost-history` field (TAL-412). */
export function OpenRouterCost() {
  const qc = useQueryClient()
  const history = useQuery({ queryKey: keys.providerCostHistory, queryFn: api.fetchOpenRouterCostHistory, staleTime: 60_000 })
  const save = useSaveSettings()
  const [draft, setDraft] = useState<string | null>(null)
  const h = history.data
  if (!h || h.supported === false) return null
  const budget = h.monthly_budget ?? null
  const level = h.budget_level ?? null
  const snapshots = h.snapshots ?? []
  const saveBudget = (value: number | null) => {
    save.mutate({ provider_cost_budget: value }, {
      onSuccess: () => { setDraft(null); void qc.invalidateQueries({ queryKey: keys.providerCostHistory }) },
      onError: () => showToast(m.provider_cost_budget_save_failed(), 4000, 'error'),
    })
  }
  const value = draft ?? (budget === null ? '' : budget.toFixed(2))
  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-border pt-2" data-provider-cost="openrouter">
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="font-medium text-text">{m.provider_cost_chart_title({ n: h.window_days ?? snapshots.length })}</span>
        {h.monthly_pace !== null && h.monthly_pace !== undefined && (
          <span className="text-muted" data-testid="provider-cost-pace">
            {m.provider_cost_monthly_pace({ amount: `$${h.monthly_pace.toFixed(2)}` })}
            {level && h.budget_percent !== null && h.budget_percent !== undefined && <span className={cn('ml-1', LEVEL_TEXT[level])}>({h.budget_percent}%)</span>}
          </span>
        )}
      </div>
      {h.status !== 'available' && <div className="text-[11px] text-muted">{h.message}</div>}
      {h.has_enough_data ? (
        <div className="flex h-16 items-end gap-1" role="list" aria-label={m.provider_cost_chart_title({ n: h.window_days ?? snapshots.length })}>
          {snapshots.map((s) => {
            const tip = s.delta === null ? `${s.date} · ${m.provider_cost_no_baseline()}` : `${s.date} · $${s.delta.toFixed(4)}`
            return (
              <div key={s.date} role="listitem" className="flex h-full min-w-0 flex-1 flex-col items-center gap-0.5" title={tip} aria-label={tip}>
                <div className="flex w-full flex-1 items-end"><div className="w-full rounded-sm bg-accent opacity-85" style={{ height: `${String(s.bar_percent)}%` }} /></div>
                <span className="text-[10px] text-muted">{s.date.slice(5)}</span>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="text-[11px] text-muted">{m.provider_cost_not_enough_data()}</div>
      )}
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); const n = Number.parseFloat(value); if (Number.isFinite(n) && n > 0) saveBudget(n) }}>
        <label htmlFor="provider-cost-budget" className="text-xs text-muted">{m.provider_cost_budget_label()}</label>
        <span className="text-xs text-muted" aria-hidden="true">$</span>
        <div className="w-28"><TextInput id="provider-cost-budget" type="number" min="0.01" step="0.01" inputMode="decimal" value={value} placeholder={m.provider_cost_budget_placeholder()} onChange={(e) => setDraft(e.target.value)} /></div>
        <Button type="submit" disabled={save.isPending}>{m.provider_cost_budget_set()}</Button>
        {budget !== null && <Button variant="ghost" disabled={save.isPending} onClick={() => saveBudget(null)}>{m.provider_cost_budget_clear()}</Button>}
      </form>
      {budget !== null && level && h.budget_percent !== null && h.budget_percent !== undefined && (
        <div className="flex items-center gap-2" data-budget-level={level}>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border"><div className={cn('h-full max-w-full rounded-full', LEVEL_FILL[level])} style={{ width: `${String(h.budget_percent)}%` }} /></div>
          <span className={cn('text-[11px]', LEVEL_TEXT[level])}>{m.provider_cost_budget_pct({ a0: h.budget_percent, a1: budget.toFixed(2) })}</span>
        </div>
      )}
    </div>
  )
}
