import { mkdirSync } from 'node:fs'
import { expect, settle, test } from './fixtures'
import { bootDemoServer, DEMO_SESSION_ID } from './demo-server'

test.use({ serviceWorkers: 'block' })

// The demo server's contract: each page the replay server leaves empty shows its seeded rows. `TOUR_SHOTS=<dir>` also
// saves a full-height screenshot of every page, for a design review that needs pages with data on them.
test('the demo server shows seeded data on every data page', async ({ page }, info) => {
  const { server, reviewId } = await bootDemoServer()
  const shots = process.env.TOUR_SHOTS
  if (shots) mkdirSync(shots, { recursive: true })
  const visit = async (name: string, path: string, seeded: string) => {
    await page.goto(server.base + path)
    await expect(page.locator('#main').getByText(seeded, { exact: true }).first()).toBeVisible()
    await settle(page)
    if (shots) await page.screenshot({ path: `${shots}/${name}-${info.project.name}.png`, fullPage: true })
  }
  try {
    await visit('chat', `/session/${DEMO_SESSION_ID}`, 'Filed two tickets and ordered them so they cannot conflict.')
    if (info.project.name === 'desktop') {
      await page.locator('#composerModelChip').click()
      await expect(page.getByRole('option', { name: /^Claude Sonnet 4\.6/ }).first()).toBeVisible()
      if (shots) await page.screenshot({ path: `${shots}/model-menu-${info.project.name}.png` })
      await page.keyboard.press('Escape')
    }
    await visit('tasks', '/tasks', 'Dependency audit')
    await visit('insights-usage', '/insights?tab=usage', 'claude-sonnet-4-6')
    await visit('decisions', '/decisions', 'Settings audit')
    await visit('decision-review', `/decisions/${reviewId}`, 'Retention policy')
    await visit('discussions', '/groups', 'Design review')
    await visit('discussion', '/groups?room=discussion', 'Review this proposal before Friday.')
  } finally { await page.goto('about:blank').catch(() => undefined); await server.close() }
})
