import type { Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'
import ownerFixture from '../../../../contracts/fixtures/gateway-owner.json' with { type: 'json' }

const sid = 'native-owner-reasoning'
const { pinned, deferred } = ownerFixture.reasoning
const shots = process.env.TAL1319_SHOTS
const FOLDABLE = [[382, 618], [594, 406], [669, 902], [951, 620], [385, 609]] as const

function ownerChat(page: Page, attachment: Record<string, unknown> | null) {
  const state = { attachment, writes: [] as Record<string, unknown>[], profileReads: 0, refuse: false, hold: Promise.resolve(), apply: () => undefined as unknown }
  const session = () => ({ session_id: sid, title: 'Back up the cluster', read_only: true, active_stream_id: null, is_streaming: false, model: 'native-model', model_provider: 'custom',
    messages: [{ role: 'user', content: 'Back up the cluster' }, { role: 'assistant', content: 'Inspecting the backup logs.' }],
    owner_attachment: { state: 'attached', reason: null, restarting: false, can_submit: true, can_interrupt: false, can_attach: false, revision: 2, execution_generation: 1, admissions: [], ...state.attachment } })
  return { state, ready: Promise.all([
    page.route('**/api/session?**', (route) => route.fulfill({ json: { session: session() } })),
    page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: false, stream_id: null, replay_available: false } })),
    page.route('**/api/reasoning**', (route) => { state.profileReads += 1; return route.fulfill({ json: {} }) }),
    page.route('**/api/chat/owner-action', async (route) => {
      const input = route.request().postDataJSON() as Record<string, unknown>
      state.writes.push(input)
      await state.hold
      if (state.refuse) return route.fulfill({ status: 409, json: { error: 'The owning Agent refused the action' } })
      state.apply()
      return route.fulfill({ json: { ok: true, session: session() } })
    }),
  ]) }
}

const control = pinned.attachment.reasoning_control
const atLevel = (reasoning_effort: string, revision: number) => ({ reasoning_control: { ...control, reasoning_effort }, revision })

/** Past phone width the chip sits in the footer; at phone width it is a row of the configuration panel, shown while the composer has focus. */
async function openPicker(page: Page) {
  if (await page.getByRole('menuitemradio').first().isVisible()) return
  const chip = page.locator('#composerReasoningChip')
  const config = page.locator('#composerMobileConfigBtn')
  await page.locator('#msg').focus()
  await settle(page) // The composer fits its footer after each layout change, so the chip can move.
  await expect.poll(async () => await chip.isVisible() || await config.isVisible()).toBe(true)
  if (await chip.isVisible()) { await chip.click(); return }
  const row = page.locator('#composerMobileConfigPanel').getByRole('button', { name: /reasoning effort/i })
  if (!await row.isVisible()) await config.click()
  await row.click()
}
const shown = (page: Page, level: string) => page.getByRole('button', { name: `Reasoning effort: ${level}` }).first()

test.use({ video: 'on' })

