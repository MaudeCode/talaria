import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import { Session } from '../../server/dist/sessions/session.js'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** More questions than one transcript page (120 rows) holds, so the first ones load only on a jump. */
const QUESTIONS = 150

/** A server with one chat of `questions` questions and the outline setting as given; counts outline requests. */
async function outlineServer(page: Page, { questions = QUESTIONS, on = true } = {}) {
  const sidecar = new FakeSidecar()
  sidecar.respond('chat.start', (params) => ({ status: 'completed', failed: false, partial: false, error: null, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
    usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: {},
    model: 'test-model', provider: 'test', compressed: false, agent_session_id: params.session_id, token_sent: true, pending_steer: '', live_tool_calls: [],
    messages: [...params.conversation_history, { role: 'user', content: params.user_message }, { role: 'assistant', content: 'Noted.' }], final_response: 'Noted.' }))
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' } })
  const workspace = join(server.state, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const now = Math.floor(Date.now() / 1000)
  const messages = Array.from({ length: questions }, (_, i) => [
    { role: 'user', content: `**Question ${String(i + 1)}**: what about part ${String(i + 1)}?`, timestamp: now - 10_000 + i * 10 },
    { role: 'assistant', content: `Answer ${String(i + 1)}.\n\n${'A paragraph of the answer. '.repeat(8)}`, timestamp: now - 10_000 + i * 10 + 5 },
  ]).flat()
  const sid = '20261110_090000_outline'
  await server.deps.sessionStore.save(new Session({ session_id: sid, title: 'Long chat', profile: 'default', workspace, messages }, { workspace, model: null }))
  await server.deps.settings.save({ show_conversation_outline: on })
  const reads: string[] = []
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/session/outline') reads.push(request.url()) })
  return { server, sid, reads }
}

/** The message row with this key: focused, and in the transcript's view. */
async function expectJumpedTo(page: Page, key: string) {
  const row = page.locator(`#messages [data-message-key="${key}"]`)
  await expect(row).toBeFocused()
  await expect(row).toBeInViewport()
}

test('the outline lists every question, jumps to loaded and unloaded ones, and follows the reader', async ({ page }, info) => {
  const { server, sid, reads } = await outlineServer(page)
  try {
    await page.goto(`${server.base}/session/${sid}`)
    await settle(page)
    const desktop = info.project.name === 'desktop'
    // Question 1 is not on the first page.
    await expect(page.locator('#messages [data-message-key="0-user"]')).toHaveCount(0)
    if (desktop) {
      const outline = page.getByRole('navigation', { name: 'Conversation outline' })
      await expect(outline).toBeVisible()
      await expect(page.getByRole('button', { name: 'Conversation outline' })).toBeHidden()
      const list = outline.getByRole('list', { name: 'Outline' })
      const entries = list.getByRole('button')
      await expect(entries).toHaveCount(QUESTIONS)
      await expect(entries.first()).toContainText('1Question 1: what about part 1?')
      await expect(entries.first()).toHaveAttribute('title', 'Question 1: what about part 1?')
      // The reader is at the end: the question in view is the last one.
      await expect(list.locator('[aria-current="location"]')).toContainText(`Question ${String(QUESTIONS)}:`)
      await page.screenshot({ path: info.outputPath(`outline-${info.project.name}.png`) })

      // A question that is not loaded: its page loads, then the transcript lands on it and focuses it.
      await entries.first().click()
      await expectJumpedTo(page, '0-user')
      await expect(list.locator('[aria-current="location"]')).toContainText('Question 1:')
      await page.screenshot({ path: info.outputPath(`outline-jumped-${info.project.name}.png`) })

      // Keyboard: the marked entry is the list's tab stop; arrows move between entries and Enter jumps.
      await page.locator('#msg').focus()
      await page.keyboard.press('Shift+Tab')
      for (let i = 0; i < 6 && !(await entries.first().evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Shift+Tab')
      await expect(entries.first()).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      await expect(entries.nth(2)).toBeFocused()
      await page.keyboard.press('Enter')
      await expectJumpedTo(page, '4-user')

      // A loaded question near the end.
      await entries.nth(QUESTIONS - 2).click()
      await expectJumpedTo(page, `${String((QUESTIONS - 2) * 2)}-user`)
    } else {
      await expect(page.getByRole('navigation', { name: 'Conversation outline' })).toBeHidden()
      const button = page.getByRole('button', { name: 'Conversation outline' })
      await expect(button).toBeVisible()
      await button.click()
      const menu = page.getByRole('menu', { name: 'Conversation outline' })
      const entries = menu.getByRole('menuitemradio')
      await expect(entries).toHaveCount(QUESTIONS)
      // The question in view is checked, and the menu opens on it.
      await expect(menu.getByRole('menuitemradio', { checked: true })).toContainText(`Question ${String(QUESTIONS)}:`)
      await expect(menu.getByRole('menuitemradio', { checked: true })).toBeInViewport()
      await page.screenshot({ path: info.outputPath(`outline-${info.project.name}.png`) })
      await entries.first().click()
      await expect(menu).toBeHidden()
      await expectJumpedTo(page, '0-user')
      await page.screenshot({ path: info.outputPath(`outline-jumped-${info.project.name}.png`) })
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow').toBe(true)

    // A sent question joins the outline from the stream at once; when its turn settles, one read replaces it with the
    // server's entry (Markdown stripped).
    expect(reads).toHaveLength(1)
    await page.locator('#msg').fill('One **more** question')
    await page.locator('#btnSend').click()
    await expect(page.locator('#messages').getByText('Noted.').last()).toBeVisible()
    await expect.poll(() => reads.length).toBe(2)
    if (desktop) {
      const entries = page.getByRole('navigation', { name: 'Conversation outline' }).getByRole('button')
      await expect(entries).toHaveCount(QUESTIONS + 1)
      await expect(entries.last()).toHaveAttribute('title', 'One more question')
    } else {
      await page.getByRole('button', { name: 'Conversation outline' }).click()
      const entries = page.getByRole('menu', { name: 'Conversation outline' }).getByRole('menuitemradio')
      await expect(entries).toHaveCount(QUESTIONS + 1)
      await expect(entries.last()).toHaveAttribute('title', 'One more question')
      await page.keyboard.press('Escape')
    }

    // A history cut (here /undo of that question) reads the outline again and drops the question it removed.
    await page.locator('#msg').fill('/undo')
    await page.locator('#btnSend').click()
    await expect(page.locator('#messages').getByText('Noted.')).toHaveCount(0)
    await expect.poll(() => reads.length).toBe(3)
    if (desktop) await expect(page.getByRole('navigation', { name: 'Conversation outline' }).getByRole('button')).toHaveCount(QUESTIONS)
    else {
      await page.getByRole('button', { name: 'Conversation outline' }).click()
      await expect(page.getByRole('menu', { name: 'Conversation outline' }).getByRole('menuitemradio')).toHaveCount(QUESTIONS)
      await page.keyboard.press('Escape')
    }
  } finally { await page.goto('about:blank').catch(() => undefined); await server.close() }
})

test('the outline stays away below four questions, and with the setting off it is never read', async ({ page }) => {
  for (const options of [{ questions: 3, on: true }, { questions: QUESTIONS, on: false }]) {
    const { server, sid, reads } = await outlineServer(page, options)
    try {
      await page.goto(`${server.base}/session/${sid}`)
      await settle(page)
      await expect(page.locator('#messages').getByText(`Answer ${String(options.questions)}.`)).toBeVisible()
      await expect(page.getByRole('navigation', { name: 'Conversation outline' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Conversation outline' })).toHaveCount(0)
      expect(reads).toHaveLength(options.on ? 1 : 0)
    } finally { await page.goto('about:blank').catch(() => undefined); await server.close() }
  }
})
