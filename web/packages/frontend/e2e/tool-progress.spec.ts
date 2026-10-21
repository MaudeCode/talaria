import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { GatewaySnapshot } from '@maudecode/talaria-web-contracts'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import type { StreamFrame } from '../../server/dist/sidecar/client.js'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

test('native MCP progress updates one running row, survives reload, and clears on completion', async ({ page }, testInfo) => {
  const fixture = JSON.parse(readFileSync(new URL('../../server/src/test/fixtures/canonical-ownership.json', import.meta.url), 'utf8')) as { sessions: { cli: string }; schema: string[]; inserts: string[] }
  const sid = fixture.sessions.cli
  const sidecar = new FakeSidecar()
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' } })
  const db = new DatabaseSync(join(server.state, 'state.db'))
  let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
  let snap: GatewaySnapshot = { session_id: sid, stored_session_id: sid, messages: [{ role: 'user', content: 'Index the project files', message_id: 'native-input' }],
    message_count: 1, running: true, authority_epoch: 1, replay_epoch: 'owner-epoch', last_sequence: 0, subscription_id: 'viewer', revision: 1, execution_generation: 1,
    pending: [{ admission_id: 'native-input', sequence: 1, status: 'started', outcome: null, authority_epoch: 1, execution_generation: 1, text: 'Index the project files' }], prompts: [], info: { title: 'Project index' } }
  const attached = () => ({ state: 'attached' as const, reason: null, snapshot: snap, receipt: null })
  const send = (type: string, payload: Record<string, unknown>) => {
    emit!({ event: 'event', data: { type, payload, session_id: sid, authority_epoch: 1, replay_epoch: 'owner-epoch', execution_generation: 1 } })
  }
  sidecar.respond('gateway.session', (params, sendFrame, opts) => {
    if (params.action !== 'watch') return attached()
    emit = sendFrame
    sendFrame({ event: 'snapshot', data: attached() })
    return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached()) }, { once: true }) })
  })
  const shot = async (name: string) => {
    if (process.env.TAL1312_SHOTS) await page.screenshot({ path: `${process.env.TAL1312_SHOTS}/${name}-${testInfo.project.name}.png` })
  }
  try {
    db.exec(fixture.schema.join('\n'))
    for (const sql of fixture.inserts) db.exec(sql)
    await server.deps.settings.save({ show_cli_sessions: true })
    await page.goto(`${server.base}/session/${sid}`)
    await expect.poll(() => Boolean(emit)).toBe(true)
    send('tool.start', { tool_id: 'index', name: 'mcp__search_index', args: { query: 'files' } })
    const row = page.locator('[data-tool-id="index"]')
    await expect(row).toBeVisible()
    await expect(row).toHaveCount(1)
    await shot('before')
    send('tool.progress', { tool_id: 'index', progress: 21, total: 50, message: 'indexing files' })
    await expect(row).toContainText('42% · indexing files')
    await shot('after')
    await page.reload()
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('42% · indexing files')
    await shot('reloaded')
    send('tool.complete', { tool_id: 'index', name: 'mcp__search_index', preview: 'indexed files' })
    await expect(row).toHaveAttribute('data-tool-done', '1')
    await expect(row.locator('.tool-card-progress')).toHaveCount(0)
    await shot('completed')
  } finally {
    snap = { ...snap, running: false, pending: [] }
    await page.goto('about:blank')
    db.close()
    await server.close()
  }
})
