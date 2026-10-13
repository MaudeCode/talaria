import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'
import { updatesCheckView } from '../../server/dist/tools/updates.js'

/** Each apply opens the Updating dialog; with no server record to follow it shows the server's answer. */
async function closeUpdating(page: Page, name: string, text: string) {
  const dialog = page.getByRole('dialog', { name: `Updating ${name}` })
  await expect(dialog).toContainText(text)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toBeHidden()
}

// Service-worker requests bypass page routing; these fixtures own every response.
test.use({ serviceWorkers: 'block' })

test('automatic updates retain the selected channel and can apply a Stable npm update', async ({ page }, testInfo) => {
  let settings = { update_channel: 'stable', check_for_updates: true, auto_apply_updates: false }
  let applied = false
  await page.route('**/api/settings', (route) => {
    if (route.request().method() === 'POST') settings = { ...settings, ...route.request().postDataJSON() as Partial<typeof settings> }
    return route.fulfill({ json: settings })
  })
  await page.route('**/api/updates/check', (route) => route.fulfill({ json: updatesCheckView({
    webui: { behind: applied ? 0 : 1, install_kind: 'npm', no_git: true, manual_update: false }, agent: { behind: 0 },
  }) }))
  await page.route('**/api/updates/apply', (route) => {
    expect(route.request().postDataJSON()).toEqual({ target: 'webui', channel: 'stable', tab_id: expect.any(String) })
    applied = true
    return route.fulfill({ json: { ok: true, restart_scheduled: true } })
  })
  await page.goto('/settings/system')
  await settle(page)
  const toggle = page.getByRole('switch', { name: 'Automatically apply Web updates', exact: true })
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await expect.poll(() => settings.auto_apply_updates).toBe(true)
  await page.reload()
  await expect(toggle).toBeChecked()
  await expect(page.getByRole('combobox', { name: 'Web update channel', exact: true })).toContainText('Stable')
  await expect(page.getByRole('combobox', { name: 'Agent update channel', exact: true })).toContainText('Stable')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('automatic-updates.png'), fullPage: true })
  await page.getByRole('button', { name: 'Update Web', exact: true }).click()
  await expect.poll(() => applied).toBe(true)
  await expect(page.getByText('Talaria Web is up to date', { exact: true })).toBeVisible()
})

