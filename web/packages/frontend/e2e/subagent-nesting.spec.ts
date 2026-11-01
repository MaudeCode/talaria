import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import { Session } from '../../server/dist/sessions/session.js'
import { expect, settle, test } from './fixtures'
import { openStateDb } from './server'

test.use({ serviceWorkers: 'block' })

// TAL-1151: the server links each subagent session to its parent; the sidebar nests it there, in the parent's tab and project.
test('nests subagent sessions under the chat that started them', async ({ page }, testInfo) => {
  const server = await bootTestServer({ sidecar: new FakeSidecar(), env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' } })
  const db = openStateDb(server.state)
  const now = Math.floor(Date.now() / 1000)
  try {
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT, started_at REAL NOT NULL, message_count INTEGER DEFAULT 0, title TEXT,
        chat_id TEXT, chat_type TEXT, thread_id TEXT, session_key TEXT, origin_chat_id TEXT, origin_user_id TEXT, platform TEXT, parent_session_id TEXT, ended_at REAL, end_reason TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL)`)
    const insert = (id: string, source: string, at: number, title: string | null, parent: string | null) => {
      db.prepare('INSERT INTO sessions (id, source, started_at, message_count, title, parent_session_id) VALUES (?, ?, ?, 2, ?, ?)').run(id, source, at, title, parent)
      for (const [role, ts] of [['user', at + 1], ['assistant', at + 2]] as const) db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(id, role, `${role} says`, ts)
    }
    const project = 'tal1151release'
    await server.deps.projects.mutate((projects) => { projects.push({ project_id: project, name: 'Release', color: '#22c55e', profile: 'default', created_at: now }) })
    await server.deps.sessionStore.save(new Session({ session_id: 'web-parent', title: 'Plan the release', project_id: project, messages: [{ role: 'user', content: 'Plan it', timestamp: now - 600 }, { role: 'assistant', content: 'Delegating.', timestamp: now - 590 }] }, { workspace: server.state, model: null }))
    insert('web-parent', 'webui', now - 600, 'Plan the release', null)
    insert('sub-notes', 'subagent', now - 300, 'Draft the release notes', 'web-parent')
    insert('sub-tests', 'subagent', now - 200, null, 'web-parent')
    insert('cli-host', 'cli', now - 900, 'Fix the build', null)
    insert('sub-cli', 'subagent', now - 100, null, 'cli-host')
    await server.deps.settings.save({ show_cli_sessions: true })
    await page.goto(server.base)
    await settle(page)
    const hamburger = page.locator('#btnHamburger')
    if (await hamburger.isVisible()) await hamburger.click()
    const list = page.locator('#sessionList')
    await expect(list.locator('.session-item[data-sid="web-parent"]')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('webui-tab.png') })
    const shown = () => list.locator('.session-item').evaluateAll((items) => items.map((item) => `${item.getAttribute('data-sid') ?? ''}${item.classList.contains('session-item-nested') ? ' (nested)' : ''}`))
    expect(await shown()).toEqual(['web-parent', 'sub-tests (nested)', 'sub-notes (nested)'])
    await page.getByRole('button', { name: 'CLI sessions (2)' }).click()
    await expect.poll(shown).toEqual(['cli-host', 'sub-cli (nested)'])
    await page.screenshot({ path: testInfo.outputPath('cli-tab.png') })
    await page.getByRole('button', { name: 'WebUI sessions (3)' }).click()
    await page.getByRole('button', { name: 'Unassigned' }).click()
    await expect.poll(shown).toEqual([])
  } finally {
    await page.goto('about:blank')
    db.close()
    await server.close()
  }
})
