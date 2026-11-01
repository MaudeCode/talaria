import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runStorage } from '../../cli/storage.js'
import type { StorageBackend } from './backend.js'
import { copyStorage, verifyStorage } from './copy.js'
import { JsonStorage } from './json.js'
import { SqliteStorage } from './sqlite.js'

const dirs: string[] = []
const stores: StorageBackend[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(): string { const dir = mkdtempSync(join(tmpdir(), 'talaria-storage-copy-')); dirs.push(dir); return dir }
const env = { HERMES_WEBUI_RUN_JOURNAL_KEEP_RECENT: '0' }
function jsonStore(stateDir: string): JsonStorage { const store = new JsonStorage({ directory: join(stateDir, 'sessions'), stateDir, env, now: () => Date.now() / 1000, stampingSince: () => 0 }); stores.push(store); return store }
function sqliteStore(stateDir: string): SqliteStorage { const store = new SqliteStorage({ path: join(stateDir, 'talaria.db'), sessionDir: join(stateDir, 'sessions'), env, stampingSince: () => 0 }); stores.push(store); return store }
const doc = (sid: string, extra: Record<string, unknown> = {}) => ({ session_id: sid, title: `Title ${sid}`, created_at: 10, updated_at: 20, message_count: 0, ...extra })
const rows = (sid: string, count: number) => Array.from({ length: count }, (_, n) => ({ role: n % 2 ? 'assistant' : 'user', content: `${sid} É ${String(n)}`, timestamp: n }))

/** Sessions, tombstones, a shrink backup, the index, drafts, shares, settings, auth and passkeys, and live and pruned journals. */
async function seed(store: StorageBackend): Promise<void> {
  const { sessions, documents, journals } = store
  await sessions.write('alpha', { doc: doc('alpha'), messages: { kind: 'replace', rows: rows('alpha', 3) } }, null)
  const beta = await sessions.write('beta', { doc: doc('beta', { context_messages: [] }), messages: { kind: 'replace', rows: rows('beta', 5) } }, null)
  await sessions.write('beta', { doc: doc('beta', { context_messages: [] }), messages: { kind: 'replace', rows: rows('beta', 2) } }, beta)
  await sessions.write('gamma', { doc: doc('gamma'), messages: { kind: 'replace', rows: rows('gamma', 1) } }, null)
  await sessions.delete('gamma', { tombstone: true })
  await sessions.tombstones.add('ghost')
  await sessions.writeIndex([{ session_id: 'alpha', message_count: 3 }, { session_id: 'beta', message_count: 2 }])
  await documents.put('drafts', 'alpha', { text: 'draft', files: [], _draft_version: '1000' }, null)
  await documents.put('shares', 'share-1', { session_id: 'alpha', title: 'Shared' }, null)
  await documents.put('settings', 'settings', { theme: 'dark', language: 'en' }, null)
  await documents.put('auth', 'sessions', { token: { created: 1, expires: 2 } }, null)
  await documents.put('auth', 'signing-key', Buffer.from('synthetic signing key').toString('base64'), null)
  await documents.put('passkeys', 'passkeys', { credentials: [{ id: 'credential', counter: 1 }] }, null)
  const settled = await journals.open('alpha', 'run-old', { durability: 'eager' })
  await settled.append({ event: 'token', payload: { text: 'old' }, created_at: 1 }, { terminal: false })
  await settled.append({ event: 'done', payload: {}, created_at: 2 }, { terminal: true })
  await settled.close()
  expect(await journals.prune(Date.now() / 1000 + 1)).toBe(1)
  const live = await journals.open('alpha', 'run-live', { durability: 'eager' })
  await live.append({ event: 'token', payload: { text: 'live' }, created_at: 3 }, { terminal: false })
  await live.close()
}

/** Every seeded item, read back through the storage port. */
async function contents(store: StorageBackend) {
  const { sessions, documents, journals } = store
  const items: Record<string, unknown> = {}
  for (const sid of ['alpha', 'beta']) {
    const stored = await sessions.readDocument(sid)
    items[sid] = { doc: stored?.doc, messages: stored?.messages }
    const backup = await sessions.shrinkBackup.read(sid)
    items[`${sid}.bak`] = backup && { doc: backup.doc, messages: backup.messages, savedAt: Math.round(backup.savedAt) }
  }
  items.gamma = await sessions.exists('gamma')
  items.tombstones = [...await sessions.tombstones.all()].sort()
  items.index = (await sessions.index()).entries
  for (const [namespace, key] of [['drafts', 'alpha'], ['shares', 'share-1'], ['settings', 'settings'], ['auth', 'sessions'], ['auth', 'signing-key'], ['passkeys', 'passkeys']] as const) items[`${namespace}/${key}`] = (await documents.get(namespace, key))?.value
  items.streams = await journals.streams('alpha')
  items.live = await journals.readRunEvents('alpha', 'run-live')
  items.pruned = await journals.summary('alpha', 'run-old')
  return items
}

it('copies a JSON store to SQLite, verifies it, and copies nothing on a re-run', async () => {
  const state = tempDir()
  const json = jsonStore(state)
  await seed(json)
  const sqlite = sqliteStore(state)
  const first = await copyStorage(json, sqlite)
  expect(first.failures).toEqual([])
  expect(first.copied).toBeGreaterThan(10)
  expect(await verifyStorage(json, sqlite)).toEqual([])
  const expected = await contents(json)
  expect(expected['beta.bak']).toMatchObject({ messages: rows('beta', 5) })
  expect(expected.pruned).toMatchObject({ journal_pruned: true, terminal: true })
  expect(await contents(sqlite)).toEqual(expected)

  expect(await copyStorage(json, sqlite)).toEqual({ copied: 0, unchanged: first.copied + first.unchanged, failures: [] })

  // A destination row changed after the copy fails verification.
  sqlite.db.db.prepare("UPDATE messages SET body = ? WHERE session_id = 'alpha' AND idx = 1").run(JSON.stringify({ role: 'assistant', content: 'tampered' }))
  expect(await verifyStorage(json, sqlite)).toEqual(['session alpha'])
  sqlite.db.db.prepare("UPDATE documents SET value = ? WHERE ns = 'settings'").run(JSON.stringify({ theme: 'light' }))
  expect(await verifyStorage(json, sqlite)).toEqual(['session alpha', 'document settings/settings'])
})

it('copies a SQLite store back to JSON', async () => {
  const sqlite = sqliteStore(tempDir())
  await seed(sqlite)
  const json = jsonStore(tempDir())
  expect((await copyStorage(sqlite, json)).failures).toEqual([])
  expect(await verifyStorage(sqlite, json)).toEqual([])
  expect(await contents(json)).toEqual(await contents(sqlite))
})

async function cli(home: string, port: number, argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const webRoot = join(home, 'web')
  mkdirSync(webRoot, { recursive: true })
  const code = await runStorage({ env: { HERMES_HOME: home, HERMES_WEBUI_STATE_DIR: join(home, 'webui'), HERMES_WEBUI_PORT: String(port), HERMES_WEBUI_CTL_ISOLATE_WORKTREE: '0', PATH: process.env.PATH }, webRoot, home, log: (line) => out.push(line), warn: (line) => err.push(line) }, argv)
  return { code, out: out.join('\n'), err: err.join('\n') }
}
const listen = (server: Server): Promise<number> => new Promise((resolve) => { server.listen(0, '127.0.0.1', () => { resolve((server.address() as AddressInfo).port) }) })

it('talaria-web storage copy refuses while a server answers, then copies, verifies and prints the setting', async () => {
  const home = tempDir()
  await seed(jsonStore(join(home, 'webui')))
  for (const store of stores.splice(0)) await store.close()
  const server = createServer((_req, res) => { res.end('ok') })
  const port = await listen(server)
  try {
    const refused = await cli(home, port, ['copy', '--from', 'json', '--to', 'sqlite'])
    expect(refused.code).toBe(1)
    expect(refused.err).toContain(`a server is answering on 127.0.0.1:${String(port)}`)
  } finally { await new Promise((resolve) => server.close(resolve)) }
  const copied = await cli(home, port, ['copy', '--from=json', '--to=sqlite'])
  expect(copied.err).toBe('')
  expect(copied.code).toBe(0)
  expect(copied.out.split('\n').at(-1)).toBe('TALARIA_STORAGE=sqlite')
  const again = await cli(home, port, ['copy', '--from', 'json', '--to', 'sqlite'])
  expect(again.out).toContain('Copied 0 items')
  expect(await contents(sqliteStore(join(home, 'webui')))).toEqual(await contents(jsonStore(join(home, 'webui'))))
  expect((await cli(home, port, ['copy', '--from', 'json', '--to', 'json'])).code).toBe(2)
  expect((await cli(home, port, ['copy', '--from', 'json', '--to', 'postgres'])).err).toContain('Unknown TALARIA_STORAGE="postgres"')
})