test('an owner chat shows, sets and resets its own level through its owner', async ({ page }, info) => {
  const chat = ownerChat(page, { reasoning_control: control })
  await chat.ready
  await page.goto(`/session/${sid}`)
  await expect(page.locator('[data-role="user"]')).toHaveText(['Back up the cluster'])
  await openPicker(page)
  await expect(page.getByRole('menuitemradio')).toHaveText(['Default', 'low', 'medium', 'high'])
  await expect(page.getByRole('menuitemradio', { name: 'high' })).toBeChecked()
  if (shots) await page.screenshot({ path: `${shots}/picker-${info.project.name}.png` })

  // The choice shows before the owner answers, and the owner's answer replaces it.
  let answer!: () => void
  chat.state.hold = new Promise<void>((resolve) => { answer = resolve })
  chat.state.apply = () => { chat.state.attachment = atLevel('low', 3) }
  await page.getByRole('menuitemradio', { name: 'low' }).click()
  await expect(shown(page, 'low')).toBeAttached()
  await expect.poll(() => chat.state.writes).toEqual([expect.objectContaining({ session_id: sid, action: 'mutate', operation: 'reasoning', payload: { effort: 'low' }, expected_revision: 2, execution_generation: 1 })])
  if (shots) await page.screenshot({ path: `${shots}/chosen-${info.project.name}.png` })
  answer()
  await expect.poll(() => page.getByRole('menuitemradio', { name: 'low' }).isChecked()).toBe(true)

  // Reset gives the level back to the profile: the owner's answer names what that is.
  chat.state.apply = () => { chat.state.attachment = atLevel('medium', 4) }
  await openPicker(page)
  await page.getByRole('menuitemradio', { name: 'Default' }).click()
  await expect(shown(page, 'medium')).toBeAttached()
  expect(chat.state.writes.at(-1)).toMatchObject({ operation: 'reasoning', payload: { effort: null }, expected_revision: 3 })
  expect(chat.state.writes).toHaveLength(2)
  expect(chat.state.profileReads).toBe(0)
  if (shots) await page.screenshot({ path: `${shots}/reset-${info.project.name}.png` })
})

// The states the unit tests own, kept for the screenshots a UI change attaches to its PR.
test.describe('evidence', () => {
  test.skip(!shots, 'runs for TAL1319_SHOTS')

  test('a level held for the turn keeps the actual level and says so', async ({ page }, info) => {
    const chat = ownerChat(page, { reasoning_control: deferred.attachment.reasoning_control })
    await chat.ready
    await page.goto(`/session/${sid}`)
    await expect(page.getByText('Applies after this turn').first()).toBeVisible()
    if (shots) await page.screenshot({ path: `${shots}/deferred-${info.project.name}.png` })
    await openPicker(page)
    await expect(page.getByRole('menuitemradio', { name: 'high' })).toBeChecked()
  })

  test('a refused pick rolls back to the actual level with the refusal', async ({ page, errors }, info) => {
    const chat = ownerChat(page, { reasoning_control: control })
    await chat.ready
    chat.state.refuse = true
    await page.goto(`/session/${sid}`)
    await openPicker(page)
    await page.getByRole('menuitemradio', { name: 'low' }).click()
    await expect(page.getByText('The owning Agent refused the action')).toBeVisible()
    await expect(page.getByRole('menuitemradio', { name: 'high' })).toBeChecked()
    expect(chat.state.writes).toHaveLength(1)
    if (shots) await page.screenshot({ path: `${shots}/refused-${info.project.name}.png` })
    errors.splice(0, errors.length, ...errors.filter((e) => !/api\/chat\/owner-action|status of 409/.test(e)))
  })

  test('an owner without a level offers no picker', async ({ page }, info) => {
    const chat = ownerChat(page, null)
    await chat.ready
    await page.goto(`/session/${sid}`)
    await expect(page.locator('[data-role="user"]')).toHaveText(['Back up the cluster'])
    await page.locator('#msg').focus()
    await expect(page.getByRole('button', { name: /reasoning effort/i })).toHaveCount(0)
    expect(chat.state.profileReads).toBe(0)
    if (shots) await page.screenshot({ path: `${shots}/unsupported-${info.project.name}.png` })
  })

  test('the picker fits every foldable viewport', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'one browser covers the viewport list')
    const chat = ownerChat(page, { reasoning_control: control })
    await chat.ready
    for (const [width, height] of FOLDABLE) {
      await page.setViewportSize({ width, height })
      await page.goto(`/session/${sid}`)
      await expect(page.locator('[data-role="user"]')).toHaveText(['Back up the cluster'])
      await openPicker(page)
      await expect(page.getByRole('menuitemradio', { name: 'Default' })).toBeVisible()
      await page.screenshot({ path: `${shots}/foldable-${width}x${height}.png` })
      for (const option of await page.getByRole('menuitemradio').all()) {
        const box = await option.boundingBox()
        expect(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height, `${width}x${height}: ${JSON.stringify(box)}`).toBe(true)
      }
    }
  })
})
