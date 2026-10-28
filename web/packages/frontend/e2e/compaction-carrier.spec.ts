import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { openServerState, openStateDb } from './server'
import carrier from '../../server/src/test/fixtures/compaction-carrier.json' with { type: 'json' }

test.use({ serviceWorkers: 'block' })

/** TAL-1259: the real server reads the recorded Agent store; no mocked session response. */
test('a kept-message summary renders once as a compaction card and survives refresh', async ({ page }, testInfo) => {
  const state = openServerState()
  const sid = `${carrier.sessionId}-${testInfo.project.name}`
  const dbPath = join(state, 'state.db')
  const db = openStateDb(state)
  const sessionPath = join(state, 'sessions', `${sid}.json`)
  try {
    db.exec('PRAGMA foreign_keys = OFF; DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS system_prompts')
    db.exec([...carrier.schema, ...carrier.snapshots.compacted].join('\n').replaceAll(carrier.sessionId, sid))
    writeFileSync(sessionPath, JSON.stringify({ session_id: sid, title: 'Parser review', workspace: join(state, 'workspace'),
      messages: carrier.before, context_messages: carrier.before, created_at: 1000, updated_at: 1003 }))
    await page.goto(`/session/${sid}`)
    await expect(page.locator('#messages')).toContainText('The parser interface is preserved.')
    const shots = process.env.TAL1259_SHOTS
    if (shots) {
      mkdirSync(shots, { recursive: true })
      await page.screenshot({ path: `${shots}/collapsed-${testInfo.project.name}.png` })
    }
    const card = page.locator('#messages .marker-row')
    await expect(card).toHaveCount(1)
    await expect(card).toContainText('Context compaction')
    await expect(page.locator('#messages [data-role="assistant"]')).toHaveCount(2)
    await expect(page.locator('#messages')).not.toContainText('[PRIOR CONTEXT')
    await card.locator('summary').click()
    await expect(card.locator('.msg-body')).toHaveText(carrier.summary)
    if (shots) await page.screenshot({ path: `${shots}/expanded-${testInfo.project.name}.png` })
    await page.reload()
    await expect(page.locator('#messages .marker-row')).toHaveCount(1)
    await expect(page.locator('#messages [data-role="assistant"]')).toHaveCount(2)
  } finally {
    db.close()
    rmSync(sessionPath, { force: true })
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true })
  }
})
