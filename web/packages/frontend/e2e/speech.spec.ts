import { createServer, type ServerResponse } from 'node:http'
import type { Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** TAL-568: Settings > Speech turns on read-aloud and auto-read; speech runs through a recording stand-in for speechSynthesis. */

async function recordSpeech(page: Page) {
  await page.addInitScript(() => {
    const spoken: string[] = []
    Object.assign(window, { spoken })
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      speak: (u: SpeechSynthesisUtterance) => { spoken.push(u.text) },
      cancel: () => undefined,
      getVoices: () => [],
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } })
  })
  return () => page.evaluate(() => (window as unknown as { spoken: string[] }).spoken)
}

test('enabling speech shows Read aloud, and auto-read speaks a new reply', async ({ page }, testInfo) => {
  const spoken = await recordSpeech(page)
  const answer = 'All three services are healthy.'
  const fixture = await watchReply([page], { session: 'speech', turn: 'speech-run', stream: 'speech-run' })
  try {
    await page.goto('/settings/speech')
    await settle(page)
    const readAloud = page.getByRole('switch', { name: 'Text-to-Speech for responses', exact: true })
    const autoRead = page.getByRole('switch', { name: 'Auto-read responses aloud', exact: true })
    await expect(readAloud).not.toBeChecked()
    await readAloud.click()
    await expect(readAloud).toBeChecked()
    await autoRead.click()
    await expect(autoRead).toBeChecked()
    await expect(page.getByLabel('Speech rate')).toHaveValue('1')
    await page.screenshot({ path: testInfo.outputPath('speech-settings.png'), fullPage: true })

    await fixture.open()
    await fixture.finish()
    await expect.poll(spoken).toEqual([answer])
    await page.getByRole('button', { name: 'Read aloud' }).click()
    await expect.poll(spoken).toEqual([answer, answer])
    await page.screenshot({ path: testInfo.outputPath('speech-read-aloud.png'), fullPage: true })
  } finally {
    fixture.close()
    await page.request.post('/api/settings', { data: { tts_enabled: false, tts_auto_read: false } })
  }
})

