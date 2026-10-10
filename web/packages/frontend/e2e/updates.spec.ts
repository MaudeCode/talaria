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
  await expect(agent.getByText('Hermes Agent v2026.10.1 is available', { exact: true })).toBeVisible()
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

test("What's new: the summary loads into the update path only once the setting is on (TAL-609)", async ({ page }, testInfo) => {
  let settings = { update_channel: 'stable', check_for_updates: true, whats_new_summary_enabled: false }
  const summaries: unknown[] = []
  await page.route('**/api/settings', (route) => {
    if (route.request().method() === 'POST') settings = { ...settings, ...route.request().postDataJSON() as Partial<typeof settings> }
    return route.fulfill({ json: settings })
  })
  await page.route('**/api/updates/check', (route) => route.fulfill({ json: updatesCheckView({
    cached: true, webui: { behind: 2, current_sha: 'a'.repeat(40), latest_sha: 'b'.repeat(40) }, agent: { behind: 0 },
  }) }))
  await page.route('**/api/updates/summary', (route) => {
    summaries.push(route.request().postDataJSON())
    return route.fulfill({ json: { ok: true, generated_by: 'llm', summary_sections: [
      { title: "What you'll notice", items: ['Chats open faster after a restart.', 'The model picker remembers your last choice.'] },
      { title: 'Worth knowing', items: ['This summary combines both pending updates.'] },
    ] } })
  })
  await page.goto('/settings/system')
  await settle(page)
  const web = page.getByRole('region', { name: 'Talaria Web', exact: true })
  await expect(web.getByText('Talaria Web is 2 commits behind', { exact: true })).toBeVisible()
  await expect(web.getByText("What you'll notice", { exact: true })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('whats-new-off.png'), fullPage: true })
  expect(summaries).toEqual([])
  await page.getByRole('switch', { name: "Summarize What's New with AI", exact: true }).click()
  await expect.poll(() => settings.whats_new_summary_enabled).toBe(true)
  await expect(web.getByText("What you'll notice", { exact: true })).toBeVisible()
  await expect(web.getByText('Chats open faster after a restart.', { exact: true })).toBeVisible()
  await expect(web.getByText('Worth knowing', { exact: true })).toBeVisible()
  await expect(web.getByText('This summary combines both pending updates.', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Hermes Agent', exact: true }).getByText("What you'll notice")).toHaveCount(0)
  expect(summaries).toEqual([{ updates: { webui: expect.objectContaining({ behind: 2, current_sha: 'a'.repeat(40), latest_sha: 'b'.repeat(40) }) }, target: 'webui' }])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('whats-new-on.png'), fullPage: true })
})
