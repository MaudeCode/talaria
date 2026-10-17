import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { bootTestServer } from '../../test/harness.js'
import { HeldWakeups } from '../wakeup-pause.js'
import { JsonDocuments } from './json-documents.js'

it('keeps auth enabled when settings contain a JSON null rather than an absent document', async () => {
  const server = await bootTestServer()
  try {
    writeFileSync(join(server.state, 'settings.json'), 'null')
    server.deps.auth.invalidatePasswordHashCache()
    expect((await server.get('/api/sessions')).status).toBe(401)
  } finally { await server.close() }
})

it('refuses to replace a null held-wakeup map with a newly held event', async () => {
  const state = mkdtempSync(join(tmpdir(), 'talaria-null-held-'))
  mkdirSync(join(state, 'sessions'))
  const file = join(state, 'sessions', '_wakeup_held.json')
  writeFileSync(file, 'null')
  try {
    await expect(new HeldWakeups(new JsonDocuments(state)).hold('session', [{ process_id: 'process', wakeup_prompt: 'done' }])).rejects.toThrow()
    expect(readFileSync(file, 'utf8')).toBe('null')
  } finally { rmSync(state, { recursive: true, force: true }) }
})

it('leaves absent state absent for no-op wakeup mutations', async () => {
  const state = mkdtempSync(join(tmpdir(), 'talaria-empty-state-'))
  const documents = new JsonDocuments(state)
  try {
    const held = new HeldWakeups(documents)
    await held.hold('session', [])
    await held.release('session')
    expect(await documents.get('held-wakeups', 'held')).toBeNull()
  } finally { await documents.close(); rmSync(state, { recursive: true, force: true }) }
})