for (const initialWebBehind of [0, 1]) {
  test(`independent Agent updates: ${initialWebBehind ? 'combined' : 'Agent-only'}`, async ({ page }, testInfo) => {
    let webBehind = initialWebBehind
    let agentBehind = 1
    const targets: string[] = []
    await page.route('**/api/updates/check', (route) => route.fulfill({ json: updatesCheckView({
      cached: false, webui: { behind: webBehind }, agent: { behind: agentBehind },
    }) }))
    await page.route('**/api/updates/apply', (route) => {
      const body = route.request().postDataJSON() as { target: string; channel?: string }
      expect(body).toEqual(body.target === 'webui' ? { target: 'webui', channel: 'stable', tab_id: expect.any(String) } : { target: 'agent', agent_channel: 'stable', tab_id: expect.any(String) })
      targets.push(body.target)
      if (body.target === 'webui') webBehind = 0
      else agentBehind = 0
      return route.fulfill({ json: { ok: true, message: 'Synthetic update complete' } })
    })
    await page.goto('/settings/system')
    await settle(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('agent-updates.png'), fullPage: true })
    if (initialWebBehind) {
      await page.getByRole('button', { name: 'Update Web', exact: true }).click()
      await closeUpdating(page, 'Talaria Web', 'Synthetic update complete')
      await expect(page.getByRole('button', { name: 'Update Web', exact: true })).toHaveCount(0)
    }
    await expect(page.getByRole('button', { name: 'Update Agent', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Update Agent', exact: true }).click()
    await closeUpdating(page, 'Hermes Agent', 'Synthetic update complete')
    await expect(page.getByRole('button', { name: 'Update Agent', exact: true })).toHaveCount(0)
    expect(targets).toEqual(initialWebBehind ? ['webui', 'agent'] : ['agent'])
  })
}

test('Web updates: finish an incomplete release at the current source', async ({ page }, testInfo) => {
  let repair = true
  let applied = 0
  await page.route('**/api/updates/check', (route) => route.fulfill({ json: updatesCheckView({
    cached: false, webui: { behind: 0, metadata_repair: repair, current_sha: 'a'.repeat(40), latest_sha: 'a'.repeat(40) }, agent: { behind: 0 },
  }) }))
  await page.route('**/api/updates/apply', (route) => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().postDataJSON()).toEqual({ target: 'webui', channel: 'stable', tab_id: expect.any(String) })
    applied += 1
    repair = false
    return route.fulfill({ json: { ok: true, restart_scheduled: true, message: 'Release metadata repaired' } })
  })
  await page.goto('/settings/system')
  await settle(page)
  await expect(page.getByText('Finish applying this Talaria Web release', { exact: true })).toBeVisible()
  await expect(page.getByText('Talaria Web is up to date', { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('update-repair.png'), fullPage: true })
  await page.getByRole('button', { name: 'Finish update', exact: true }).click()
  await expect(page.getByText('Talaria Web is up to date', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Finish update', exact: true })).toHaveCount(0)
  expect(applied).toBe(1)
})

test('Experimental uses the existing check and update buttons', async ({ page }, testInfo) => {
  let channel = 'stable'
  let behind = 1
  let applied = 0
  await page.route('**/api/settings', (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { update_channel: string }
      channel = body.update_channel
    }
    return route.fulfill({ json: { update_channel: channel, check_for_updates: true, ignore_agent_updates: true } })
  })
  await page.route('**/api/updates/check', (route) => route.fulfill({ json: updatesCheckView({
    channel, cached: false, webui: { channel, branch: 'origin/main', release_based: false, behind,
      current_sha: 'a'.repeat(40), latest_sha: 'b'.repeat(40) }, agent: { name: 'agent', behind: 0, ignored: true },
  }) }))
  await page.route('**/api/updates/apply', (route) => {
    expect(route.request().postDataJSON()).toEqual({ target: 'webui', channel: 'experimental', tab_id: expect.any(String) })
    applied += 1
    behind = 0
    return route.fulfill({ json: { ok: true, restart_scheduled: true, sourceRevision: 'b'.repeat(40) } })
  })
  await page.goto('/settings/system')
  await settle(page)
  await page.getByRole('combobox', { name: 'Web update channel', exact: true }).click()
  await page.getByRole('option', { name: 'Experimental', exact: true }).click()
  await expect.poll(() => channel).toBe('experimental')
  await page.getByRole('button', { name: 'Check Web now', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Update Web', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('main-updates.png'), fullPage: true })
  await page.getByRole('button', { name: 'Update Web', exact: true }).click()
  await expect(page.getByText('Talaria Web is up to date', { exact: true })).toBeVisible()
  expect(applied).toBe(1)
})

test('ignoring Agent updates shows the server status and removes the Agent action (TAL-559)', async ({ page }, testInfo) => {
  let settings = { update_channel: 'stable', agent_update_channel: 'stable', check_for_updates: true, ignore_agent_updates: false }
  await page.route('**/api/settings', (route) => {
    if (route.request().method() === 'POST') settings = { ...settings, ...route.request().postDataJSON() as Partial<typeof settings> }
    return route.fulfill({ json: settings })
  })
  await page.route('**/api/updates/check', (route) => route.fulfill({ json: updatesCheckView({
    cached: true, webui: { behind: 0 }, agent: settings.ignore_agent_updates ? { name: 'agent', behind: 0, ignored: true } : { behind: 2, release_based: true, current_version: 'abcdef012345', latest_version: 'v2026.10.1' },
  }) }))
  await page.goto('/settings/system')
  await settle(page)
  const agent = page.getByRole('region', { name: 'Hermes Agent', exact: true })
  await expect(agent.getByText('Hermes Agent update available', { exact: true })).toBeVisible()
  await expect(agent.getByText('v2026.10.1', { exact: true })).toBeVisible()
  await expect(agent.getByText('The installed release could not be verified.', { exact: true })).toBeVisible()
  await expect(agent.getByRole('button', { name: 'Update Agent', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('agent-release-ready.png'), fullPage: true })
  await agent.getByRole('switch', { name: 'Ignore Agent updates', exact: true }).click()
  await expect.poll(() => settings.ignore_agent_updates).toBe(true)
  await expect(agent.getByText('Hermes Agent is not being checked for updates', { exact: true })).toBeVisible()
  await expect(agent.getByRole('button', { name: 'Update Agent', exact: true })).toHaveCount(0)
  await expect(page.getByText('Talaria Web is up to date', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('agent-ignored.png'), fullPage: true })
})

for (const scenario of [
  { name: 'private-access', update: { behind: null, manual_update: true, error: 'Synthetic release access unavailable' }, status: 'Talaria Web update check failed' },
  { name: 'local-changes', update: { behind: 1, manual_update: true, dirty: true }, status: 'Local changes block Talaria Web updates' },
]) {
  test(`Web updates: ${scenario.name}`, async ({ page }, testInfo) => {
    await page.route('**/api/updates/check', (route) => route.fulfill({ json: updatesCheckView({ cached: false, webui: scenario.update, agent: { behind: 0 } }) }))
    await page.goto('/settings/system')
    await settle(page)
    await expect(page.getByText(scenario.status, { exact: true })).toBeVisible()
    await expect(page.getByText('Talaria Web is up to date', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^update web$/i })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Install updates manually' })).toHaveAttribute('href', 'https://github.com/MaudeCode/talaria/releases')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`${scenario.name}.png`), fullPage: true })
  })
}

test('Summarize with AI opens a dialog with the server summary of one pending update (TAL-759)', async ({ page }, testInfo) => {
  const summaries: unknown[] = []
  await page.route('**/api/updates/check', (route) => route.fulfill({ json: updatesCheckView({
    cached: true, webui: { behind: 0 },
    agent: { behind: 3, release_based: true, current_version: 'v2026.9.24', latest_version: 'v0.21.7', current_sha: 'a'.repeat(40), latest_sha: 'b'.repeat(40) },
  }) }))
  await page.route('**/api/updates/summary', (route) => {
    summaries.push(route.request().postDataJSON())
    return route.fulfill({ json: { ok: true, target: 'agent', current_version: 'v2026.9.24', target_version: 'v0.21.7', summary: '', generated_by: 'llm', source: 'release_notes', cached: false, summary_sections: [
      { title: "What you'll notice", items: ['Updates now follow tagged releases, so the Agent only moves to published versions.', 'Persistent Shell respects your settings, including environment-based defaults.', 'Requests to the Codex service are compressed, so less data is uploaded.'] },
      { title: 'Worth knowing', items: ['This summary covers the release notes for v0.21.6 and v0.21.7.'] },
    ] } })
  })
  await page.goto('/settings/system')
  await settle(page)
  const agent = page.getByRole('region', { name: 'Hermes Agent', exact: true })
  await expect(agent.getByText('Hermes Agent update available', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Talaria Web', exact: true }).getByRole('button', { name: 'Summarize with AI' })).toHaveCount(0)
  await expect(page.getByRole('switch', { name: "Summarize What's New with AI" })).toHaveCount(0)
  expect(summaries).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('summary-button.png'), fullPage: true })
  await agent.getByRole('button', { name: 'Summarize with AI', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: "What's new in Hermes Agent" })
  await expect(dialog.getByText('v2026.9.24 → v0.21.7', { exact: true })).toBeVisible()
  await expect(dialog.getByText("What you'll notice", { exact: true })).toBeVisible()
  await expect(dialog.getByText('Persistent Shell respects your settings, including environment-based defaults.', { exact: true })).toBeVisible()
  await expect(dialog.getByText('This summary covers the release notes for v0.21.6 and v0.21.7.', { exact: true })).toBeVisible()
  expect(summaries).toEqual([{ target: 'agent' }])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('summary-dialog.png') })
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toBeHidden()
  // Reopening the same range answers from the query cache.
  await agent.getByRole('button', { name: 'Summarize with AI', exact: true }).click()
  await expect(page.getByRole('dialog', { name: "What's new in Hermes Agent" }).getByText("What you'll notice", { exact: true })).toBeVisible()
  expect(summaries).toHaveLength(1)
})

test('a failed Web summary offers Retry, and Retry asks the server again (TAL-759)', async ({ page, errors }) => {
  const summaries: unknown[] = []
  await page.route('**/api/updates/check', (route) => route.fulfill({ json: updatesCheckView({
    cached: true, webui: { behind: 2, release_based: true, current_version: 'web-v1.17.0', latest_version: 'web-v1.18.0', install_kind: 'npm', no_git: true, manual_update: false }, agent: { behind: 0 },
  }) }))
  await page.route('**/api/updates/summary', (route) => {
    summaries.push(route.request().postDataJSON())
    if (summaries.length === 1) return route.fulfill({ status: 500, json: { error: 'model unavailable' } })
    return route.fulfill({ json: { ok: true, target: 'webui', current_version: 'web-v1.17.0', target_version: 'web-v1.18.0', summary: '', generated_by: 'llm', source: 'release_notes', cached: false, summary_sections: [
      { title: "What you'll notice", items: ['Settings shows a summary of each pending update.'] },
    ] } })
  })
  await page.goto('/settings/system')
  await settle(page)
  await page.getByRole('region', { name: 'Talaria Web', exact: true }).getByRole('button', { name: 'Summarize with AI', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: "What's new in Talaria Web" })
  await expect(dialog.getByText("Couldn't summarize what's new.", { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(dialog.getByText('Settings shows a summary of each pending update.', { exact: true })).toBeVisible()
  await expect(dialog.getByText('web-v1.17.0 → web-v1.18.0', { exact: true })).toBeVisible()
  expect(summaries).toEqual([{ target: 'webui' }, { target: 'webui' }])
  // The first summary fails on purpose.
  errors.splice(0, errors.length, ...errors.filter((e) => !/api\/updates\/summary|status of 500/.test(e)))
})

test('older Stable releases fold behind one node and install by version (TAL-946)', async ({ page }, testInfo) => {
  // The shared fixture is the server's own view (its server test re-derives it with updatesCheckView).
  const fixture = updatesCheckView(JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/updates-check.json', import.meta.url), 'utf8')) as Record<string, unknown>)
  const applied: unknown[] = []
  await page.route('**/api/updates/check', (route) => route.fulfill({ json: fixture }))
  await page.route('**/api/updates/apply', (route) => {
    const body = route.request().postDataJSON() as { version?: string }
    applied.push(body)
    return route.fulfill({ json: body.version ? { ok: true, message: 'Synthetic update complete' }
      : { ok: false, confirmation_required: true, candidate_revision: '7'.repeat(40), supported_version: '0.21.6', supported_revision: '8'.repeat(40), agent_channel: 'stable' } })
  })
  await page.goto('/settings/system')
  await settle(page)
  const web = page.getByRole('region', { name: 'Talaria Web', exact: true })
  const agent = page.getByRole('region', { name: 'Hermes Agent', exact: true })
  await expect(agent.getByText('Hermes Agent update available', { exact: true })).toBeVisible()
  await expect(page.getByText(/ is available$/)).toHaveCount(0)
  await expect(agent.getByText('Not tested with this Talaria', { exact: true })).toBeVisible()
  const more = agent.getByRole('button', { name: '1 more version', exact: true })
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await expect(agent.getByText('v0.21.6', { exact: true })).toHaveCount(0)
  // Update first, Summarize beside it on one line.
  for (const [region, label] of [[web, 'Update Web'], [agent, 'Update Agent']] as const) {
    const update = (await region.getByRole('button', { name: label, exact: true }).boundingBox())!
    const summary = (await region.getByRole('button', { name: 'Summarize with AI', exact: true }).boundingBox())!
    expect(summary.y).toBe(update.y)
    expect(summary.x).toBeGreaterThan(update.x)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('versions-folded.png'), fullPage: true })
  await more.click()
  await web.getByRole('button', { name: '2 more versions', exact: true }).click()
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  await expect(agent.getByText('v0.21.6', { exact: true })).toBeVisible()
  await expect(agent.getByText('Supported', { exact: true })).toBeVisible()
  await expect(web.getByRole('button', { name: /^Install web-v1\.1[78]\.0$/ })).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Summarize with AI', exact: true })).toHaveCount(2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('versions-expanded.png'), fullPage: true })
  await agent.getByRole('button', { name: 'Install v0.21.6', exact: true }).click()
  await closeUpdating(page, 'Hermes Agent', 'Synthetic update complete')
  expect(applied).toEqual([{ target: 'agent', agent_channel: 'stable', version: 'v0.21.6', tab_id: expect.any(String) }])
  // The newest release is unchecked, so its Update opens the existing confirmation.
  await agent.getByRole('button', { name: 'Update Agent', exact: true }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('may cause issues')
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(applied).toHaveLength(2)
})
