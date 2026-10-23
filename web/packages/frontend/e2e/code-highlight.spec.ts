import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Locator } from '@playwright/test'
import type { GatewaySnapshot } from '@maudecode/talaria-web-contracts'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import type { StreamFrame } from '../../server/dist/sidecar/client.js'
import { hydrateAnchorActivityScenes, withTurnIds } from '../../server/dist/sessions/anchor.js'
import { redactSessionData } from '../../server/dist/redact.js'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const CODE = 'const a = 1\n/* a comment\nthat spans lines */\nconst b = `template\n${a} inside`\nconst c = 2'

/** Whether each rendered line of a code block carries Shiki colors. */
const lineColors = (body: Locator) => body.locator('code > span').evaluateAll((lines) => lines.map((line) => line.querySelector('[style*="--sdm-c"]') !== null))

test('code fences are highlighted, including lines inside multi-line comments and strings', async ({ page }, testInfo) => {
  const messages = [
    { role: 'user', id: 1, content: 'Show some code' },
    { role: 'assistant', id: 2, content: `\`\`\`ts\n${CODE}\n\`\`\`\n\n\`\`\`python\nprint("hi")\n\`\`\`\n\n\`\`\`json\n{"answer": 42}\n\`\`\`\n\n\`\`\`\nplain fence\n\`\`\`` },
  ]
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: 'code-highlight', title: 'Show some code', messages: redactSessionData({ messages: hydrateAnchorActivityScenes(withTurnIds(messages), {}) }, true).messages,
  } } }))
  await page.goto('/session/code-highlight')
  const blocks = page.locator('[data-final-answer="1"] [data-streamdown="code-block-body"]')
  await expect(blocks).toHaveCount(4)
  await expect.poll(() => lineColors(blocks.nth(0))).toEqual([true, true, true, true, true, true])
  await expect.poll(() => lineColors(blocks.nth(1))).toEqual([true])
  await expect.poll(() => lineColors(blocks.nth(2))).toEqual([true])
  await expect(blocks.nth(3)).toContainText('plain fence')
  await page.locator('[data-final-answer="1"]').scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath(`code-highlight-${testInfo.project.name}.png`), fullPage: true })
})

test('a streaming code fence highlights each line as it completes', async ({ page }, testInfo) => {
  const fixture = JSON.parse(readFileSync(new URL('../../server/src/test/fixtures/canonical-ownership.json', import.meta.url), 'utf8')) as { sessions: { cli: string }; schema: string[]; inserts: string[] }
  const sid = fixture.sessions.cli
  const sidecar = new FakeSidecar()
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' } })
  const db = new DatabaseSync(join(server.state, 'state.db'))
  let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
  let snap: GatewaySnapshot = { session_id: sid, stored_session_id: sid, messages: [{ role: 'user', content: 'Write some code', message_id: 'code-input' }],
    message_count: 1, running: true, authority_epoch: 1, replay_epoch: 'owner-epoch', last_sequence: 0, subscription_id: 'viewer', revision: 1, execution_generation: 1,
    pending: [{ admission_id: 'code-input', sequence: 1, status: 'started', outcome: null, authority_epoch: 1, execution_generation: 1, text: 'Write some code' }], prompts: [], info: { title: 'Streaming code' } }
  const attached = () => ({ state: 'attached' as const, reason: null, snapshot: snap, receipt: null })
  const delta = (text: string) => {
    emit!({ event: 'event', data: { type: 'message.delta', payload: { text }, session_id: sid, authority_epoch: 1, replay_epoch: 'owner-epoch', execution_generation: 1 } })
  }
  sidecar.respond('gateway.session', (params, sendFrame, opts) => {
    if (params.action !== 'watch') return attached()
    emit = sendFrame
    sendFrame({ event: 'snapshot', data: attached() })
    return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached()) }, { once: true }) })
  })
  try {
    db.exec(fixture.schema.join('\n'))
    for (const sql of fixture.inserts) db.exec(sql)
    await server.deps.settings.save({ show_cli_sessions: true })
    await page.goto(`${server.base}/session/${sid}`)
    await expect.poll(() => Boolean(emit)).toBe(true)
    // The comment and the template string open here and close only in a later chunk.
    delta('```ts\nconst a = 1\n/* a comment\nthat spans lines */\nconst b = `templ')
    const body = page.locator('[data-streamdown="code-block-body"]')
    await expect(body).toContainText('const b = `templ')
    // Completed lines are colored; the line still streaming stays plain until its newline arrives.
    await expect.poll(() => lineColors(body)).toEqual([true, true, true, false])
    await page.screenshot({ path: testInfo.outputPath(`code-streaming-${testInfo.project.name}.png`) })
    delta('ate\n${a} inside`\nconst c = 2\n```\n\nDone.')
    await expect(page.getByText('Done.')).toBeVisible()
    await expect.poll(() => lineColors(body)).toEqual([true, true, true, true, true, true])
    await page.screenshot({ path: testInfo.outputPath(`code-streamed-${testInfo.project.name}.png`) })
  } finally {
    snap = { ...snap, running: false, pending: [] }
    await page.goto('about:blank')
    db.close()
    await server.close()
  }
})
