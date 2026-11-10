import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** TAL-2155: "Start a new chat when switching workspace" leaves a chat with messages where it is and opens a new one. */

const shot = async (page: Page, name: string, project: string) => { if (process.env.TAL2155_SHOTS) await page.screenshot({ path: `${process.env.TAL2155_SHOTS}/${name}-${project}.png` }) }

test('with the setting on, a workspace switch starts a new chat there and carries the draft', async ({ page }, info) => {
  const suffix = info.project.name
  const home = ((await (await page.request.get('/api/workspaces')).json()) as { workspaces: { path: string; name: string }[] }).workspaces[0]!
  const other = { path: `${home.path}/switch-${suffix}`, name: `Switch ${suffix}` }
  const third = { path: `${home.path}/switch-cmd-${suffix}`, name: `Command ${suffix}` }
  for (const w of [other, third]) expect((await page.request.post('/api/workspaces/add', { data: { ...w, create: true } })).ok()).toBe(true)
  const imported = await page.request.post('/api/session/import', { data: { title: `Switch source ${suffix}`, workspace: home.path, messages: [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }] } })
  expect(imported.ok()).toBe(true)
  const sid = ((await imported.json()) as { session: { session_id: string } }).session.session_id
  const workspaceOf = async (id: string) => ((await (await page.request.get(`/api/session?session_id=${id}`)).json()) as { session: { workspace: string; message_count: number } }).session
  expect((await page.request.post('/api/settings', { data: { new_chat_on_workspace_switch: true } })).ok()).toBe(true)
  try {
    await page.goto(`/session/${sid}`)
    await expect(page.locator('#messages').getByText('Earlier answer')).toBeVisible()
    const msg = page.locator('#msg')
    const chip = page.locator('#composerWorkspaceChip')
    const tray = page.locator('#composerBox .attach-tray li')
    await msg.click()
    await msg.fill('carry this draft')
    await page.locator('#fileInput').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') })
    await expect(page.locator('.attach-tray [data-status=done]')).toHaveCount(1)
    await shot(page, 'before', suffix)
    await chip.click()
    await page.getByRole('menuitemradio', { name: new RegExp(other.name) }).click()
    await expect(page).not.toHaveURL(new RegExp(sid))
    await page.keyboard.press('Escape')
    const created = page.url().split('/session/')[1]!
    await expect(msg).toHaveValue('carry this draft')
    // Staged files move too, uploaded again for the new chat.
    await expect(tray).toHaveText(/notes\.txt/)
    await expect(page.locator('.attach-tray [data-status=done]')).toHaveCount(1)
    await msg.click()
    await expect(chip).toContainText(other.name)
    await expect(page.locator('#messages').getByText('Earlier answer')).toHaveCount(0)
    await shot(page, 'after', suffix)
    expect(await workspaceOf(created)).toMatchObject({ workspace: expect.stringContaining(`switch-${suffix}`), message_count: 0 })
    expect((await workspaceOf(sid)).workspace).toBe(home.path)

    // The original chat kept its workspace, and its draft moved with the user.
    await page.goto(`/session/${sid}`)
    await expect(page.locator('#messages').getByText('Earlier answer')).toBeVisible()
    // A phone shows the chips once the composer has focus.
    await msg.click()
    await expect(chip).toContainText(home.name)
    await expect(msg).toHaveValue('')
    await expect(tray).toHaveCount(0)
    await shot(page, 'original', suffix)

    // `/workspace` goes through the same change as the chip, and text typed while it is decided moves too.
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    await page.route('**/api/session/update', async (route) => { await held; await route.continue() })
    await msg.fill(`/workspace ${third.path}`)
    await page.locator('#btnSend').click()
    await expect(msg).toHaveValue('')
    await msg.fill('typed while switching')
    release()
    await expect(page).not.toHaveURL(new RegExp(sid))
    await expect(msg).toHaveValue('typed while switching')
    await msg.click()
    await expect(chip).toContainText(third.name)
    expect((await workspaceOf(sid)).workspace).toBe(home.path)
  } finally {
    await page.request.post('/api/settings', { data: { new_chat_on_workspace_switch: false } })
  }
})
