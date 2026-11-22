import { mkdirSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import { Session } from '../../server/dist/sessions/session.js'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const TASKS = 12

/** The row of this message key: its top in the transcript pane, which a tray change must not move. */
const rowTop = (page: Page, key: string) => page.evaluate((k) => {
  const pane = document.querySelector('#messages')!
  return document.querySelector(`#messages [data-message-key="${k}"]`)!.getBoundingClientRect().top - pane.getBoundingClientRect().top
}, key)

// TAL-1122: the opt-in task list strip at the top of the chat, from the server's todo_state.
test('the chat task list strip stays off until enabled, opens by keyboard, caps its height and keeps the transcript in place', async ({ page }, info) => {
  const server = await bootTestServer({ sidecar: new FakeSidecar(), env: { TALARIA_WEB_SKIP_ONBOARDING: '1' } })
  try {
    const workspace = server.workspace
    mkdirSync(workspace, { recursive: true })
    const now = Math.floor(Date.now() / 1000)
    const todos = Array.from({ length: TASKS }, (_, i) => ({ id: `t${String(i)}`, content: `Task ${String(i + 1)}`, status: i === 0 ? 'completed' : i === 1 ? 'in_progress' : 'pending' }))
    const messages = [
      ...Array.from({ length: 30 }, (_, i) => [
        { role: 'user', content: `Question ${String(i + 1)}`, timestamp: now - 10_000 + i * 10 },
        { role: 'assistant', content: `Answer ${String(i + 1)}. ${'A paragraph of the answer. '.repeat(6)}`, timestamp: now - 10_000 + i * 10 + 5 },
      ]).flat(),
      { role: 'tool', content: JSON.stringify({ todos }), timestamp: now - 100 },
      { role: 'assistant', content: 'Last answer.', timestamp: now - 99 },
    ]
    const sid = '20261121_090000_tasks'
    await server.deps.sessionStore.save(new Session({ session_id: sid, title: 'Planned chat', profile: 'default', workspace, messages }, { workspace, model: null }))
    // The outline column narrows the reading column on desktop; the strip lines up with it.
    await server.deps.settings.save({ show_conversation_outline: true })

    // Off by default: no strip.
    await page.goto(`${server.base}/session/${sid}`)
    await settle(page)
    const chat = page.locator('#mainChat')
    await expect(chat.getByText('Last answer.')).toBeInViewport()
    await expect(chat.getByRole('button', { name: /^Todos/ })).toHaveCount(0)
    await page.screenshot({ path: info.outputPath(`off-${info.project.name}.png`) })

    // Settings › Chat turns it on, and the saved choice reads back.
    await page.goto(`${server.base}/settings/chat`)
    const toggle = page.getByRole('switch', { name: 'Task list in chat' })
    await expect(toggle).not.toBeChecked()
    await toggle.click()
    await expect(toggle).toBeChecked()
    await expect.poll(async () => (await server.deps.settings.load()).chat_task_list).toBe(true)
    await page.reload()
    await expect(page.getByRole('switch', { name: 'Task list in chat' })).toBeChecked()
    await page.screenshot({ path: info.outputPath(`settings-${info.project.name}.png`) })

    await page.goto(`${server.base}/session/${sid}`)
    await settle(page)
    const header = chat.getByRole('button', { name: 'Todos 1 of 12 done' })
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    expect((await header.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await expect(chat.getByText('Last answer.')).toBeInViewport()
    await page.screenshot({ path: info.outputPath(`collapsed-${info.project.name}.png`) })

    // Opened from the keyboard at the end of the transcript: the end stays in view, the rows are the server's, in its
    // order, and only the task body scrolls within half the chat's free height.
    await header.focus()
    await page.keyboard.press('Enter')
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    const rows = chat.getByRole('list', { name: 'Current task list' }).getByRole('listitem')
    await expect(rows).toHaveCount(TASKS)
    await expect(rows.first()).toContainText('Task 1')
    await expect(rows.nth(1)).toContainText('Working')
    await expect(rows.last()).toContainText(`Task ${String(TASKS)}`)
    await expect(chat.getByText('Last answer.')).toBeInViewport()
    const geometry = await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>('.chat-stage')!
      const dock = document.querySelector<HTMLElement>('.composer-dock')!
      const tray = document.querySelector<HTMLElement>('.chat-task-list')!
      const body = tray.querySelector<HTMLElement>('[data-task-list-body]')!
      return { tray: tray.offsetHeight, free: stage.offsetHeight - dock.offsetHeight, scrolls: body.scrollHeight > body.clientHeight, focusable: body.tabIndex === 0 }
    })
    expect(geometry.tray).toBeLessThanOrEqual(Math.ceil(geometry.free / 2))
    expect(geometry).toMatchObject({ scrolls: true, focusable: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow').toBe(true)
    await page.screenshot({ path: info.outputPath(`expanded-${info.project.name}.png`) })

    // A reader up the transcript keeps their place while the strip closes.
    await chat.locator('[data-message-key="20-user"]').scrollIntoViewIfNeeded()
    await page.locator('#messages').evaluate((el) => { el.scrollBy(0, -40) })
    const before = await rowTop(page, '20-user')
    await header.click()
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    // Within a CSS pixel: a phone's fractional device pixels round the restored scroll; the strip itself is 44px or more.
    await expect.poll(async () => Math.abs(await rowTop(page, '20-user') - before)).toBeLessThanOrEqual(1)
  } finally {
    await page.goto('about:blank')
    await server.close()
  }
})
