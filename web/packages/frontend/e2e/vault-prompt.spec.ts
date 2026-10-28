import { readFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block', video: 'on' })

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../contracts/fixtures/vault-prompts.json'), 'utf8')) as Record<'unlock' | 'save_login' | 'code' | 'skill_secret', { pending: Record<string, unknown> }>

/** TAL-887: the Agent's password-manager prompt renders from the server's queue head, masked, and answers once. */
for (const kind of ['unlock', 'skill_secret'] as const) {
test(`${kind} takes a masked answer and sends it only to the respond route`, async ({ page }, testInfo) => {
  const sid = 'vault-prompt'
  let head: Record<string, unknown> | null = { ...fixture[kind].pending, timeout_seconds: 120, vault: { ...(fixture[kind].pending.vault as object), timeout_at: Date.now() / 1000 + 120 } }
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Log in', active_stream_id: 'vault-run', is_streaming: true, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true,
    transcript_seq: null, messages: [{ role: 'user', id: 1, content: 'Log in to example', _turn_id: 'vault-run' }],
  } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'vault-run', replay_available: false } }))
  await page.route('**/api/clarify/pending?**', (route) => route.fulfill({ json: { pending: head, pending_count: head ? 1 : 0 } }))
  const responses: unknown[] = []
  await page.route('**/api/clarify/respond', async (route) => {
    responses.push(route.request().postDataJSON())
    head = null
    await route.fulfill({ json: { ok: true } })
  })

  // The turn stays open while the Agent waits on the prompt.
  const streams: ServerResponse[] = []
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    response.write(`id: vault-run:1\nevent: token\ndata: ${JSON.stringify({ text: 'Opening the login page.' })}\n\n`)
    streams.push(response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
  try {
    await page.goto(`/session/${sid}`)
    const prompt = page.getByRole('dialog', { name: kind === 'unlock' ? 'Unlock Bitwarden' : 'Set up example' })
    await expect(prompt).toBeVisible()
    const password = prompt.getByLabel(kind === 'unlock' ? 'Master password' : 'EXAMPLE_API_KEY')
    await expect(password).toHaveAttribute('type', 'password')
    await page.screenshot({ path: testInfo.outputPath('prompt-empty.png'), fullPage: true })
    await password.fill('correct horse battery')
    await page.screenshot({ path: testInfo.outputPath('prompt-masked.png'), fullPage: true })
    await prompt.getByRole('button', { name: kind === 'unlock' ? 'Unlock' : 'Save', exact: true }).click()
    await expect(prompt).toHaveCount(0)
    await expect.poll(() => responses).toEqual([{ session_id: sid, clarify_id: kind === 'unlock' ? 'contract-vault-unlock' : 'contract-skill-secret', answers: { [kind === 'unlock' ? 'master_password' : 'secret']: 'correct horse battery' } }])
    await page.screenshot({ path: testInfo.outputPath('prompt-saved.png'), fullPage: true })
    if (kind === 'skill_secret') {
      head = { ...fixture[kind].pending, clarify_id: 'skip-skill-secret', vault: { ...(fixture[kind].pending.vault as object), timeout_at: Date.now() / 1000 + 120 } }
      await page.reload()
      await expect(prompt).toBeVisible()
      await prompt.getByRole('button', { name: 'Skip', exact: true }).click()
      await expect(prompt).toHaveCount(0)
      await expect.poll(() => responses[1]).toEqual({ session_id: sid, clarify_id: 'skip-skill-secret', decline: true })
    }
  } finally {
    for (const response of streams) response.end()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
})
}
