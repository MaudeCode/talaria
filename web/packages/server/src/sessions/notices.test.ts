import { describe, expect, it } from 'vitest'
import { SessionNotices } from './notices.js'

describe('SessionNotices (TAL-803)', () => {
  it('drops a TTL notice once it expires and keeps a sticky one until cleared', () => {
    let now = 1000
    const notices = new SessionNotices(() => now)
    expect(notices.add('s1', { key: 'band', level: 'info', kind: 'ttl', ttl_ms: 5000, text: 'Usage at 90%' })?.expires_at).toBe(1005)
    expect(notices.add('s1', { key: 'mem', level: 'loud', kind: 'sticky', ttl_ms: 5000, text: 'Memory is off' })?.expires_at).toBeNull()
    expect(notices.list('s1')).toEqual([
      { key: 'band', level: 'info', text: 'Usage at 90%', expires_at: 1005 },
      { key: 'mem', level: 'info', text: 'Memory is off', expires_at: null },
    ])
    now = 1005
    expect(notices.list('s1').map((n) => n.key)).toEqual(['mem'])
    expect(notices.list('s2')).toEqual([])
    notices.add('s1', { key: 'startup-warning.1', level: 'warn', kind: 'sticky', text: 'Memory is off', lapses_with_agent: false })
    expect(notices.reset('s1')).toBe(true)
    expect(notices.list('s1').map((n) => n.key)).toEqual(['startup-warning.1'])
    expect(notices.reset('s1')).toBe(false)
  })

  it('keys a notice by its id, else its text, and ignores an empty one', () => {
    const notices = new SessionNotices(() => 0)
    expect(notices.add('s1', { id: 'n1', level: 'warn', kind: 'sticky', text: 'A' })).not.toBeNull()
    expect(notices.add('s1', { level: 'warn', kind: 'sticky', text: 'B' })).not.toBeNull()
    expect(notices.add('s1', { level: 'warn', kind: 'sticky', text: 'B' })).toBeNull()
    expect(notices.add('s1', { key: 'x', level: 'warn', kind: 'sticky', text: '  ' })).toBeNull()
    expect(notices.list('s1').map((n) => n.key)).toEqual(['n1', 'B'])
    expect(notices.clear('s1', 'missing')).toBe(false)
  })
})
