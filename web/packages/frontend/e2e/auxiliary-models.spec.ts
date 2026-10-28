import type { DelegationSettings } from '@maudecode/talaria-web-contracts'
import { expect, settle, test } from './fixtures'

// Service-worker requests bypass page routing; these fixtures own every response.
test.use({ serviceWorkers: 'block' })

const SLOTS: [string, string, string][] = [
  ['vision', 'Vision', 'image/screenshot analysis'], ['compression', 'Compression', 'context summarization'],
  ['approval', 'Approval', 'smart command approval'], ['mcp', 'MCP', 'MCP tool reasoning'],
  ['title_generation', 'Title generation', 'session titles'], ['review', 'Review', '/review reviewer subagent'],
  ['memory_query_rewrite', 'Memory query rewrite', 'memory retrieval queries'], ['tts_audio_tags', 'TTS audio tags', 'Gemini TTS tag insertion'],
  ['voice_chat', 'Voice chat', 'spoken voice-mode replies'], ['skills_hub', 'Skills hub', 'skills search/install'],
  ['triage_specifier', 'Triage specifier', 'kanban spec fleshing'], ['kanban_decomposer', 'Kanban decomposer', 'task decomposition'],
  ['profile_describer', 'Profile describer', 'auto profile descriptions'], ['curator', 'Curator', 'skill-usage review pass'],
  ['side_task', 'Side model', 'side summaries'],
]
const auxiliary = {
  main: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  tasks: SLOTS.map(([task, label, description]) => ({
    task, label, description, provider: 'auto', model: '', is_auto: true, value_label: 'Claude Sonnet 4.6', provider_label: 'Anthropic', selected_option_id: null, in_catalog: true,
    inherit_from: null, reasoning_effort: task === 'voice_chat' ? 'none' : '',
    ...(task === 'title_generation' ? { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5', is_auto: false, value_label: 'Claude Haiku 4.5', provider_label: 'OpenRouter', selected_option_id: '@openrouter:anthropic/claude-haiku-4.5' } : {}),
    ...(task === 'vision' ? { provider: 'openrouter', model: 'legacy/vision-model', is_auto: false, value_label: 'legacy/vision-model', provider_label: 'OpenRouter', in_catalog: false } : {}),
    // A plugin task inheriting Compression, which is pinned: while Auto it shows Compression's model (TAL-800).
    ...(task === 'compression' ? { provider: 'anthropic', model: 'claude-opus-4-7', is_auto: false, value_label: 'Claude Opus 4.7', selected_option_id: 'claude-opus-4-7' } : {}),
    ...(task === 'side_task' ? { inherit_from: 'compression', value_label: 'Claude Opus 4.7' } : {}),
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
    await expect(list.getByRole('button')).toHaveCount(15)
    await expect(list.getByRole('button', { name: /Voice chat/ })).toBeVisible()
    await expect(list.getByRole('button', { name: /Side model/ })).toContainText('Anthropic · Claude Opus 4.7')
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

for (const width of [1280, 390]) {
  test(`delegation mode recovery and route editing fit at ${width}px`, async ({ page }, testInfo) => {
    const { default: fixtures } = await import('../../../../contracts/fixtures/delegation-settings.json', { with: { type: 'json' } })
    let delegation: DelegationSettings = structuredClone(fixtures.missing)
    const tasks = [...auxiliary.tasks, { task: 'delegation', label: 'Delegation', description: 'subagent model (delegate_task)', provider: 'auto', model: '', is_auto: true, value_label: '', provider_label: '', selected_option_id: null, in_catalog: true, inherit_from: null, reasoning_effort: '' }]
    await page.setViewportSize({ width, height: width > 600 ? 900 : 844 })
    await page.route('**/api/model/auxiliary', (route) => route.fulfill({ json: { ...auxiliary, tasks, delegation } }))
    await page.route('**/api/models', (route) => route.fulfill({ json: models }))
    await page.route('**/api/model/auxiliary/delegation', async (route) => {
      const write = route.request().postDataJSON() as { action: string; backend: string; block: typeof delegation.model_map }
      if (write.action === 'backend') delegation = { ...fixtures.default, configured: write.backend, effective: write.backend, fixed_model_active: write.backend === 'default' }
      else delegation = { ...delegation, [write.backend]: write.block }
      await route.fulfill({ json: { ...auxiliary, tasks, delegation } })
    })
    await page.goto('/settings/preferences')
    await settle(page)
    await page.getByRole('button', { name: 'Manage', exact: true }).click()
    await page.getByRole('list', { name: 'Auxiliary Models' }).getByRole('button', { name: /Delegation/ }).click()
    await expect(page.getByRole('dialog').getByRole('status')).toContainText('Install or enable')
    await expect(page.getByRole('button', { name: 'Fixed model' })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`delegation-unavailable-${String(width)}.png`) })
    await page.getByRole('button', { name: 'Restore Default' }).click()
    await expect(page.getByRole('combobox', { name: 'Mode' })).toContainText('Default')
    await page.getByRole('combobox', { name: 'Mode' }).click()
    await page.getByRole('option', { name: 'Named model routes', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Fixed model' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Model routes', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Edit Research' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`delegation-routes-${String(width)}.png`) })
    await page.getByRole('button', { name: 'Edit Research' }).click()
    await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Research')
    await expect(page.getByRole('combobox', { name: 'Service tier' })).toContainText('Normal')
    await page.screenshot({ path: testInfo.outputPath(`delegation-edit-${String(width)}.png`) })
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Deep research')
    await page.getByRole('button', { name: 'Save', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`delegation-edit-actions-${String(width)}.png`) })
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Edit Deep research' })).toBeVisible()
    await page.getByRole('button', { name: 'Delete Deep research' }).click()
    await expect(page.getByRole('button', { name: 'Edit Deep research' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await page.getByRole('button', { name: 'Profile routes', exact: true }).click()
    await page.getByRole('button', { name: 'Add route', exact: true }).click()
    await expect(page.getByText('This profile lends its credentials, SOUL, skills and terminal policy to subagents.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await page.screenshot({ path: testInfo.outputPath(`delegation-profile-${String(width)}.png`) })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('dialog').press('Escape')
    delegation = structuredClone(fixtures.readonly)
    await page.reload()
    await settle(page)
    await page.getByRole('button', { name: 'Manage', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Reset all to auto' })).toBeDisabled()
    await page.getByRole('list', { name: 'Auxiliary Models' }).getByRole('button', { name: /Delegation/ }).click()
    await expect(page.getByRole('combobox', { name: 'Mode' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Profile routes', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Restore Default' })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`delegation-readonly-${String(width)}.png`) })
  })
}
