import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const quotas = {
  version: 1, computed_at: '2030-01-01T00:00:00Z', scope_id: 'qscope_e2e', profile_id: 'default', active_provider: 'anthropic', requested_source_id: null, missing_source: false,
  sources: [{
    source_id: 'qsrc_paced', provider_id: 'anthropic', provider_label: 'Claude', account_label: 'Claude', plan: 'Max', is_active_provider: true, status: 'available',
    computed_at: '2030-01-01T00:00:00Z', fetched_at: '2030-01-01T00:00:00Z', urgency: { remaining: 'healthy', pace: 'warning' },
    windows: [
      { label: 'Session', used_percent: 25, remaining_percent: 75, reset_at: '2030-01-01T03:00:00Z', detail: null, window_seconds: 18000, urgency: { remaining: 'healthy', pace: 'healthy' }, display_level: 'healthy',
        pace: { expected_remaining_percent: 60, expected_used_percent: 40, pace_delta_percent: 15, burn_rate: 0.62, minutes_to_reset: 180, projected_minutes_to_empty: 540, elapsed_minutes: 120, valid_until: '2030-01-01T03:00:00Z', status: 'under' },
        forecast: { outcome: 'safe', budget_unit: 'hour', budget_percent: 25, depletion_margin_minutes: 360 } },
      { label: 'Weekly', used_percent: 70, remaining_percent: 30, reset_at: '2030-01-03T12:00:00Z', detail: null, window_seconds: 604800, urgency: { remaining: 'warning', pace: 'warning' }, display_level: 'warning',
        pace: { expected_remaining_percent: 36, expected_used_percent: 64, pace_delta_percent: -6, burn_rate: 1.1, minutes_to_reset: 3600, projected_minutes_to_empty: 3270, elapsed_minutes: 6480, valid_until: '2030-01-03T12:00:00Z', status: 'over' },
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
const byDay = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, i) => ({ day, sessions: [4, 9, 6, 7, 5, 2, 1][i]! }))
const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, sessions: hour >= 9 && hour <= 18 ? 3 + (hour * 7) % 5 : 0 }))
/** The server's `chart_peaks` entry for a series (TAL-2479). */
const peakOf = (values: number[]) => ({ peak_index: values.indexOf(Math.max(...values)), max: Math.max(0, ...values) })
/** The server's resolved range (TAL-1117): the 30-day preset unless a request names custom dates. */
const range = {
  mode: 'preset', start: Date.UTC(2030, 0, 1) / 1000, end: Date.UTC(2030, 0, 30, 12) / 1000, through_now: true, start_date: '2030-01-01', end_date: '2030-01-30', today: '2030-01-30',
  timezone: 'Europe/Berlin', bucket: 'day', fallback_reason: null, adjustments: [],
}
const insights = {
  period_days: days, range, total_sessions: sum('sessions'), total_messages: sum('sessions') * 9,
  total_input_tokens: sum('input_tokens'), total_output_tokens: sum('output_tokens'), total_tokens: sum('input_tokens') + sum('output_tokens'),
  total_cache_read_tokens: sum('input_tokens') / 2, total_cache_hit_percent: 50, total_cost: sum('cost'),
  models: [
    { model: 'claude-fable-5-1', sessions: sum('sessions') - 3, input_tokens: 1_200_000, output_tokens: 300_000, total_tokens: 1_500_000, cache_read_tokens: 600_000, cache_hit_percent: 52.5, cost: 12.5, session_share: 80, token_share: 84, cost_share: 80, display_share: 80 },
    { model: 'claude-haiku-5-5', sessions: 3, input_tokens: 40_000, output_tokens: 9_000, total_tokens: 49_000, cache_read_tokens: 0, cache_hit_percent: 0, cost: 0.3, session_share: 20, token_share: 16, cost_share: 20, display_share: 20 },
  ],
  daily_tokens: daily,
  activity_by_day: byDay,
  activity_by_hour: byHour,
  chart_peaks: {
    daily: { tokens: peakOf(daily.map((d) => d.input_tokens + d.output_tokens)), cost: peakOf(daily.map((d) => d.cost)), sessions: peakOf(daily.map((d) => d.sessions)) },
    by_day: peakOf(byDay.map((d) => d.sessions)), by_hour: peakOf(byHour.map((d) => d.sessions)),
  },
}

