import type { DelegationSettings } from '@maudecode/talaria-web-contracts'
import type { Page } from '@playwright/test'
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
const reasoning = (task: string, saved: string | null = null) => ({ saved, effective: saved ?? '', inherited: saved === null, default_source: task === 'delegation' ? 'parent' : 'provider',
  options: ['review', 'memory_query_rewrite'].includes(task) ? [] : ['low', 'medium', 'high', 'none'], unavailable: ['review', 'memory_query_rewrite'].includes(task) ? 'slot' : null })
const auxiliary = {
  main: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  tasks: SLOTS.map(([task, label, description]) => ({
    task, label, description, provider: 'auto', model: '', is_auto: true, value_label: 'Claude Sonnet 4.6', provider_label: 'Anthropic', selected_option_id: null, in_catalog: true,
    inherit_from: null, reasoning_effort: task === 'voice_chat' ? 'none' : '', reasoning: reasoning(task, task === 'compression' ? 'medium' : null),
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

/** The expanded task's inline editor: its list row. */
const taskRow = (page: Page, name: RegExp) => page.getByRole('list', { name: 'Auxiliary Models' }).getByRole('listitem').filter({ has: page.getByRole('button', { name }) })

for (const width of [1280, 390]) {
  test(`auxiliary models page, inline picker and reasoning fit at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width > 600 ? 900 : 844 })
    let state = auxiliary
    await page.route('**/api/model/auxiliary', (route) => route.fulfill({ json: state }))
    await page.route('**/api/models', (route) => route.fulfill({ json: models }))
    const writes: unknown[] = []
    await page.route('**/api/model/set', async (route) => {
      const body = route.request().postDataJSON() as { task: string; reasoning_effort?: string }
      writes.push(body)
      state = { ...state, tasks: state.tasks.map((t) => t.task === body.task ? { ...t, reasoning: reasoning(t.task, body.reasoning_effort ?? null) } : t) }
      await route.fulfill({ json: { ok: true, auxiliary: state } })
    })
    await page.goto('/settings/auxiliary')
    await settle(page)
    await expect(page.getByRole('heading', { level: 1, name: 'Auxiliary Models' })).toBeVisible()
    const list = page.getByRole('list', { name: 'Auxiliary Models' })
    await expect(list.getByRole('button')).toHaveCount(15)
    await expect(list.getByRole('button', { name: /Voice chat/ })).toBeVisible()
    await expect(list.getByRole('button', { name: /Side model/ })).toContainText('Anthropic · Claude Opus 4.7')
    await expect(list.getByRole('button', { name: /Title generation/ })).toContainText('OpenRouter · Claude Haiku 4.5')
    await expect(list.getByRole('button', { name: /Compression/ })).toContainText('Claude Opus 4.7 · medium')
    await expect(list.getByRole('button', { name: /Vision/ })).toContainText('Not in catalog')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`auxiliary-list-${String(width)}.png`) })

    await list.getByRole('button', { name: /Title generation/ }).click()
    const editor = taskRow(page, /Title generation/)
    await expect(editor.getByRole('region', { name: 'OpenRouter' }).getByRole('button', { name: 'Claude Haiku 4.5' })).toHaveAttribute('aria-pressed', 'true')
    await expect(editor.getByRole('region', { name: 'Anthropic' }).getByRole('button', { name: 'Claude Haiku 4.5' })).toHaveAttribute('aria-pressed', 'false')
    await expect(editor.getByRole('button', { name: 'Reasoning effort: Default' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`auxiliary-picker-${String(width)}.png`) })
    await editor.getByRole('button', { name: 'Reasoning effort: Default' }).click()
    await expect(page.getByRole('menuitemradio')).toHaveText(['Default', 'low', 'medium', 'high', 'none'])
    await page.screenshot({ path: testInfo.outputPath(`auxiliary-reasoning-${String(width)}.png`) })
    await page.getByRole('menuitemradio', { name: 'high' }).click()
    await page.getByRole('menu').press('Escape')
    await expect(list.getByRole('button', { name: /Title generation/ })).toContainText('Claude Haiku 4.5 · high')
    // An effort-only write keeps the route: it names neither model nor provider.
    expect(writes).toEqual([{ scope: 'auxiliary', task: 'title_generation', reasoning_effort: 'high' }])
    await editor.getByRole('searchbox').fill('gemini')
    await expect(editor.getByRole('button', { name: 'Gemini 2.5 Flash' })).toBeVisible()
    await expect(editor.getByRole('region', { name: 'Anthropic' })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`auxiliary-search-${String(width)}.png`) })
    // A slot the Agent says ignores an effort offers no control.
    await list.getByRole('button', { name: /Review/ }).click()
    await expect(taskRow(page, /Review/).getByRole('button', { name: /Reasoning effort/ })).toHaveCount(0)
  })
}

for (const width of [1280, 390]) {
  test(`auxiliary models is its own Settings page in the sidebar, replacing Preferences > Manage, at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width > 600 ? 900 : 844 })
    await page.route('**/api/model/auxiliary', (route) => route.fulfill({ json: auxiliary }))
    await page.route('**/api/models', (route) => route.fulfill({ json: models }))
    await page.goto('/settings/preferences')
    await settle(page)
    await expect(page.getByRole('button', { name: 'Manage', exact: true })).toHaveCount(0)
    const hamburger = page.locator('#btnHamburger')
    if (await hamburger.isVisible()) await hamburger.click()
    const entry = page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Auxiliary Models' })
    await expect(entry).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`auxiliary-sidebar-${String(width)}.png`) })
    await entry.click()
    await expect(page).toHaveURL(/\/settings\/auxiliary$/)
    await expect(page.getByRole('list', { name: 'Auxiliary Models' })).toBeVisible()
    if (await hamburger.isVisible()) await hamburger.click()
    await expect(page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Auxiliary Models' })).toHaveAttribute('aria-current', 'page')
    await page.goBack()
    await expect(page).toHaveURL(/\/settings\/preferences$/)
  })
}

