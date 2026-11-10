import { mkdirSync } from 'node:fs'
import { SettingsSectionSchema } from '@maudecode/talaria-web-contracts'
import { ToolsTabSchema } from '../src/contracts/url'
import type { Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'
import { bootDemoServer, DEMO_SESSION_ID } from './demo-server'

test.use({ serviceWorkers: 'block' })

/** A full-height screenshot: pages scroll inside their own pane, so the viewport grows by the tallest pane's hidden part. */
async function fullHeightShot(page: Page, path: string) {
  const viewport = page.viewportSize()!
  const hidden = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('*')]
    .filter((el) => /auto|scroll/.test(getComputedStyle(el).overflowY))
    .map((el) => el.scrollHeight - el.clientHeight)))
  await page.setViewportSize({ ...viewport, height: viewport.height + hidden })
  await settle(page)
  await page.screenshot({ path, fullPage: true })
  await page.setViewportSize(viewport)
}

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
    if (shots) await fullHeightShot(page, `${shots}/${name}-${info.project.name}.png`)
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

/** Sections whose pane scrolls sideways today, keyed `<section>-<project>`, with the ticket that fixes each. Shrinks only. */
const KNOWN_PANE_OVERFLOW: Readonly<Record<string, string>> = {
  // A hidden centered tooltip on the trailing header action sticks out past the pane's right edge.
  'profiles-mobile': 'TAL-2125',
  'workspaces-mobile': 'TAL-2125',
}

// TAL-2103: the Settings gallery. Every section, and each Tools tab, shows its heading with no sideways scroll; with
// `TOUR_SHOTS` each is saved as `settings-<id>-<project>.png`, the picture a Settings change is reviewed against.
test('every Settings section and Tools tab shows its heading without horizontal overflow', async ({ page }, info) => {
  const { server } = await bootDemoServer()
  const shots = process.env.TOUR_SHOTS
  if (shots) mkdirSync(shots, { recursive: true })
  // Connectors is a tab only behind the server's gate; open the gate so the gallery covers every tab.
  await page.route('**/api/connectors/available', (route) => route.fulfill({ json: { available: true } }))
  const pages = [
    ...SettingsSectionSchema.options.map((id) => ({ name: id, path: id, tab: undefined })),
    ...ToolsTabSchema.options.map((tab) => ({ name: `tools-${tab}`, path: `tools?tab=${tab}`, tab })),
  ]
  try {
    for (const { name, path, tab } of pages) {
      await page.goto(`${server.base}/settings/${path}`)
      await expect(page, name).toHaveURL((url) => `${url.pathname}${url.search}` === `/settings/${path}`)
      await expect(page.locator('#main .settings-section-title'), name).toBeVisible()
      if (tab) await expect(page.getByRole('tab', { selected: true }), name).toHaveAttribute('aria-controls', `tools-${tab}`)
      await settle(page)
      // The section scrolls inside its own pane (`overflow-y-auto`), so a too-wide row scrolls there, not the document.
      const pane = page.locator('#main .settings-main').locator('..')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} has no horizontal overflow`).toBe(true)
      const known = KNOWN_PANE_OVERFLOW[`${name}-${info.project.name}`]
      expect(await pane.evaluate((el) => el.scrollWidth <= el.clientWidth), known ? `${name} still overflows its pane (${known}); remove its KNOWN_PANE_OVERFLOW entry` : `${name} has no horizontal overflow in its pane`).toBe(!known)
      if (shots) await fullHeightShot(page, `${shots}/settings-${name}-${info.project.name}.png`)
    }
  } finally { await page.goto('about:blank').catch(() => undefined); await server.close() }
})
