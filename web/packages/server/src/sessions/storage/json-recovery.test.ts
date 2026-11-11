/** TAL-1745: the JSON backend's recovery diagnosis reads and parses each document once. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { diagnoseJson } from './json-recovery.js'

let dir = ''
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })

it('parses each live, backup, and index document once', async () => {
  dir = mkdtempSync(join(tmpdir(), 'talaria-json-recovery-'))
  const docs: Record<string, unknown> = {
    'shrunk.json': { session_id: 'shrunk', messages: [{ role: 'user', content: 'live' }] },
    'shrunk.json.bak': { session_id: 'shrunk', messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }] },
    'orphan.json.bak': { session_id: 'orphan', messages: [{ role: 'user', content: 'orphaned' }] },
    'unindexed.json': { session_id: 'unindexed', messages: [{ role: 'user', content: 'unindexed' }] },
    '_index.json': [{ session_id: 'shrunk' }],
  }
  const texts = new Map(Object.entries(docs).map(([name, doc]) => [JSON.stringify(doc), name]))
  for (const [text, name] of texts) writeFileSync(join(dir, name), text)
  const parse = vi.spyOn(JSON, 'parse')
  const issues = await diagnoseJson(dir, 0)
  const parsed: Record<string, number> = {}
  for (const [text] of parse.mock.calls) { const name = texts.get(text); if (name) parsed[name] = (parsed[name] ?? 0) + 1 }
  expect(parsed).toEqual(Object.fromEntries(Object.keys(docs).map((name) => [name, 1])))
  expect(issues.map((i) => [i.session_id, i.kind, i.live_messages, i.bak_messages])).toEqual([
    ['orphan', 'orphan_backup', -1, 1], ['shrunk', 'shrunken_live', 1, 2], ['unindexed', 'index_missing_entry', 1, -1],
  ])
})
