import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { JsonStorage } from './json.js'
import { runDocumentBackendConformance, runJournalBackendConformance } from './conformance.js'

vi.mock('node:fs', async (original) => ({ ...await original<typeof fs>(), renameSync: vi.fn((await original<typeof fs>()).renameSync), fsync: vi.fn((await original<typeof fs>()).fsync) }))

function fixture() {
  const stateDir = fs.mkdtempSync(join(tmpdir(), 'talaria-state-conformance-'))
  const storage = new JsonStorage({ directory: join(stateDir, 'sessions'), stateDir, now: () => Date.now() / 1000, stampingSince: () => 0, env: { HERMES_WEBUI_RUN_JOURNAL_KEEP_RECENT: '0' } })
  return { storage, cleanup: async () => { await storage.close(); fs.rmSync(stateDir, { recursive: true, force: true }) } }
}

runDocumentBackendConformance('JSON', () => {
  const test = fixture()
  return { backend: test.storage.documents, cleanup: test.cleanup, failNextWrite: () => { vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('injected publication failure') }) } }
})
runJournalBackendConformance('JSON', () => { const test = fixture(); return { backend: test.storage.journals, cleanup: test.cleanup } })

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
