import { createServer, type ServerResponse } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { expect, test } from './fixtures'
import { deferred, sessionFixture } from '../src/test/fixtures'
import type { Message } from '../src/contracts'

test.use({ serviceWorkers: 'block' })
const sid = 'immediate-intent'
const initial: Message[] = [{ role: 'user', id: 1, content: 'Earlier question' }, { role: 'assistant', id: 2, content: 'Earlier answer' }]
const snapshot = (messages = initial) => sessionFixture({ session_id: sid, title: 'Immediate feedback', messages, model: 'fixture-model' })
const hold = () => { const pending = deferred<undefined>(); return { promise: pending.promise, resolve: () => pending.resolve(undefined) } }
const before = process.env.TALARIA_INTENT_BASELINE === '1'

async function evidence(page: import('@playwright/test').Page, name: string, project: string) {
  if (!process.env.TALARIA_INTENT_EVIDENCE) return
  await mkdir(process.env.TALARIA_INTENT_EVIDENCE, { recursive: true })
  await page.screenshot({ path: `${process.env.TALARIA_INTENT_EVIDENCE}/${before ? 'before' : 'after'}-${name}-${project}.png` })
}

test('existing and identical sends show one pending occurrence before admission', async ({ page }, info) => {
  let messages = initial
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: snapshot(messages) } }))
  const start = hold()
  let requests = 0
  await page.route('**/api/chat/start', async (route) => {
    requests++
    await start.promise
    messages = [...messages, { role: 'user', id: 3, content: 'Earlier question' }]
    await route.fulfill({ json: { status: 'suppressed' } })
  })
  await page.goto(`/session/${sid}`)
  await expect(page.getByText('Earlier answer', { exact: true })).toBeVisible()
  await page.locator('#msg').fill('Earlier question')
  await page.locator('#btnSend').click()
  await expect.poll(() => requests).toBe(1)
  if (before) {
    await expect(page.locator('#msg')).toHaveValue('Earlier question')
    await evidence(page, 'send', info.project.name)
    start.resolve()
    return
  }
  await expect(page.locator('#msg')).toHaveValue('')
  await expect(page.locator('[data-live-user]')).toHaveCount(1)
  await expect(page.locator('#messages').getByText('Earlier question', { exact: true })).toHaveCount(2)
  await page.locator('#msg').fill('New draft survives')
  await page.locator('#msg').press('Control+Enter')
  expect(requests).toBe(1)
  await evidence(page, 'send', info.project.name)
  start.resolve()
  await expect(page.locator('[data-live-user]')).toHaveCount(0)
  await expect(page.locator('#messages').getByText('Earlier question', { exact: true })).toHaveCount(2)
  await expect(page.locator('#msg')).toHaveValue('New draft survives')
})

