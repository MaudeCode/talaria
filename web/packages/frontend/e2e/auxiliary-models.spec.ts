import { expect, settle, test } from './fixtures'

// Service-worker requests bypass page routing; these fixtures own every response.
test.use({ serviceWorkers: 'block' })

const SLOTS: [string, string, string][] = [
  ['vision', 'Vision', 'image/screenshot analysis'], ['web_extract', 'Web extract', 'web page summarization'],
  ['compression', 'Compression', 'context summarization'], ['approval', 'Approval', 'smart command approval'],
  ['mcp', 'MCP', 'MCP tool reasoning'], ['title_generation', 'Title generation', 'session titles'],
  ['skills_hub', 'Skills hub', 'skills search/install'], ['curator', 'Curator', 'skill-usage review pass'],
  ['kanban_decomposer', 'Kanban decomposer', 'task decomposition'], ['profile_describer', 'Profile describer', 'profile summaries'],
  ['triage_specifier', 'Triage specifier', 'issue/task triage specs'],
]
const auxiliary = {
  main: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  tasks: SLOTS.map(([task, label, description]) => ({
    task, label, description, provider: 'auto', model: '', is_auto: true, value_label: 'Claude Sonnet 4.6', provider_label: 'Anthropic', selected_option_id: null, in_catalog: true,
    ...(task === 'title_generation' ? { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5', is_auto: false, value_label: 'Claude Haiku 4.5', provider_label: 'OpenRouter', selected_option_id: '@openrouter:anthropic/claude-haiku-4.5' } : {}),
    ...(task === 'vision' ? { provider: 'openrouter', model: 'legacy/vision-model', is_auto: false, value_label: 'legacy/vision-model', provider_label: 'OpenRouter', in_catalog: false } : {}),
  })),
}
const models = {
  active_provider: 'anthropic', default_model: 'claude-sonnet-4-6',
  groups: [
    { provider: 'Anthropic', provider_id: 'anthropic', models: [{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }, { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' }, { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }] },
    { provider: 'OpenRouter', provider_id: 'openrouter', models: [{ id: '@openrouter:anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' }, { id: '@openrouter:google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' }] },
  ],
}

for (const width of [1280, 390]) {
  test(`auxiliary models list and picker fit at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width > 600 ? 900 : 844 })
    await page.route('**/api/model/auxiliary', (route) => route.fulfill({ json: auxiliary }))
    await page.route('**/api/models', (route) => route.fulfill({ json: models }))
    await page.goto('/settings/preferences')
    await settle(page)
    await page.getByRole('button', { name: 'Manage', exact: true }).click()
    const list = page.getByRole('list', { name: 'Auxiliary Models' })
    await expect(list.getByRole('button')).toHaveCount(11)
    await expect(list.getByRole('button', { name: /Title generation/ })).toContainText('OpenRouter · Claude Haiku 4.5')
    await expect(list.getByRole('button', { name: /Vision/ })).toContainText('Not in catalog')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`auxiliary-list-${String(width)}.png`) })

    await list.getByRole('button', { name: /Title generation/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('region', { name: 'OpenRouter' }).getByRole('button', { name: 'Claude Haiku 4.5' })).toHaveAttribute('aria-pressed', 'true')
    await expect(dialog.getByRole('region', { name: 'Anthropic' }).getByRole('button', { name: 'Claude Haiku 4.5' })).toHaveAttribute('aria-pressed', 'false')
    await page.screenshot({ path: testInfo.outputPath(`auxiliary-picker-${String(width)}.png`) })
    await dialog.getByRole('searchbox').fill('gemini')
    await expect(dialog.getByRole('button', { name: 'Gemini 2.5 Flash' })).toBeVisible()
    await expect(dialog.getByRole('region', { name: 'Anthropic' })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`auxiliary-search-${String(width)}.png`) })
  })
}
