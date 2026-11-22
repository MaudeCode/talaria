import { mkdirSync } from 'node:fs'
import { SettingsSectionSchema } from '@maudecode/talaria-web-contracts'
import { ChatPageSchema, ToolsTabSchema } from '../src/contracts/url'
import type { Page, TestInfo } from '@playwright/test'
import { DUO_VIEWPORTS, expect, expectNoOverflow, settle, test } from './fixtures'
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

type Theme = 'dark' | 'light'

/**
 * One tour pass's screenshots and checks. Dark saves `<page>-<project>.png`; light saves `<page>-light-<project>.png`.
 * The dark pass on the desktop project also checks each page at every Duo viewport and saves `<page>-<viewport>.png`
 * (the viewports are set explicitly, so the mobile project would repeat them).
 */
function tour(page: Page, info: TestInfo, theme: Theme) {
  const shots = process.env.TOUR_SHOTS
  if (shots) mkdirSync(shots, { recursive: true })
  const suffix = theme === 'light' ? `light-${info.project.name}` : info.project.name
  const duo = theme === 'dark' && info.project.name === 'desktop'
  return {
    desktop: info.project.name === 'desktop',
    /** Checks the page as it stands: the theme took, then the Duo viewports and screenshots. */
    check: async (name: string, full = true, pane?: Parameters<typeof expectNoOverflow>[3]) => {
      const html = expect(page.locator('html'), `${name} renders in the ${theme} theme`)
      await (theme === 'dark' ? html : html.not).toHaveClass(/\bdark\b/)
      const save = async (file: string) => {
        if (!shots) return
        if (full) await fullHeightShot(page, `${shots}/${file}.png`)
        else await page.screenshot({ path: `${shots}/${file}.png` })
      }
      await save(`${name}-${suffix}`)
      if (duo) await expectNoOverflow(page, name, shots ? save : undefined, pane)
    },
  }
}

/** Picks the Light tile in Settings › Appearance, the control a user has; the choice persists in the browser for the test. */
async function pickLightTheme(page: Page, base: string) {
  await page.goto(`${base}/settings/appearance`)
  await page.locator('#main [data-theme-val="light"]').click()
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
}

// The demo server's contract: each page the replay server leaves empty shows its seeded rows. `TOUR_SHOTS=<dir>` also
// saves a full-height screenshot of every page, for a design review that needs pages with data on them.
async function dataPages(page: Page, info: TestInfo, theme: Theme) {
  const { server, reviewId } = await bootDemoServer()
  const { desktop, check } = tour(page, info, theme)
  const visit = async (name: string, path: string, seeded: string) => {
    await page.goto(server.base + path)
    await expect(page.locator('#main').getByText(seeded, { exact: true }).first()).toBeVisible()
    await settle(page)
    await check(name)
  }
  try {
    if (theme === 'light') await pickLightTheme(page, server.base)
    if (desktop) {
      // TAL-2098: a fresh new chat's chip names the default workspace and its menu row is the selected one.
      await page.goto(`${server.base}/`)
      await expect(page.locator('#composerWorkspaceChip')).toHaveText('Home')
      await page.locator('#composerWorkspaceChip').click()
      await expect(page.getByRole('menuitemradio', { checked: true })).toContainText('Home')
      await check('workspace-menu', false)
      await page.keyboard.press('Escape')
    }
    await visit('chat', `/session/${DEMO_SESSION_ID}`, 'Filed two tickets and ordered them so they cannot conflict.')
    if (desktop) {
      // TAL-2513: the chip opens its windows, account before model-only, with the provider's Settings link.
      await page.getByRole('button', { name: 'Provider quota: 21% left' }).click()
      const detail = page.getByRole('dialog', { name: 'Provider quota' })
      await expect(detail.locator('[data-quota-window]')).toHaveText([/^5h/, /^Weekly/, /^Opus week/])
      await expect(detail.getByRole('button', { name: 'Provider settings' })).toBeVisible()
      if (process.env.TOUR_SHOTS) { await settle(page); await page.screenshot({ path: `${process.env.TOUR_SHOTS}/quota-detail-${theme}.png` }) }
      await page.keyboard.press('Escape')
      await page.locator('#composerModelChip').click()
      await expect(page.getByRole('option', { name: /^Claude Sonnet 4\.6/ }).first()).toBeVisible()
      await check('model-menu', false)
      await page.keyboard.press('Escape')
    }
    await visit('tasks', '/tasks', 'Dependency audit')
    await visit('tasks-scripts', '/tasks?tab=scripts', 'backup-notes.sh')
    await visit('insights-quotas', '/insights?tab=quotas', 'Usage limit resets')
    await visit('insights-usage', '/insights?tab=usage', 'claude-sonnet-4-6')
    await visit('decisions', '/decisions', 'Settings audit')
    await visit('decision-review', `/decisions/${reviewId}`, 'Retention policy')
    await visit('discussions', '/groups', 'Design review')
    await visit('discussion', '/groups?room=discussion', 'Review this proposal before Friday.')
    await visit('memory', '/memory', 'Deploys go through the staging host first.')
  } finally { await page.goto('about:blank').catch(() => undefined); await server.close() }
}