/** Real storage and real hook, with only the speech device and server turn transport replaced. */
async function watchReply(pages: Page[], { session = 'shared-speech', turn = 'stable-turn', stream = 'speech-stream', root = '' } = {}) {
  const question = { role: 'user', id: 1, content: 'Check the services', _turn_id: turn }
  const reply = { role: 'assistant', id: 2, content: 'All three services are healthy.', _turn_id: turn }
  let finished = false
  const responses = new Set<ServerResponse>()
  const server = createServer((request, response) => {
    responses.add(response)
    response.on('close', () => responses.delete(response))
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': request.headers.origin ?? '*', 'Access-Control-Allow-Credentials': 'true' })
    response.write(`id: ${stream}:1\nevent: server_turn_started\ndata: ${JSON.stringify({ session_id: session, stream_id: stream, turn_id: turn, user_message_id: 1 })}\n\n`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing speech fixture port')
  for (const page of pages) {
    await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: session, title: 'Speech', messages: finished ? [question, reply] : [question], active_stream_id: finished ? null : stream } } }))
    await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: !finished, stream_id: stream, replay_available: true } }))
    await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${address.port}/stream` }))
  }
  return {
    async open() {
      finished = false
      await Promise.all(pages.map((page) => page.goto(`${root}/session/${session}`)))
      for (const page of pages) await expect(page.locator('.live-run-status')).toBeVisible()
      await expect.poll(() => responses.size).toBe(pages.length)
    },
    async finish() {
      finished = true
      for (const response of responses) response.write(`id: ${stream}:2\nevent: done\ndata: ${JSON.stringify({ session: { session_id: session, title: 'Speech', messages: [question, reply] } })}\n\n`)
      for (const page of pages) {
        await expect(page.locator('.live-turn')).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Read aloud', exact: true })).toBeVisible()
      }
    },
    close() { for (const response of responses) response.end(); server.closeAllConnections(); server.close() },
  }
}

async function enableAutoRead(page: Page) {
  expect((await page.request.post('/api/settings', { data: { tts_enabled: true, tts_auto_read: true } })).ok()).toBe(true)
}

// Reading the real store also waits for pending read/write transactions to complete.
async function storedClaims(page: Page): Promise<string[]> {
  return page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const request = indexedDB.open('talaria-auto-read', 1)
    request.onerror = () => reject(new Error('Could not open claims', { cause: request.error }))
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('claims', 'readonly')
      const rows = tx.objectStore('claims').getAll()
      tx.oncomplete = () => { db.close(); resolve((rows.result as { identity: string }[]).map((row) => row.identity)) }
      tx.onabort = () => { db.close(); reject(new Error('Claim transaction aborted', { cause: tx.error })) }
    }
  }))
}

test('two tabs claim one automatic reply, retain the attempt across reload, and allow manual reads', async ({ page, context }, testInfo) => {
  const other = await context.newPage()
  const speech = [await recordSpeech(page), await recordSpeech(other)]
  const total = async () => (await Promise.all(speech.map((read) => read()))).flat()
  const fixture = await watchReply([page, other])
  await enableAutoRead(page)
  try {
    await fixture.open()
    await page.screenshot({ path: testInfo.outputPath('auto-read-before.png'), fullPage: true })
    await fixture.finish()
    await expect.poll(total).toEqual(['All three services are healthy.'])
    expect(await storedClaims(page)).toHaveLength(1)
    // Start observing the same stable turn again in replacement documents.
    await Promise.all([page.reload(), other.reload()])
    for (const tab of [page, other]) await expect(tab.getByRole('button', { name: 'Read aloud', exact: true })).toBeVisible()
    expect(await total()).toEqual([])
    await fixture.open()
    await fixture.finish()
    expect(await storedClaims(page)).toHaveLength(1)
    expect(await total()).toEqual([])
    await page.getByRole('button', { name: 'Read aloud', exact: true }).click()
    await expect.poll(total).toEqual(['All three services are healthy.'])
    await page.screenshot({ path: testInfo.outputPath('auto-read-after.png'), fullPage: true })
    await other.screenshot({ path: testInfo.outputPath('auto-read-other-tab.png'), fullPage: true })
  } finally {
    fixture.close()
    await other.close()
    await page.request.post('/api/settings', { data: { tts_enabled: false, tts_auto_read: false } })
  }
})

for (const failure of ['unavailable', 'abort'] as const) {
  test(`automatic speech fails closed on storage ${failure}, manual speech remains available`, async ({ page }) => {
    const speech = await recordSpeech(page)
    await page.addInitScript((mode) => {
      if (mode === 'unavailable') Object.defineProperty(window, 'indexedDB', { get: () => { throw new Error('Storage denied') } })
      else {
        // Preserve the database receiver when forwarding the native transaction method.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const original = IDBDatabase.prototype.transaction
        IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
          const tx = original.apply(this, args)
          if (this.name === 'talaria-auto-read' && tx.mode === 'readwrite') queueMicrotask(() => tx.abort())
          return tx
        }
      }
    }, failure)
    const fixture = await watchReply([page])
    await enableAutoRead(page)
    try {
      await fixture.open()
      await fixture.finish()
      // A manual click occurs after the automatic claim's rejected/aborted transaction has settled.
      await page.waitForLoadState('networkidle')
      expect(await speech()).toEqual([])
      await page.getByRole('button', { name: 'Read aloud', exact: true }).click()
      await expect.poll(speech).toEqual(['All three services are healthy.'])
    } finally {
      fixture.close()
      await page.request.post('/api/settings', { data: { tts_enabled: false, tts_auto_read: false } })
    }
  })
}

test('claims isolate account, profile, session, turn and server identities and bound retention', async ({ page }) => {
  const speech = await recordSpeech(page)
  let user = 'synthetic-reader', profile = 'default'
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch()
    const data = await response.json() as { auth: { user: string }; profile: { name: string } }
    data.auth.user = user
    data.profile = { ...data.profile, name: profile }
    await route.fulfill({ response, json: data })
  })
  await enableAutoRead(page)
  try {
    const cases = [
      { user, profile, session: 'identity-speech', turn: 'one' },
      { user: 'another-reader', profile, session: 'identity-speech', turn: 'one' },
      { user, profile: 'work', session: 'identity-speech', turn: 'one' },
      { user, profile, session: 'another-session', turn: 'one' },
      { user, profile, session: 'identity-speech', turn: 'two' },
    ]
    for (const identity of cases) {
      user = identity.user; profile = identity.profile
      const fixture = await watchReply([page], identity)
      try {
        await fixture.open()
        await fixture.finish()
        await expect.poll(speech).toEqual(['All three services are healthy.'])
      } finally { fixture.close() }
    }
    expect(await storedClaims(page)).toHaveLength(cases.length)
    // Fill the real store, then drive one more actual automatic reply through the hook.
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('talaria-auto-read', 1)
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('claims', 'readwrite'), store = tx.objectStore('claims')
        for (let i = 0; i < 1024; i++) store.add({ identity: `old-${i}` })
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onabort = () => { db.close(); reject(new Error('Claim transaction aborted', { cause: tx.error })) }
      }
      request.onerror = () => reject(new Error('Could not open claims', { cause: request.error }))
    }))
    const fixture = await watchReply([page], { turn: 'after-retention' })
    try {
      await fixture.open()
      await fixture.finish()
      await expect.poll(speech).toEqual(['All three services are healthy.'])
      const claims = await storedClaims(page)
      expect(claims).toHaveLength(1024)
      expect(claims).not.toContain('old-0')
      expect(claims.some((claim) => claim.includes('after-retention'))).toBe(true)
    } finally { fixture.close() }
    // A distinct server origin owns a distinct browser storage partition.
    const origin = new URL(process.env.HERMES_E2E_BASE_URL!)
    origin.hostname = 'localhost'
    await page.goto(origin.href)
    expect(await page.evaluate(async () => (await indexedDB.databases()).some((db) => db.name === 'talaria-auto-read'))).toBe(false)
    const otherServer = await watchReply([page], { session: 'identity-speech', turn: 'one', root: origin.origin })
    try {
      await otherServer.open()
      await otherServer.finish()
      await expect.poll(speech).toEqual(['All three services are healthy.'])
      expect(await storedClaims(page)).toHaveLength(1)
    } finally { otherServer.close() }
  } finally {
    await page.request.post(`${process.env.HERMES_E2E_BASE_URL!}/api/settings`, { data: { tts_enabled: false, tts_auto_read: false } })
  }
})
