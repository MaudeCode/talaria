import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const quotas = {
  version: 1, computed_at: '2030-01-01T00:00:00Z', scope_id: 'qscope_e2e', profile_id: 'default', active_provider: 'anthropic', requested_source_id: null, missing_source: false,
  sources: [{
    source_id: 'qsrc_paced', provider_id: 'anthropic', provider_label: 'Claude', account_label: 'Claude', plan: 'Max', is_active_provider: true, status: 'available',
    computed_at: '2030-01-01T00:00:00Z', fetched_at: '2030-01-01T00:00:00Z', urgency: { remaining: 'healthy', pace: 'warning' },
    windows: [
      { label: 'Session', used_percent: 25, remaining_percent: 75, reset_at: '2030-01-01T03:00:00Z', detail: null, window_seconds: 18000, urgency: { remaining: 'healthy', pace: 'healthy' },
        pace: { expected_remaining_percent: 60, pace_delta_percent: 15, burn_rate: 0.62, minutes_to_reset: 180, projected_minutes_to_empty: 540, elapsed_minutes: 120, valid_until: '2030-01-01T03:00:00Z', status: 'under' },
        forecast: { outcome: 'safe', budget_unit: 'hour', budget_percent: 25, depletion_margin_minutes: 360 } },
      { label: 'Weekly', used_percent: 70, remaining_percent: 30, reset_at: '2030-01-03T12:00:00Z', detail: null, window_seconds: 604800, urgency: { remaining: 'warning', pace: 'warning' },
        pace: { expected_remaining_percent: 36, pace_delta_percent: -6, burn_rate: 1.1, minutes_to_reset: 3600, projected_minutes_to_empty: 3270, elapsed_minutes: 6480, valid_until: '2030-01-03T12:00:00Z', status: 'over' },
        forecast: { outcome: 'warning', budget_unit: 'day', budget_percent: 12, depletion_margin_minutes: -330 } },
    ],
  }, {
    source_id: 'qsrc_codex', provider_id: 'openai-codex', provider_label: 'OpenAI Codex', status: 'available', fetched_at: '2030-01-01T00:00:00Z',
    windows: [{ label: 'Session', used_percent: 40, remaining_percent: 60, reset_at: '2030-01-01T02:00:00Z', detail: null, window_seconds: 18000, pace: null, forecast: null }],
  }],
}

const days = 30
const daily = Array.from({ length: days }, (_, i) => {
  const date = new Date(Date.UTC(2030, 0, 1 + i))
  const input = 12_000 + (i * 7_919) % 90_000
  const output = 2_000 + (i * 3_571) % 20_000
  return { date: date.toISOString().slice(0, 10), input_tokens: input, output_tokens: output, cache_read_tokens: input / 2, sessions: 1 + (i * 5) % 7, cost: ((input + output) / 1_000_000) * 3 }
})
const sum = (key: 'input_tokens' | 'output_tokens' | 'sessions' | 'cost') => daily.reduce((n, d) => n + d[key], 0)
const insights = {
  period_days: days, total_sessions: sum('sessions'), total_messages: sum('sessions') * 9,
  total_input_tokens: sum('input_tokens'), total_output_tokens: sum('output_tokens'), total_tokens: sum('input_tokens') + sum('output_tokens'),
  total_cache_read_tokens: sum('input_tokens') / 2, total_cache_hit_percent: 50, total_cost: sum('cost'),
  models: [
    { model: 'claude-fable-5-1', sessions: sum('sessions') - 3, input_tokens: 1_200_000, output_tokens: 300_000, total_tokens: 1_500_000, cache_read_tokens: 600_000, cache_hit_percent: 52.5, cost: 12.5, session_share: 80, token_share: 84, cost_share: 80, display_share: 80 },
    { model: 'claude-haiku-5-5', sessions: 3, input_tokens: 40_000, output_tokens: 9_000, total_tokens: 49_000, cache_read_tokens: 0, cache_hit_percent: 0, cost: 0.3, session_share: 20, token_share: 16, cost_share: 20, display_share: 20 },
  ],
  daily_tokens: daily,
  activity_by_day: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, i) => ({ day, sessions: [4, 9, 6, 7, 5, 2, 1][i] })),
  activity_by_hour: Array.from({ length: 24 }, (_, hour) => ({ hour, sessions: hour >= 9 && hour <= 18 ? 3 + (hour * 7) % 5 : 0 })),
}

test('Insights shows every quota window with pace and forecast, the stat row, the charts and the model table', async ({ page }, info) => {
  await page.route('**/api/provider/quotas**', (route) => route.fulfill({ json: quotas }))
  await page.route('**/api/insights**', (route) => route.fulfill({ json: insights }))
  await page.goto('/insights')
  await settle(page)

  const paced = page.locator('[data-quota-source="qsrc_paced"]')
  await expect(paced.getByRole('meter')).toHaveCount(2)
  const session = paced.locator('[data-quota-window="Session"]')
  await expect(session).toHaveAttribute('data-level', 'healthy')
  await expect(session).toContainText('75% remaining')
  await expect(session).toContainText('15% under pace')
  await expect(session).toContainText('Burn 0.62×')
  await expect(session).toContainText('Lasts through reset')
  const weekly = paced.locator('[data-quota-window="Weekly"]')
  await expect(weekly).toHaveAttribute('data-level', 'warning')
  await expect(weekly).toContainText('Empty 5h early')
  await expect(weekly).toContainText('12% / day budget')
  const codex = page.locator('[data-quota-source="qsrc_codex"]')
  await expect(codex).toContainText('60% remaining')
  await expect(codex).not.toContainText('pace')

  const stats = page.getByTestId('insights-stats')
  await expect(stats).toContainText('Prompt-cache hit rate')
  await expect(stats).toContainText('50%')
  await expect(page.locator('[data-chart="daily"]')).toBeVisible()
  await expect(page.locator('[data-chart="weekday"]').getByRole('img')).toHaveAccessibleName('Activity by day: peak 9 at Tue')
  await expect(page.locator('[data-chart="hour"]')).toBeVisible()

  const models = page.getByTestId('insights-models')
  await expect(models.locator('tbody tr').first()).toContainText('claude-fable-5-1')
  await expect(models.locator('tbody tr').first()).toContainText('1.5M')
  await expect(models.locator('tbody tr').first()).toContainText('52.5%')
  await expect(models.locator('tbody tr').first()).toContainText('80%')

  // The daily chart follows the metric select.
  await page.getByRole('combobox', { name: 'Metric' }).click()
  await page.getByRole('option', { name: 'Sessions' }).click()
  await expect(page.locator('[data-chart="daily"]')).toContainText('Max 7')

  // Evidence: the top of the page as it opens, then the charts and table further down the hub's own scroll area.
  const shot = async (name: string) => {
    const path = info.outputPath(`insights-${name}-${info.project.name}.png`)
    await page.screenshot({ path })
    await info.attach(`insights-${name}-${info.project.name}`, { path, contentType: 'image/png' })
  }
  await page.locator('.main-view-body').evaluate((el) => { el.scrollTop = 0 })
  await shot('top')
  await page.locator('.main-view-body').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await shot('bottom')
})