test('the demo server shows seeded data on every data page', async ({ page }, info) => {
  await dataPages(page, info, 'dark')
})

// The light passes repeat the dark passes' checks, so they run only to save the light screenshots. Picking the light
// theme in Settings › Appearance is checked by tool-row-outcomes.spec.ts and tool-row-raw-view.spec.ts.
const LIGHT_SHOTS_ONLY = 'the light pass only saves screenshots (TOUR_SHOTS)'

test('every data page shows its seeded data in the light theme', async ({ page }, info) => {
  test.skip(!process.env.TOUR_SHOTS, LIGHT_SHOTS_ONLY)
  await dataPages(page, info, 'light')
})

// TAL-2103: the Settings gallery. Every section, and each Tools tab, shows its heading with no sideways scroll; with
// `TOUR_SHOTS` each is saved as `settings-<id>-<project>.png`, the picture a Settings change is reviewed against. The
// gallery runs as groups of at most six pages, one test each, so no test walks all 25 (TAL-2405, test-audit rule oversized).
interface SettingsPage { name: string, path: string, tab?: (typeof ToolsTabSchema.options)[number] }
const sections = SettingsSectionSchema.options.map((id): SettingsPage => ({ name: id, path: id }))
const sectionGroups = Array.from({ length: Math.ceil(sections.length / 5) }, (_, i) => sections.slice(i * 5, i * 5 + 5))
const settingsGroups: { title: string, pages: SettingsPage[] }[] = [
  ...sectionGroups.map((pages) => ({ title: `the Settings sections ${pages[0]!.name} to ${pages.at(-1)!.name}`, pages })),
  { title: 'every Tools tab', pages: ToolsTabSchema.options.map((tab) => ({ name: `tools-${tab}`, path: `tools?tab=${tab}`, tab })) },
  {
    title: 'every Settings sub-page',
    pages: [
      // TAL-2085: a profile's detail page.
      { name: 'profiles-detail', path: 'profiles?name=default' },
      // TAL-2135: a configured provider's own page.
      { name: 'providers-anthropic', path: 'providers/anthropic' },
      // TAL-2136: the quota alert thresholds' own page.
      { name: 'providers-quota-alerts', path: 'providers/quota-alerts' },
      // TAL-2138: Chat's sub-pages.
      ...ChatPageSchema.options.map((page) => ({ name: `chat-${page}`, path: `chat/${page}` })),
    ],
  },
]

