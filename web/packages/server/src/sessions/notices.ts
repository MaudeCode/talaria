import type { SessionNotice } from '@maudecode/talaria-web-contracts'
import { str } from '../util.js'

const LEVELS = new Set<SessionNotice['level']>(['info', 'warn', 'error', 'success'])

/** A stored notice, and whether it lapses when a new agent replaces the one that raised it. */
interface Entry { notice: SessionNotice; lapses: boolean }

/**
 * TAL-803: the Agent's active notices per session (session `notices`). A notice replaces the one with its key, so a
 * cached agent's later turns and a rebuilt agent's repeat never duplicate it; the Agent's clear, its TTL, or (for a
 * notice that lapses with its agent) a new agent removes it.
 * ponytail: in memory, like the cached agents that raise them; a server restart starts with none.
 */
export class SessionNotices {
  private readonly bySession = new Map<string, Map<string, Entry>>()

  constructor(private readonly now: () => number) {}

  /** The sidecar's `notice` frame: the notice it stored, null when it carries no text or changes nothing shown. */
  add(sessionId: string, frame: Record<string, unknown>): SessionNotice | null {
    const text = str(frame.text).trim()
    if (!text) return null
    const key = str(frame.key) || str(frame.id) || text
    const level = LEVELS.has(frame.level as SessionNotice['level']) ? (frame.level as SessionNotice['level']) : 'info'
    const ttl = frame.kind === 'ttl' && typeof frame.ttl_ms === 'number' && frame.ttl_ms > 0 ? frame.ttl_ms : null
    const notice: SessionNotice = { key, level, text, expires_at: ttl === null ? null : this.now() + ttl / 1000 }
    const entries = this.bySession.get(sessionId) ?? new Map<string, Entry>()
    const prior = entries.get(key)?.notice
    entries.set(key, { notice, lapses: frame.lapses_with_agent !== false })
    this.bySession.set(sessionId, entries)
    if (prior?.level === notice.level && prior.text === notice.text && prior.expires_at === null && notice.expires_at === null) return null
    return notice
  }

  /** The sidecar's `notice_clear` frame; false when the key was not active. */
  clear(sessionId: string, key: string): boolean {
    const entries = this.bySession.get(sessionId)
    if (!entries?.delete(key)) return false
    if (!entries.size) this.bySession.delete(sessionId)
    return true
  }

  /** The sidecar's `notices_reset` frame (a new agent for the session): drops what lapses with the old one. */
  reset(sessionId: string): boolean {
    const entries = this.bySession.get(sessionId)
    if (!entries) return false
    let dropped = false
    for (const [key, entry] of entries) if (entry.lapses) dropped = entries.delete(key) || dropped
    if (!entries.size) this.bySession.delete(sessionId)
    return dropped
  }

  /** The session's unexpired notices, oldest first. */
  list(sessionId: string): SessionNotice[] {
    const entries = this.bySession.get(sessionId)
    if (!entries) return []
    const now = this.now()
    for (const [key, { notice }] of entries) if (notice.expires_at !== null && notice.expires_at <= now) entries.delete(key)
    return [...entries.values()].map((e) => e.notice)
  }

  /** Hygiene sweep: a deleted session's notices go with it. */
  sweep(exists: (sessionId: string) => boolean): void {
    for (const sid of this.bySession.keys()) if (!exists(sid)) this.bySession.delete(sid)
  }
}
