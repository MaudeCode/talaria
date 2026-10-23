import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { RevisionConflict } from './backend.js'
import { JsonDocuments } from './json-documents.js'
import { gateFsync } from '../../test/fs-handles.js'

vi.mock('node:fs/promises', async (original) => { const real = await original<typeof fsp>(); return { ...real, open: vi.fn(real.open) } })

it('keeps auth fsync off the event loop, publishes atomically, and drains pending commits before close', async () => {
  const state = fs.mkdtempSync(join(tmpdir(), 'talaria-auth-documents-'))
  const documents = new JsonDocuments(state)
  let release = () => { /* no pending fsync yet */ }
  try {
    const revision = await documents.put('auth', 'sessions', { first: 1000 }, null)
    const gate = gateFsync()
    release = gate.release
    const pending = documents.put('auth', 'sessions', { second: 2000 }, revision)
    await gate.started
    await setImmediate()
    expect((await documents.get('auth', 'sessions'))?.value).toEqual({ first: 1000 })
    let closed = false
    const closing = documents.close().then(() => { closed = true })
    await setImmediate()
    expect(closed).toBe(false)
    gate.release()
    await pending
    await closing
    expect((await new JsonDocuments(state).get('auth', 'sessions'))?.value).toEqual({ second: 2000 })
    expect(fs.statSync(join(state, '.sessions.json')).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(state)).toEqual(['.sessions.json'])
  } finally { release(); await documents.close(); vi.restoreAllMocks(); fs.rmSync(state, { recursive: true, force: true }) }
})

it('refuses an auth overwrite when the revision changes during async fsync', async () => {
  const state = fs.mkdtempSync(join(tmpdir(), 'talaria-auth-conflict-'))
  const documents = new JsonDocuments(state)
  let release = () => { /* no pending fsync yet */ }
  try {
    const revision = await documents.put('auth', 'sessions', { first: 1000 }, null)
    const gate = gateFsync()
    release = gate.release
    const pending = documents.put('auth', 'sessions', { stale: 2000 }, revision)
    const refused = expect(pending).rejects.toBeInstanceOf(RevisionConflict)
    await gate.started
    fs.writeFileSync(join(state, '.sessions.json'), '{"external":3000}')
    gate.release()
    await refused
    expect((await documents.get('auth', 'sessions'))?.value).toEqual({ external: 3000 })
    expect(fs.readdirSync(state)).toEqual(['.sessions.json'])
  } finally { release(); await documents.close(); vi.restoreAllMocks(); fs.rmSync(state, { recursive: true, force: true }) }
})
