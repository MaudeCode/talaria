import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

test('incomplete Agent recovery never claims an update succeeded', async ({ page }, info) => {
  await page.route('**/api/health/agent', (route) => route.fulfill({ json: { alive: true, chat: { available: false, condition: 'agent_runtime_stale', agent_update_state: 'incomplete', agent_runtime_reason: 'recovery_incomplete', retryable: true, restart_scheduled: false } } }))
  await page.goto('/')
  await expect(page.locator('.composer-dock--hero')).toBeVisible()
  const title = 'Agent update recovery is incomplete'
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible()
  if (process.env.TAL_1111_EVIDENCE) await page.screenshot({ path: `${process.env.TAL_1111_EVIDENCE}/after-${info.project.name}.png`, fullPage: true })
})
