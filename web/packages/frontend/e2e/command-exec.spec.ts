import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const output = 'Reloaded skills from disk.\nAdded: 1\nRemoved: 0\nUnchanged: 4\nTotal skills: 5'

test('/reload-skills runs on the server and shows its output above the composer; no chat turn starts (TAL-561)', async ({ page }, testInfo) => {
  const sid = 'cmd-exec'
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Skills', active_stream_id: null, is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true,
    transcript_seq: null, messages: [{ role: 'user', id: 1, content: 'List my skills' }, { role: 'assistant', id: 2, content: 'You have four.' }],
  } } }))
  await page.route('**/api/commands', (route) => route.fulfill({ json: { commands: [
    { name: 'reload-skills', description: 'Re-scan ~/.hermes/skills/', aliases: ['reload_skills'], category: 'Tools & Skills', handler: 'agent', clients: ['web', 'ios'], exec: true },
  ] } }))
  const executed: unknown[] = []
  await page.route('**/api/commands/exec', (route) => { executed.push(route.request().postDataJSON()); return route.fulfill({ json: { output } }) })
  const sent: string[] = []
  await page.route('**/api/chat/{steer,start}', (route) => { sent.push(route.request().url()); return route.fulfill({ status: 500, json: { error: 'not expected' } }) })

  await page.goto(`/session/${sid}`)
  await expect(page.locator('#messages')).toContainText('You have four.')
  await page.locator('#msg').fill('/reload_skills')
  await page.locator('#btnSend').click()
  await expect.poll(() => executed.length + sent.length).toBeGreaterThan(0)
  expect(sent).toEqual([])
  expect(executed).toEqual([{ command: '/reload_skills', session_id: sid }])
  const panel = page.getByRole('region', { name: 'Command output' })
  await expect(panel).toContainText('/reload_skills')
  await expect(panel).toContainText('Total skills: 5')
  await expect(page.locator('#msg')).toHaveValue('')
  await expect(page.locator('#messages')).not.toContainText('reload')
  if (process.env.TAL561_SHOTS) await page.screenshot({ path: `${process.env.TAL561_SHOTS}/command-output-${testInfo.project.name}.png` })

  await page.locator('[data-notice="command"]').getByRole('button', { name: 'Dismiss' }).click()
  await expect(panel).toHaveCount(0)
})

test('a plugin command from a server that sends no exec field still runs on the server; its Markdown output renders (TAL-561)', async ({ page }, testInfo) => {
  await page.route('**/api/commands', (route) => route.fulfill({ json: { commands: [
    { name: 'standup', description: 'Post the standup', aliases: [], category: 'Plugin', handler: 'agent', clients: ['web', 'ios'] },
  ] } }))
  const executed: unknown[] = []
  await page.route('**/api/commands/exec', (route) => { executed.push(route.request().postDataJSON()); return route.fulfill({ json: { output: '**Standup posted**\nChannel: #team' } }) })
  const sent: string[] = []
  await page.route('**/api/chat/{steer,start}', (route) => { sent.push(route.request().url()); return route.fulfill({ status: 500, json: { error: 'not expected' } }) })
  await page.route('**/api/session/new', (route) => { sent.push(route.request().url()); return route.fulfill({ status: 500, json: { error: 'not expected' } }) })

  await page.goto('/')
  await page.locator('#msg').fill('/standup today')
  await page.locator('#btnSend').click()
  await expect.poll(() => executed.length + sent.length).toBeGreaterThan(0)
  expect(sent).toEqual([])
  expect(executed).toEqual([{ command: '/standup today' }])
  const panel = page.getByRole('region', { name: 'Command output' })
  await expect(panel.locator('[data-streamdown="strong"]')).toHaveText('Standup posted')
  await expect(panel).toContainText('Channel: #team')
  await expect(panel).not.toContainText('**')
  if (process.env.TAL561_SHOTS) await page.screenshot({ path: `${process.env.TAL561_SHOTS}/plugin-output-${testInfo.project.name}.png` })
})