test('interrupt queues immediately and waits for confirmed worker release', async ({ page }, info) => {
  let stream: ServerResponse | undefined
  const server = createServer((_req, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    response.write('event: token\ndata: {"text":"Inspecting the request."}\n\n')
    stream = response
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture listener missing')
  let running = true
  let blocked = true
  let polls = 0
  let starts = 0
  const cancel = hold()
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { ...snapshot(), ...(running ? { active_stream_id: 'intent-run', is_streaming: true } : {}) } } }))
  await page.route('**/api/chat/stream/status?**', (route) => { polls++; return route.fulfill({ json: { active: running, stream_id: 'intent-run', blocking_stream_id: blocked ? 'intent-run' : null, replay_available: false } }) })
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${address.port}` }))
  await page.route('**/api/chat/cancel', async (route) => { await cancel.promise; await route.fulfill({ json: { ok: true, cancelled: true } }) })
  await page.route('**/api/chat/start', async (route) => { starts++; await route.fulfill({ json: { status: 'suppressed' } }) })
  try {
    await page.goto(`/session/${sid}`)
    await expect(page.locator('#btnStop')).toBeVisible()
    await page.locator('#msg').fill('/interrupt Replace the running request')
    await page.locator('#btnSend').click()
    if (before) {
      await expect(page.locator('#msg')).toHaveValue('/interrupt Replace the running request')
      await evidence(page, 'stop', info.project.name)
      cancel.resolve()
      return
    }
    await expect(page.locator('.queue-card')).toContainText('Replace the running request')
    await expect(page.locator('#msg')).toHaveValue('')
    await expect(page.locator('#btnStop')).toHaveAccessibleName('Stopping')
    await expect(page.locator('#btnStop')).toBeDisabled()
    await evidence(page, 'stop', info.project.name)
    running = false
    stream!.write(`event: cancel\ndata: ${JSON.stringify({ session: snapshot(), terminal_state: 'interrupted' })}\n\n`)
    const previous = polls
    cancel.resolve()
    await expect.poll(() => polls).toBeGreaterThan(previous)
    expect(starts).toBe(0)
    await expect(page.locator('#btnStop')).toBeDisabled()
    blocked = false
    await expect.poll(() => starts).toBe(1)
    await expect(page.locator('.queue-card')).toHaveCount(0)
  } finally {
    cancel.resolve()
    stream?.end()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('Edit exposes intent before an accepted authoritative cut', async ({ page }, info) => {
  let messages = initial
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: snapshot(messages) } }))
  const edit = hold()
  await page.route('**/api/session/truncate', async (route) => {
    await edit.promise
    messages = []
    await route.fulfill({ json: { ok: true, session: snapshot(messages) } })
  })
  await page.goto(`/session/${sid}`)
  await page.getByRole('button', { name: 'Edit message', exact: true }).click()
  if (before) {
    await expect(page.locator('#msg')).toHaveValue('')
    await evidence(page, 'edit', info.project.name)
    edit.resolve()
    return
  }
  await expect(page.locator('[data-notice="history"]')).toHaveText('Editing')
  await expect(page.getByText('Earlier answer', { exact: true })).toBeVisible()
  await evidence(page, 'edit', info.project.name)
  edit.resolve()
  await expect(page.locator('#msg')).toHaveValue('Earlier question')
  await expect(page.getByText('Earlier answer', { exact: true })).toHaveCount(0)
})

test('Retry exposes intent through mutation, detail refresh and admission', async ({ page }) => {
  test.skip(before, 'Before evidence is covered by the existing Edit scenario')
  let messages = initial
  let holdRefresh = false
  const refresh = hold()
  await page.route('**/api/session?**', async (route) => { if (holdRefresh) await refresh.promise; await route.fulfill({ json: { session: snapshot(messages) } }) })
  await page.goto(`/session/${sid}`)
  await expect(page.getByText('Earlier answer', { exact: true })).toBeVisible()
  const retry = hold()
  holdRefresh = true
  await page.route('**/api/session/retry', async (route) => {
    await retry.promise
    messages = []
    await route.fulfill({ json: { ok: true, last_user_text: 'server-decorated text', last_user_prompt: 'Exact prompt', last_user_attachments: [{ path: '/synthetic/notes.txt', filename: 'notes.txt' }], removed_count: 2 } })
  })
  const admission = hold()
  const starts: Record<string, unknown>[] = []
  await page.route('**/api/chat/start', async (route) => { starts.push(route.request().postDataJSON()); await admission.promise; await route.fulfill({ json: { status: 'suppressed' } }) })
  await page.getByRole('button', { name: 'Regenerate response' }).click()
  await expect(page.locator('[data-notice="history"]')).toHaveText('Retrying')
  retry.resolve()
  await expect(page.locator('[data-notice="history"]')).toHaveText('Retrying')
  expect(starts).toHaveLength(0)
  refresh.resolve()
  await expect.poll(() => starts.length).toBe(1)
  await expect(page.locator('[data-live-user]')).toContainText('Exact prompt')
  expect(starts[0]).toMatchObject({ message: 'Exact prompt', attachments: [{ path: '/synthetic/notes.txt', filename: 'notes.txt' }] })
  await expect(page.locator('[data-notice="history"]')).toHaveText('Retrying')
  admission.resolve()
  await expect(page.locator('[data-notice="history"]')).toHaveCount(0)
})

for (const action of ['undo', 'clear'] as const) {
  test(`${action} reports intent throughout the write and authoritative refresh`, async ({ page }) => {
    test.skip(before, 'Before evidence is covered by Edit')
    let messages = initial
    let holdRefresh = false
    const refresh = hold()
    const mutation = hold()
    await page.route('**/api/session?**', async (route) => { if (holdRefresh) await refresh.promise; await route.fulfill({ json: { session: snapshot(messages) } }) })
    await page.route(`**/api/session/${action}`, async (route) => {
      await mutation.promise
      messages = []
      holdRefresh = true
      await route.fulfill({ json: action === 'undo' ? { ok: true, removed_count: 2, removed_preview: 'Earlier question' } : { ok: true, session: { ...snapshot(), messages: undefined } } })
    })
    await page.goto(`/session/${sid}`)
    await expect(page.getByText('Earlier answer', { exact: true })).toBeVisible()
    await page.locator('#msg').fill(`/${action}`)
    await page.locator('#btnSend').click()
    const status = page.locator('[data-notice="history"]')
    await expect(status).toHaveText(action === 'undo' ? 'Undoing' : 'Clearing')
    await expect(page.getByText('Earlier answer', { exact: true })).toBeVisible()
    await page.locator('#msg').fill('Newer typing')
    mutation.resolve()
    await expect(status).toBeVisible()
    await expect(page.getByText('Earlier answer', { exact: true })).toBeVisible()
    refresh.resolve()
    await expect(page.getByText('Earlier answer', { exact: true })).toHaveCount(0)
    await expect(status).toHaveCount(0)
    await expect(page.locator('#msg')).toHaveValue('Newer typing')
  })
}

test('a refused queued send waits for an explicit retry instead of draining repeatedly', async ({ page }) => {
  test.skip(before, 'Regression validation only')
  await page.addInitScript(({ id }) => localStorage.setItem(`hermes-queue:${id}`, JSON.stringify([{ id: 'queued-once', text: 'Queued prompt', attachments: [], request: { profile: 'default' } }])), { id: sid })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: snapshot() } }))
  let requests = 0
  await page.route('**/api/chat/start', async (route) => { requests++; await route.fulfill({ json: requests === 1 ? { ok: false, reason: 'Admission refused' } : { status: 'suppressed' } }) })
  await page.goto(`/session/${sid}`)
  await expect(page.locator('[data-notice="queue-failed"]')).toContainText('Queued message was not sent')
  await expect(page.locator('.queue-card')).toContainText('Queued prompt')
  expect(requests).toBe(1)
  await page.locator('[data-notice="queue-failed"]').getByRole('button', { name: 'Retry' }).click()
  await expect(page.locator('.queue-card')).toHaveCount(0)
  expect(requests).toBe(2)
})
