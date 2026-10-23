import { expect, test } from './fixtures'
import ownerFixture from '../../../../contracts/fixtures/gateway-owner.json' with { type: 'json' }

test.use({ video: 'on' })

test('an owner-consumed voice stop clears its optimistic row without a new stream', async ({ page }, info) => {
  const response = ownerFixture.voice_stop_response
  const calls: Record<string, unknown>[] = []
  let confirm!: () => void
  const confirmed = new Promise<void>((resolve) => { confirm = resolve })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: response.session } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: false, stream_id: null, replay_available: false } }))
  await page.route('**/api/chat/start', async (route) => {
    calls.push(route.request().postDataJSON() as Record<string, unknown>)
    await confirmed
    await route.fulfill({ json: response })
  })
  await page.goto(`/session/${response.session_id}`)
  await page.locator('#msg').fill('stop')
  await page.locator('#btnSend').click()
  const pending = page.locator('[data-live-user="1"]')
  await expect(pending).toContainText('stop')
  if (process.env.TAL1311_SHOTS) await page.screenshot({ path: `${process.env.TAL1311_SHOTS}/before-${info.project.name}.png` })
  confirm()
  await expect(pending).toHaveCount(0)
  await expect(page.locator('[data-role="user"]')).toHaveText(['Started in the CLI'])
  await expect(page.locator('#msg')).toHaveValue('')
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ message: 'stop', submission_id: expect.any(String) })
  if (process.env.TAL1311_SHOTS) await page.screenshot({ path: `${process.env.TAL1311_SHOTS}/after-${info.project.name}.png` })
})

/** The built chat renders the server's native-owner projection, never a second local queue. */
test('native queued prompts use owner controls and confirmed snapshots', async ({ page }, info) => {
  const sid = 'native-queued-controls'
  const calls: Record<string, unknown>[] = []
  const waitForCalls = (count: number) => expect.poll(() => calls.length).toBe(count)
  let allowOwner!: () => void
  const ownerProcessing = new Promise<void>((resolve) => { allowOwner = resolve })
  const queued = (id: string, text: string, actions: string[]) => ({ admission_id: id, sequence: 1, status: 'queued', outcome: null, authority_epoch: 1, execution_generation: null, text, actions })
  let admissions = [queued('editable', 'Check the backup logs too', ['cancel', 'steer', 'edit']), queued('legacy', 'Summarize the backup', ['cancel'])]
  const session = () => ({ session_id: sid, title: 'Back up the cluster', read_only: true, active_stream_id: null, is_streaming: false,
    messages: [{ role: 'user', content: 'Back up the cluster' }, { role: 'assistant', content: 'Inspecting the backup logs.' }],
    owner_attachment: { state: 'attached', reason: null, can_submit: true, can_interrupt: false, can_attach: false, revision: 2, execution_generation: 1, admissions } })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: session() } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: false, stream_id: null, replay_available: false } }))
  await page.route('**/api/chat/owner-action', async (route) => {
    await ownerProcessing
    const input = route.request().postDataJSON() as Record<string, unknown>
    calls.push(input)
    if (input.action === 'replace_queued') admissions = admissions.map((row) => row.admission_id === input.admission_id ? { ...row, text: String(input.text) } : row)
    else admissions = admissions.filter((row) => row.admission_id !== input.admission_id)
    return route.fulfill({ json: { ok: true, session: session() } })
  })
  await page.goto(`/session/${sid}`)
  await page.locator('[data-notice="queue"]').getByRole('button').click()
  const dialog = page.getByRole('dialog', { name: 'Agent inputs' })
  await expect(dialog).toContainText('Check the backup logs too')
  if (process.env.TAL1270_SHOTS) await page.screenshot({ path: `${process.env.TAL1270_SHOTS}/queue-${info.project.name}.png` })
  const legacy = dialog.locator('li', { hasText: 'Summarize the backup' })
  await expect(legacy.getByRole('button', { name: 'Edit queued message' })).toHaveCount(0)
  await expect(legacy.getByRole('button', { name: 'Steer current response' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Edit queued message' }).click()
  await dialog.getByRole('textbox', { name: 'Edit queued message' }).fill('Check the restored backup')
  if (process.env.TAL1270_SHOTS) {
    await page.screenshot({ path: `${process.env.TAL1270_SHOTS}/editing-${info.project.name}.png` })
    await page.waitForTimeout(250) // Retain the editing state in the interaction recording.
  }
  await dialog.getByRole('textbox').press('Enter')
  await expect(dialog).toContainText('Check the restored backup')
  // Optimistic text must be visible before the simulated owner processes the edit.
  expect(calls).toEqual([])
  allowOwner()
  await waitForCalls(1)
  expect(calls[0]).toMatchObject({ session_id: sid, action: 'replace_queued', admission_id: 'editable', text: 'Check the restored backup', submission_id: expect.any(String) })
  if (process.env.TAL1270_SHOTS) await page.screenshot({ path: `${process.env.TAL1270_SHOTS}/edited-${info.project.name}.png` })
  await dialog.getByRole('button', { name: 'Steer current response' }).click()
  await expect(dialog.locator('li')).toHaveCount(1)
  await waitForCalls(2)
  expect(calls[1]).toEqual({ session_id: sid, action: 'steer_queued', admission_id: 'editable' })
  if (process.env.TAL1270_SHOTS) {
    await page.screenshot({ path: `${process.env.TAL1270_SHOTS}/steered-${info.project.name}.png` })
    await page.waitForTimeout(250) // Retain the confirmed steering result before the recorder closes.
    const video = page.video()
    await page.close()
    await video?.saveAs(`${process.env.TAL1270_SHOTS}/interaction-${info.project.name}.webm`)
  }
})