async function settingsPages(page: Page, info: TestInfo, theme: Theme, pages: SettingsPage[]) {
  const { server } = await bootDemoServer()
  const { check } = tour(page, info, theme)
  // Connectors is a tab only behind the server's gate; open the gate so the gallery covers every tab.
  await page.route('**/api/connectors/available', (route) => route.fulfill({ json: { available: true } }))
  try {
    if (theme === 'light') await pickLightTheme(page, server.base)
    for (const { name, path, tab } of pages) {
      await page.goto(`${server.base}/settings/${path}`)
      await expect(page, name).toHaveURL((url) => `${url.pathname}${url.search}` === `/settings/${path}`)
      await expect(page.locator('#main .settings-section-title'), name).toBeVisible()
      if (tab) await expect(page.getByRole('tab', { selected: true }), name).toHaveAttribute('aria-controls', `tools-${tab}`)
      // TAL-2132: the stock install's 64 plugins fold into at most 12 rows until a group opens.
      if (tab === 'plugins') {
        await expect(page.locator('#main [data-plugin-group]').first(), name).toBeVisible()
        expect(await page.locator('#main [data-plugin], #main [data-plugin-group]').count(), name).toBeLessThanOrEqual(12)
      }
      await settle(page)
      // The section scrolls inside its own pane (`overflow-y-auto`), so a too-wide row scrolls there, not the document.
      const pane = page.locator('#main .settings-main').locator('..')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} has no horizontal overflow`).toBe(true)
      expect(await pane.evaluate((el) => el.scrollWidth <= el.clientWidth), `${name} has no horizontal overflow in its pane`).toBe(true)
      // TAL-2131: under a finger every symbol button is a 44px target.
      if (info.project.name === 'mobile') {
        const small = await page.locator('#main [data-icon-button]').evaluateAll((buttons) => buttons.filter((b) => b.getClientRects().length > 0)
          .map((b) => ({ label: b.getAttribute('aria-label'), width: b.getBoundingClientRect().width, height: b.getBoundingClientRect().height }))
          .filter((b) => b.width < 44 || b.height < 44))
        expect(small, `${name} icon buttons are 44px touch targets`).toEqual([])
      }
      await check(`settings-${name}`, true, pane)
    }
  } finally { await page.goto('about:blank').catch(() => undefined); await server.close() }
}

for (const { title, pages } of settingsGroups) {
  test(`${title}: each shows its heading without horizontal overflow`, async ({ page }, info) => {
    await settingsPages(page, info, 'dark', pages)
  })

  test(`${title}: each shows its heading in the light theme`, async ({ page }, info) => {
    test.skip(!process.env.TOUR_SHOTS, LIGHT_SHOTS_ONLY)
    await settingsPages(page, info, 'light', pages)
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`feedback form fits the viewport in the ${theme} theme`, async ({ page }, info) => {
    test.skip(theme === 'light' && !process.env.TOUR_SHOTS, LIGHT_SHOTS_ONLY)
    const { server } = await bootDemoServer()
    try {
      if (theme === 'light') await pickLightTheme(page, server.base)
      await page.goto(`${server.base}/settings/about`)
      await page.getByRole('button', { name: 'Send feedback' }).click()
      const dialog = page.getByRole('dialog', { name: 'Send feedback' })
      await dialog.getByRole('textbox', { name: 'Details' }).fill('Please keep completed background work easy to find.')
      const viewports = [{ name: theme === 'light' ? `light-${info.project.name}` : info.project.name, ...page.viewportSize()! },
        ...(theme === 'dark' && info.project.name === 'desktop' ? DUO_VIEWPORTS : [])]
      const shots = process.env.TOUR_SHOTS
      if (shots) mkdirSync(shots, { recursive: true })
      for (const { name, width, height } of viewports) {
        await page.setViewportSize({ width, height })
        const title = dialog.getByRole('textbox', { name: /^Title/ })
        const send = dialog.getByRole('button', { name: 'Send', exact: true })
        await title.scrollIntoViewIfNeeded()
        await expect(title).toBeInViewport({ ratio: 1 })
        expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
        if (shots) await page.screenshot({ path: `${shots}/feedback-${name}.png` })
        await send.scrollIntoViewIfNeeded()
        await expect(send).toBeInViewport({ ratio: 1 })
        if (shots && height < 500) await page.screenshot({ path: `${shots}/feedback-${name}-send.png` })
      }
    } finally { await page.goto('about:blank').catch(() => undefined); await server.close() }
  })
}