test('Insights opens on Quotas, whose Used / Remaining choice survives a reload; Usage holds the stats, charts and model table', async ({ page }, info) => {
  await page.route('**/api/provider/quotas**', (route) => route.fulfill({ json: quotas }))
  await page.route('**/api/insights**', (route) => route.fulfill({ json: insights }))
  await page.goto('/insights')
  await settle(page)
  await expect(page.getByRole('tab', { name: 'Quotas' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('insights-stats')).toHaveCount(0)

  const paced = page.locator('[data-quota-source="qsrc_paced"]')
  await expect(paced.getByText('Max', { exact: true })).toHaveCSS('font-size', '11px') // Badge sits at the type floor (DESIGN.md)
  // Each window's figures are ProviderQuotaRows' own (InsightsPage.test.tsx); this route checks the mode toggle end to end.
  const session = paced.locator('[data-quota-window="Session"]')
  const codex = page.locator('[data-quota-source="qsrc_codex"]')

  // The Used / Remaining choice flips every headline and survives a reload (a per-browser convenience).
  await page.getByRole('combobox', { name: 'Percentage' }).click()
  await page.getByRole('option', { name: 'Remaining', exact: true }).click()
  await expect(session.getByRole('meter', { name: 'Session: 75% Remaining' })).toBeVisible()
  await expect(codex.getByRole('meter', { name: 'Session: 60% Remaining' })).toBeVisible()
  await page.reload()
  await settle(page)
  await expect(page.locator('[data-quota-source="qsrc_paced"]').getByRole('meter', { name: 'Session: 75% Remaining' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Percentage' }).click()
  await page.getByRole('option', { name: 'Used', exact: true }).click()
  await expect(session.getByRole('meter', { name: 'Session: 25% Used' })).toBeVisible()

  // Evidence: the Quotas tab, then the Usage tab's charts and table further down the hub's own scroll area.
  const shot = async (name: string) => {
    const path = info.outputPath(`insights-${name}-${info.project.name}.png`)
    await page.screenshot({ path })
    await info.attach(`insights-${name}-${info.project.name}`, { path, contentType: 'image/png' })
  }
  await shot('quotas')

  await page.getByRole('tab', { name: 'Usage' }).click()
  await expect(page).toHaveURL(/tab=usage/)
  await expect(page.locator('[data-quota-source]')).toHaveCount(0)
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

  // The period select carries its own aria-label (design system, toolbar selects), and switching it reaches the URL.
  const period = page.getByRole('combobox', { name: 'Period', exact: true })
  await expect(period).toHaveAttribute('aria-label', 'Period')
  await period.click()
  await page.getByRole('option', { name: '7 days' }).click()
  await expect(page).toHaveURL(/days=7/)
  await expect(period).toHaveText('7 days')

  // The daily chart follows the metric select.
  await page.getByRole('combobox', { name: 'Metric' }).click()
  await page.getByRole('option', { name: 'Sessions' }).click()
  await expect(page.locator('[data-chart="daily"]')).toContainText('Max 7')

  await page.locator('.main-view-body').evaluate((el) => { el.scrollTop = 0 })
  await shot('usage-top')
  await page.locator('.main-view-body').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await shot('usage-bottom')

  // The tab survives a reload through the URL.
  await page.reload()
  await settle(page)
  await expect(page.getByRole('tab', { name: 'Usage' })).toHaveAttribute('aria-selected', 'true')
})

test('a custom Usage range takes typed dates, survives a preset and says when the server fell back (TAL-1117)', async ({ page }, info) => {
  const asked: URLSearchParams[] = []
  await page.route('**/api/provider/quotas**', (route) => route.fulfill({ json: quotas }))
  await page.route('**/api/insights**', (route) => {
    const query = new URL(route.request().url()).searchParams
    asked.push(query)
    const start = query.get('start')
    const end = query.get('end')
    if (start === null && end === null) return route.fulfill({ json: insights })
    if (!start || !end) return route.fulfill({ json: { ...insights, range: { ...range, fallback_reason: start ? 'invalid_end' : 'invalid_start' } } })
    return route.fulfill({ json: { ...insights, range: { ...range, mode: 'custom', through_now: false, start_date: start, end_date: end } } })
  })
  await page.goto('/insights?tab=usage')
  await settle(page)
  const period = page.getByRole('combobox', { name: 'Period', exact: true })
  await period.click()
  await page.getByRole('option', { name: 'Custom' }).click()
  await expect(page).toHaveURL(/start=2030-01-01&end=2030-01-30|end=2030-01-30.*start=2030-01-01/)
  const start = page.getByLabel('Start date')
  await expect(start).toHaveValue('2030-01-01')
  await expect(start).toHaveAttribute('max', '2030-01-30')

  // Keyboard entry into the date field's own segments reaches the server as the typed day.
  await start.focus()
  await page.keyboard.type('01052030')
  await expect(start).toHaveValue('2030-01-05')
  await expect(page.getByRole('status').filter({ hasText: 'Europe/Berlin' })).toHaveText('Jan 5, 2030 – Jan 30, 2030 · Europe/Berlin')
  expect(asked.some((query) => query.get('start') === '2030-01-05')).toBe(true)
  const shot = async (name: string) => {
    const path = info.outputPath(`insights-${name}-${info.project.name}.png`)
    await page.screenshot({ path })
    await info.attach(`insights-${name}-${info.project.name}`, { path, contentType: 'image/png' })
  }
  await shot('custom-range')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await period.click()
  await page.getByRole('option', { name: '7 days' }).click()
  await expect(start).toHaveCount(0)
  await period.click()
  await page.getByRole('option', { name: 'Custom' }).click()
  await expect(start).toHaveValue('2030-01-05')

  await page.getByLabel('End date').fill('')
  await expect(page.getByRole('status').filter({ hasText: 'Unreadable end date' })).toHaveText('Unreadable end date; showing 30 days')
  await shot('custom-fallback')
})
