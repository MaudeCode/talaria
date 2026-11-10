import type { Page } from '@playwright/test'
import { expect, showTitlebarProfile, test } from './fixtures'

/** A sidebar row as `/api/sessions` lists it. */
const row = (sessionId: string, title: string) => ({ session_id: sessionId, title, is_streaming: false, read_only: false, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true, can_branch: true, source_kind: 'webui', is_messaging_session: false, sort_ts: 1, sidebar_group: 'recent' })

/**
 * TAL-2099: two profiles whose chat list, settings and model catalog differ. `/api/profile/switch` moves the active one,
 * and the page records every document load and keeps a marker on `window` that only a reload would drop.
 */
async function twoProfiles(page: Page) {
  const state = { active: 'default' }
  const listed = () => ({ active: state.active, profiles: [
    { name: 'default', is_default: true, canonical_session: null },
    { name: 'research', canonical_session: { session_id: 'research-root', tip_session_id: 'research-bot' } },
  ] })
  await page.route('**/api/profiles', (route) => route.fulfill({ json: listed() }))
  await page.route('**/api/profile/switch', async (route) => {
    state.active = (route.request().postDataJSON() as { name: string }).name
    await route.fulfill({ json: { ...listed(), is_default: state.active === 'default', default_model: null, default_model_provider: null, default_workspace: null } })
  })
  const sessions = await (await page.request.get('/api/sessions')).json()
  await page.route(/\/api\/sessions(\?|$)/, (route) => route.fulfill({ json: { ...sessions, sessions: [row(`${state.active}-chat`, `The ${state.active} profile's chat`)], sidebar_groups: [{ kind: 'recent', title: 'Recent' }] } }))
  await page.route('**/api/session?**', (route) => {
    const sid = new URL(route.request().url()).searchParams.get('session_id') ?? ''
    return route.fulfill({ json: { session: { ...row(sid, `Chat ${sid}`), active_stream_id: null, transcript_seq: null, messages: [{ role: 'user', id: 1, content: `Hello from ${sid}` }] } } })
  })
  // Each read after the switch belongs to the new profile.
  const reads: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (['/api/sessions', '/api/settings', '/api/models', '/api/bootstrap'].includes(path) && request.method() === 'GET') reads.push(`${state.active} ${path}`)
  })
  let loads = 0
  page.on('load', () => { loads += 1 })
  return {
    /** Arms the marker after the first paint; the switch must leave it, the reads and zero further loads. */
    arm: async () => {
      await page.evaluate(() => { (window as { tal2099?: boolean }).tal2099 = true })
      loads = 0
      reads.length = 0
    },
    /** A page that shows no chat list or model reads those only once it shows them again. */
    expectInPlace: async (profile: string, paths = ['/api/bootstrap', '/api/sessions', '/api/settings', '/api/models']) => {
      await expect.poll(() => paths.filter((path) => !reads.includes(`${profile} ${path}`))).toEqual([])
      expect(await page.evaluate(() => (window as { tal2099?: boolean }).tal2099)).toBe(true)
      expect(loads).toBe(0)
    },
  }
}

async function openSidebar(page: Page) {
  if (await page.locator('#btnHamburger').isVisible()) await page.locator('#btnHamburger').click()
}

test('switching from the composer strip keeps a new chat and its draft, and shows the new profile at once', async ({ page }, info) => {
  const profiles = await twoProfiles(page)
  await page.goto('/')
  const msg = page.locator('#msg')
  await msg.fill('A thought to finish later')
  await profiles.arm()
  await msg.click()
  await page.locator('.composer-strip').getByRole('button', { name: /default/ }).click()
  await page.getByRole('menuitemradio', { name: /research/ }).click()
  await expect(page.getByText('Switched to profile: research')).toBeVisible()
  await profiles.expectInPlace('research')
  await expect(page).toHaveURL((url) => url.pathname === '/')
  await expect(msg).toHaveValue('A thought to finish later')
  await openSidebar(page)
  await expect(page.getByText("The research profile's chat")).toBeVisible()
  await expect(page.getByText("The default profile's chat")).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('composer-switch.png') })
})

test('switching from an open chat leaves the previous profile\'s chat for a new one', async ({ page }) => {
  const profiles = await twoProfiles(page)
  await page.goto('/session/default-chat')
  await expect(page.getByText('Hello from default-chat')).toBeVisible()
  await profiles.arm()
  await page.locator('#msg').click()
  await page.locator('.composer-strip').getByRole('button', { name: /default/ }).click()
  await page.getByRole('menuitemradio', { name: /research/ }).click()
  await expect(page).toHaveURL((url) => url.pathname === '/')
  await profiles.expectInPlace('research')
  await expect(page.getByText('Hello from default-chat')).toHaveCount(0)
})

test('switching from the titlebar menu happens in place', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'The titlebar shows at phone width.')
  await showTitlebarProfile(page)
  const profiles = await twoProfiles(page)
  await page.goto('/')
  await profiles.arm()
  await page.locator('.app-titlebar-left').getByRole('button', { name: /default/ }).click()
  await page.getByRole('menuitemradio', { name: /research/ }).click()
  await profiles.expectInPlace('research')
  await expect(page.locator('.app-titlebar-left').getByRole('button', { name: /research/ })).toBeVisible()
  await page.screenshot({ path: info.outputPath('titlebar-switch.png') })
})

test('Use and Open Bot Chat on the Profiles page switch in place, and the Bot Chat opens through the router', async ({ page }, info) => {
  const profiles = await twoProfiles(page)
  await page.goto('/settings/profiles')
  const research = page.locator('[data-profile="research"]')
  await expect(research).toBeVisible()
  await profiles.arm()
  const rowAction = async (name: string) => {
    await research.getByRole('button', { name: 'Profile actions' }).click()
    await page.getByRole('menu', { name: 'Profile actions' }).getByRole('menuitem', { name }).click()
  }
  await rowAction('Use')
  await profiles.expectInPlace('research', ['/api/bootstrap', '/api/settings'])
  await expect(research.getByText('ACTIVE')).toBeVisible()
  await page.screenshot({ path: info.outputPath('profiles-use.png') })
  await rowAction('Open Bot Chat')
  await expect(page).toHaveURL((url) => url.pathname === '/session/research-bot')
  await expect(page.getByText('Hello from research-bot')).toBeVisible()
  await profiles.expectInPlace('research')
})

test('a refused switch shows the error and keeps the previous profile', async ({ page, errors }) => {
  const profiles = await twoProfiles(page)
  await page.route('**/api/profile/switch', (route) => route.fulfill({ status: 409, json: { error: 'A run is still going in this profile' } }))
  await page.goto('/')
  await profiles.arm()
  await page.locator('#msg').click()
  await page.locator('.composer-strip').getByRole('button', { name: /default/ }).click()
  await page.getByRole('menuitemradio', { name: /research/ }).click()
  await expect(page.getByText('A run is still going in this profile')).toBeVisible()
  await expect(page.locator('.composer-strip').getByRole('button', { name: /default/ })).toBeVisible()
  await openSidebar(page)
  await expect(page.getByText("The default profile's chat")).toBeVisible()
  expect(await page.evaluate(() => (window as { tal2099?: boolean }).tal2099)).toBe(true)
  // The refusal is the point of this test.
  errors.splice(0, errors.length, ...errors.filter((e) => !/api\/profile\/switch|status of 409/.test(e)))
})
