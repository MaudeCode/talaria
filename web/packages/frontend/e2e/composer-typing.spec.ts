import { createServer, type ServerResponse } from 'node:http'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block', video: 'on' })

/** Draft, menu and clarification interactions use the actual build with synthetic server-owned state. */
test('typing keeps the model picker and clarification answer usable', async ({ page }, testInfo) => {
  const sid = 'composer-typing'
  const streamId = 'composer-typing-run'
  let pending = null as Record<string, unknown> | null
  const answers: unknown[] = []
  let selectedModel = 'alpha'
  await page.route('**/api/session/stream?**', (route) => route.fulfill({ headers: { 'content-type': 'text/event-stream' }, body: ': synthetic session\n\n' }))
  await page.route('**/api/models', (route) => route.fulfill({ json: {
    active_provider: 'test', default_model: 'alpha', default_option_id: 'alpha',
    groups: [{ provider: 'Test', provider_id: 'test', models: ['alpha', 'alpine', 'beta'].map((id) => ({ id, label: id, provider_id: 'test', bare_id: id })) }],
  } }))
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Composer typing', model: selectedModel, model_option_id: selectedModel,
    active_stream_id: streamId, is_streaming: true, messages: [{ role: 'user', id: 1, content: 'Check the draft and controls' }],
  } } }))
  await page.route('**/api/session/update', async (route) => {
    selectedModel = (route.request().postDataJSON() as { model: string }).model
    await route.fulfill({ json: { ok: true } })
  })
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: streamId, replay_available: false } }))
  await page.route('**/api/clarify/pending?**', (route) => route.fulfill({ json: { pending, pending_count: pending ? 1 : 0 } }))
  await page.route('**/api/clarify/respond', async (route) => {
    answers.push(route.request().postDataJSON())
    pending = null
    await route.fulfill({ json: { ok: true } })
  })
  const streams: ServerResponse[] = []
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    response.write(`id: ${streamId}:1\nevent: token\ndata: {"text":"Checking the draft."}\n\n`)
    streams.push(response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
  try {
    await page.goto(`/session/${sid}`)
    const input = page.locator('#msg')
    await input.pressSequentially('Draft kept')
    await expect(input).toHaveValue('Draft kept')
    if (testInfo.project.name === 'mobile') await page.locator('#composerMobileConfigBtn').click()
    const model = testInfo.project.name === 'mobile' ? page.locator('#composerMobileConfigPanel').getByRole('button', { name: 'Model: alpha' }) : page.locator('#composerModelChip')
    await model.click()
    const search = page.getByRole('searchbox', { name: 'Search models…' })
    await search.pressSequentially('alp')
    await expect(search).toHaveValue('alp')
    await expect(page.getByRole('menuitemradio')).toHaveText(['alpha', 'alpine'])
    await page.screenshot({ path: testInfo.outputPath('model-search.png') })
    await page.getByRole('menuitemradio', { name: 'alpine', exact: true }).click()
    await expect.poll(() => selectedModel).toBe('alpine')
    await expect(input).toHaveValue('Draft kept')
    pending = { clarify_id: 'typing-prompt', question: 'Which environment?', steps: [{ qid: 'environment', question: 'Which environment?', choices: ['Staging', 'Test'], multi_select: false }] }
    for (const stream of streams) stream.write(`id: ${streamId}:2\nevent: clarify\ndata: ${JSON.stringify(pending)}\n\n`)
    await expect(page.locator('#clarifyCard')).toBeVisible()
    await expect(input).toHaveValue('')
    await input.pressSequentially('Synthetic environment')
    await page.screenshot({ path: testInfo.outputPath('clarification-answer.png') })
    await page.locator('#btnClarifySend').click()
    await expect(page.locator('#clarifyCard')).toHaveCount(0)
    await expect.poll(() => answers).toEqual([{ session_id: sid, clarify_id: 'typing-prompt', answers: { environment: 'Synthetic environment' } }])
    await expect(input).toHaveValue('Draft kept')
    await page.screenshot({ path: testInfo.outputPath('draft-restored.png') })
  } finally {
    await page.close()
    for (const stream of streams) stream.end()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
})
