import { expect, expectNoOverflow, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

// TAL-1423: one chat's effort and speed in one composer chip, from synthetic server statuses.
test('a chat picks its own speed from the effort chip and keeps it across a reload', async ({ page }, testInfo) => {
  const sid = 'speed-chat'
  const status = { reasoning_effort: 'high', supported_efforts: ['low', 'medium', 'high'], effort_options: ['low', 'medium', 'high'], supports_reasoning_effort: true, supports_session_scope: true,
    service_tier: 'default', supported_speed_tiers: [{ id: 'standard', service_tier: 'default' }, { id: 'priority', service_tier: 'priority' }, { id: 'ultrafast', service_tier: 'ultrafast' }] }
  const writes: unknown[] = []
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Pick a speed', model: 'gpt-6-astra', model_provider: 'openai-codex', messages: [{ role: 'user', id: 1, content: 'Summarize the release notes' }, { role: 'assistant', id: 2, content: 'Here is the summary.' }] } } }))
  await page.route('**/api/reasoning**', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { service_tier: string }
      writes.push(body)
      status.service_tier = body.service_tier
    }
    await route.fulfill({ json: status })
  })
  const shots = process.env.TAL1423_SHOTS
  const shot = (name: string) => shots ? page.screenshot({ path: `${shots}/${testInfo.project.name}-${name}.png` }).then(() => undefined) : Promise.resolve()
  await page.goto(`/session/${sid}`)
  await settle(page)
  // A phone composer shows its controls once focused and folds the chip into its settings panel once it fits its footer,
  // so wait for that layout instead of reading the chip mid-refit.
  const chip = (name: string) => page.getByRole('button', { name, exact: true }).filter({ visible: true })
  const open = async (name: string) => {
    await page.getByRole('textbox').click()
    if (testInfo.project.name === 'mobile') {
      await expect(page.locator('.composer-footer.cf-burger')).toBeVisible()
      const panel = page.locator('#composerMobileConfigBtn')
      if (await panel.getAttribute('aria-expanded') !== 'true') await panel.click()
      await expect(panel).toHaveAttribute('aria-expanded', 'true')
    }
    await chip(name).click()
  }
  await open('Reasoning effort: High')
  await expect(page.getByRole('menuitemradio', { name: 'Ultrafast' })).toBeVisible()
  await shot('menu')
  await page.getByRole('menuitemradio', { name: 'Ultrafast' }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Reasoning effort: High, Speed: Ultrafast', exact: true }).first()).toBeAttached()
  expect(writes).toEqual([{ service_tier: 'ultrafast', session_id: sid }])
  await page.reload()
  await settle(page)
  await open('Reasoning effort: High, Speed: Ultrafast')
  await expect(page.getByRole('menuitemradio', { name: 'Ultrafast' })).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await shot('chip')
  await expectNoOverflow(page, 'chat-speed', shots ? shot : undefined)
})
