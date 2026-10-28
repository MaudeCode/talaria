import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { PlanUsage } from '@maudecode/talaria-web-contracts'
import { ProviderQuotaPace } from './ProviderQuotaPace'

const plan: PlanUsage = { kind: 'usage_window', plan: 'Pro', gauges: [{ label: 'week', title: 'Weekly', scope: 'all', left_fraction: 0, resets_at_ms: null, style: 'red' }], top_tier_model_ids: [], featured_model_ids: [], paused_reason: null, credits_pay: null }

describe('native quota presentation', () => {
  it.each([true, false, null])('states credits coverage only for native credits_pay=%s', (credits_pay) => {
    render(<ProviderQuotaPace plan={{ ...plan, credits_pay }} />)
    expect(screen.getByText('0% remaining')).toBeVisible()
    expect(screen.queryByText('Credits cover usage after allowance') !== null).toBe(credits_pay === true)
  })
  it('marks a stale snapshot and makes no credit-coverage promise', () => {
    render(<ProviderQuotaPace plan={{ ...plan, credits_pay: true }} planStale />)
    expect(screen.getByText('Last-confirmed data')).toBeVisible()
    expect(screen.queryByText('Credits cover usage after allowance')).toBeNull()
  })
  it('formats the native run gauge without hiding an unknown reset', () => {
    render(<ProviderQuotaPace gauge={{ id: 'day', label: 'Today', used_bp: 8300, resets_at_ms: null }} />)
    expect(screen.getByText('Today: 83% used')).toBeVisible()
  })
  it.each(['stale', 'unavailable'])('renders cached %s plan data without current credits coverage wording', (status) => {
    render(<ProviderQuotaPace source={{ source_id: 'cached-plan', status, plan_usage: { ...plan, credits_pay: true }, plan_stale: false }} />)
    expect(screen.getByText('Last-confirmed data')).toBeVisible()
    expect(screen.queryByText('Credits cover usage after allowance')).toBeNull()
  })

})
