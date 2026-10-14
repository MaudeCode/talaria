import type { SessionNotice } from '@maudecode/talaria-web-contracts'
import { str } from '../util.js'

const LEVELS = new Set<SessionNotice['level']>(['info', 'warn', 'error', 'success'])

/**
 * TAL-803: the Agent's active notices per session (session `notices`). A notice replaces the one with its key, so a
 * cached agent's later turns and a rebuilt agent's repeat never duplicate it; the Agent's clear or its TTL removes it.
 * ponytail: in memory, like the cached agents that raise them; a server restart starts with none.
 */
export class SessionNotices {
  private readonly bySession = new Map<string, Map<string, SessionNotice>>()

  constructor(private readonly now: () => number) {}

  /** The sidecar's `notice` frame: the notice it stored, null when it carries no text or changes nothing. */
  add(sessionId: string, frame: Record<string, unknown>): SessionNotice | null {
    const text = str(frame.text).trim()
    if (!text) return null
    const key = str(frame.key) || str(frame.id) || text
    const level = LEVELS.has(frame.level as SessionNotice['level']) ? (frame.level as SessionNotice['level']) : 'info'
    const ttl = frame.kind === 'ttl' && typeof frame.ttl_ms === 'number' && frame.ttl_ms > 0 ? frame.ttl_ms : null
    const notice: SessionNotice = { key, level, text, expires_at: ttl === null ? null : this.now() + ttl / 1000 }
    const notices = this.bySession.get(sessionId) ?? new Map<string, SessionNotice>()
    const prior = notices.get(key)
    if (prior?.level === notice.level && prior.text === notice.text && prior.expires_at === null && notice.expires_at === null) return null
    notices.set(key, notice)
    this.bySession.set(sessionId, notices)
    return notice
  }

  /** The sidecar's `notice_clear` frame; false when the key was not active. */
  clear(sessionId: string, key: string): boolean {
    const notices = this.bySession.get(sessionId)
    if (!notices?.delete(key)) return false
    if (!notices.size) this.bySession.delete(sessionId)
    return true
  }

  /** The sidecar's `notices_reset` frame (a new agent for the session); false when none were active. */
  reset(sessionId: string): boolean {
    return this.bySession.delete(sessionId)
  }

  /** The session's unexpired notices, oldest first. */
  list(sessionId: string): SessionNotice[] {
    const notices = this.bySession.get(sessionId)
    if (!notices) return []
    const now = this.now()
    for (const [key, n] of notices) if (n.expires_at !== null && n.expires_at <= now) notices.delete(key)
    return [...notices.values()]
  }

  /** Hygiene sweep: a deleted session's notices go with it. */
  sweep(exists: (sessionId: string) => boolean): void {
    for (const sid of this.bySession.keys()) if (!exists(sid)) this.bySession.delete(sid)
  }
}
