import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionsListSchema } from '../../contracts'
import { groupSessionRows } from './SessionListPanel'

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../contracts/fixtures/web-session.json'), 'utf8')) as { session_list: { sessions: unknown[] } }
const rows = SessionsListSchema.shape.sessions.parse(fixture.session_list.sessions)

describe('session list date groups (TAL-306)', () => {
  it('keeps the server order inside every group', () => {
    const now = (rows.find((r) => r.session_id === 'tal306-created-only')!.sort_ts + 60) * 1000
    const groups = groupSessionRows(rows, now)
    expect(groups.flatMap((g) => g.rows)).toHaveLength(rows.length)
    for (const group of groups) {
      const ids = new Set(group.rows.map((r) => r.session_id))
      expect(group.rows.map((r) => r.session_id), group.id).toEqual(rows.filter((r) => ids.has(r.session_id)).map((r) => r.session_id))
    }
    expect(groups.find((g) => g.id === 'today')?.rows.map((r) => r.session_id)).toContain('tal306-created-only')
  })

  it('buckets by the server sort_ts, not a client-picked timestamp', () => {
    const now = Date.now()
    const day = 86_400
    const row = { ...rows.find((r) => r.session_id === 'tal306-newest')!, sort_ts: now / 1000 - 60, last_message_at: now / 1000 - 30 * day, updated_at: now / 1000 - 30 * day }
    expect(groupSessionRows([row], now).map((g) => g.id)).toEqual(['today'])
  })
})
