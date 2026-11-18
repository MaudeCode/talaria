import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { expect, it, vi } from 'vitest'
import { JsonStorage } from './json.js'
import { JsonJournal } from './json-journal.js'
import { runDocumentBackendConformance, runJournalBackendConformance } from './conformance.js'
import { keepRecent } from '../../test/storage.js'

vi.mock('node:fs', async (original) => ({ ...await original<typeof fs>(), renameSync: vi.fn((await original<typeof fs>()).renameSync), fsync: vi.fn((await original<typeof fs>()).fsync) }))

function fixture(env = keepRecent(0)) {
  const stateDir = fs.mkdtempSync(join(tmpdir(), 'talaria-state-conformance-'))
  const storage = new JsonStorage({ directory: join(stateDir, 'sessions'), stateDir, now: () => Date.now() / 1000, stampingSince: () => 0, env })
  const reopened: JsonJournal[] = []
  return { storage, env, reopened, cleanup: async () => { for (const journal of reopened) await journal.close(); await storage.close(); fs.rmSync(stateDir, { recursive: true, force: true }) } }
}

runDocumentBackendConformance('JSON', () => {
  const test = fixture()
  return { backend: test.storage.documents, cleanup: test.cleanup, failNextWrite: () => { vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('injected publication failure') }) } }
})
runJournalBackendConformance('JSON', (env) => {
  const test = fixture(env)
  const journal = test.storage.journals
  const archive = (sid: string, rid: string): string => journal.archivePathFor(sid, rid)
  return {
    backend: journal,
    cleanup: test.cleanup,
    reopen: () => { const next = new JsonJournal(journal.sessionDir, test.env); test.reopened.push(next); return next },
    store: {
      age: (sid, rid, at) => { fs.utimesSync(journal.pathFor(sid, rid), at, at) },
      live: (sid, rid) => Promise.resolve(fs.existsSync(journal.pathFor(sid, rid))),
      liveBytes: (sid, rid) => Promise.resolve(fs.readFileSync(journal.pathFor(sid, rid))),
      archive: (sid, rid) => Promise.resolve(fs.existsSync(archive(sid, rid)) ? gunzipSync(fs.readFileSync(archive(sid, rid))) : null),
      archiveSize: (sid, rid) => Promise.resolve(fs.statSync(archive(sid, rid)).size),
      ageArchive: (sid, rid, at) => { fs.utimesSync(archive(sid, rid), at, at) },
      dropSummary: (sid, rid) => { fs.rmSync(join(journal.root(), sid, `${rid}.summary.json`)) },
      // A replay sizes an archive from its compressed file, so it always reaches the inflation.
      understateArchive: () => undefined,
    },
  }
})

it.each(['eager', 'terminal-only'] as const)('fsyncs terminal rows before acknowledging them in %s mode', async (durability) => {
  const test = fixture()
  try {
    const writer = await test.storage.journals.open('session', 'stream', { durability })
    vi.mocked(fs.fsync).mockClear()
    await writer.append({ event: 'token', payload: { text: 'first' } }, { terminal: false })
    expect(fs.fsync).toHaveBeenCalledTimes(durability === 'eager' ? 1 : 0)
    await writer.append({ event: 'done', payload: {} }, { terminal: true })
    expect(fs.fsync).toHaveBeenCalledTimes(durability === 'eager' ? 2 : 1)
    await writer.close()
  } finally { await test.cleanup() }
})

it('applies document byte limits to legacy whitespace before JSON parsing', async () => {
  const test = fixture()
  try {
    const state = join(test.storage.directory, '..')
    fs.mkdirSync(state, { recursive: true })
    fs.writeFileSync(join(state, 'extension-overrides.json'), ' '.repeat(40 * 1024) + '{"version":1}')
    await expect(test.storage.documents.get('extensions', 'overrides', { maxBytes: 32 * 1024 })).rejects.toMatchObject({ reason: 'too-large' })
  } finally { await test.cleanup() }
})

import { JsonDocuments } from './json-documents.js'

it('does not recreate an Agent-owned profile home when an identity write races deletion', async () => {
  const state = fs.mkdtempSync(join(tmpdir(), 'talaria-identity-boundary-'))
  const home = join(state, 'profiles', 'work')
  const documents = new JsonDocuments(state, () => home)
  try {
    await expect(documents.put('relay-identities', 'work', `pfi_${'a'.repeat(32)}\n`, null)).rejects.toThrow()
    expect(fs.existsSync(home)).toBe(false)
  } finally { await documents.close(); fs.rmSync(state, { recursive: true, force: true }) }
})