test('the task list, Auto and a custom id do not wait for a held catalog, and switching tasks reads no catalog again', async ({ page }) => {
  let catalogReads = 0
  let releaseCatalog!: () => void
  const held = new Promise<void>((resolve) => { releaseCatalog = resolve })
  await page.route('**/api/model/auxiliary', (route) => route.fulfill({ json: auxiliary }))
  await page.route('**/api/models', async (route) => { catalogReads += 1; await held; await route.fulfill({ json: models }) })
  // No network-idle wait: the held catalog keeps the network busy by design.
  await page.goto('/settings/auxiliary')
  const list = page.getByRole('list', { name: 'Auxiliary Models' })
  await expect(list.getByRole('button', { name: /Vision/ })).toContainText('legacy/vision-model')
  await list.getByRole('button', { name: /Title generation/ }).click()
  await expect(taskRow(page, /Title generation/).getByRole('button', { name: /^Auto/ })).toBeEnabled()
  await expect(taskRow(page, /Title generation/).getByRole('textbox', { name: /Custom model ID/ })).toBeEditable()
  await list.getByRole('button', { name: /Compression/ }).click()
  await expect(list.getByRole('button', { name: /Title generation/ })).toHaveAttribute('aria-expanded', 'false')
  releaseCatalog()
  await expect(taskRow(page, /Compression/).getByRole('region', { name: 'Anthropic' })).toBeVisible()
  const reads = catalogReads
  await list.getByRole('button', { name: /Vision/ }).click()
  await expect(taskRow(page, /Vision/).getByRole('region', { name: 'Anthropic' })).toBeVisible()
  await list.getByRole('button', { name: /Title generation/ }).click()
  await expect(taskRow(page, /Title generation/).getByRole('region', { name: 'Anthropic' })).toBeVisible()
  expect(catalogReads).toBe(reads)
})

for (const width of [1280, 390]) {
  test(`delegation mode recovery and route editing fit at ${width}px`, async ({ page }, testInfo) => {
    const { default: fixtures } = await import('../../../../contracts/fixtures/delegation-settings.json', { with: { type: 'json' } })
    let delegation: DelegationSettings = structuredClone(fixtures.missing)
    const tasks = [...auxiliary.tasks, { task: 'delegation', label: 'Delegation', description: 'subagent model (delegate_task)', provider: 'auto', model: '', is_auto: true, value_label: '', provider_label: '', selected_option_id: null, in_catalog: true, inherit_from: null, reasoning_effort: '', reasoning: reasoning('delegation') }]
    await page.setViewportSize({ width, height: width > 600 ? 900 : 844 })
    await page.route('**/api/model/auxiliary', (route) => route.fulfill({ json: { ...auxiliary, tasks, delegation } }))
    await page.route('**/api/models', (route) => route.fulfill({ json: models }))
    await page.route('**/api/model/auxiliary/delegation', async (route) => {
      const write = route.request().postDataJSON() as { action: string; backend: string; block: typeof delegation.model_map }
      if (write.action === 'backend') delegation = { ...fixtures.default, configured: write.backend, effective: write.backend, fixed_model_active: write.backend === 'default' }
      else delegation = { ...delegation, [write.backend]: write.block }
      await route.fulfill({ json: { ...auxiliary, tasks, delegation } })
    })
    await page.goto('/settings/auxiliary')
    await settle(page)
    await page.getByRole('list', { name: 'Auxiliary Models' }).getByRole('button', { name: /Delegation/ }).click()
    await expect(taskRow(page, /Delegation/).getByRole('status')).toContainText('Install or enable')
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
    await page.getByRole('combobox', { name: 'Profile' }).click()
    await page.getByRole('option', { name: 'research', exact: true }).click()
    await page.getByRole('checkbox').check()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Default', exact: true })).toContainText('No default')
    await expect(page.getByRole('button', { name: 'Edit research' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`delegation-created-profile-${String(width)}.png`) })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    delegation = structuredClone(fixtures.readonly)
    await page.reload()
    await settle(page)
    await expect(page.getByRole('button', { name: 'Reset all to auto' })).toBeDisabled()
    await page.getByRole('list', { name: 'Auxiliary Models' }).getByRole('button', { name: /Delegation/ }).click()
    await expect(page.getByRole('combobox', { name: 'Mode' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Profile routes', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Restore Default' })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`delegation-readonly-${String(width)}.png`) })
  })
}
