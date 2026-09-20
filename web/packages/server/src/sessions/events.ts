/**
 * Session-list change bus (Python `api/session_events.py`): a version counter,
 * a coalescing one-slot queue per subscriber, and synchronous listeners.
 */
export interface SessionsChangedEvent {
  type: 'sessions_changed'
  version: number
  reason: string
  profile?: string
  session_id?: string
}

export type SessionEventsListener = (profile: string | null) => void

export class SessionEventBus {
  private version = 0
  private readonly subscribers = new Set<{ pending: SessionsChangedEvent | null; wake: (() => void) | null }>()
  private readonly listeners = new Set<SessionEventsListener>()
  readonly isRootAlias: (profile: string) => boolean

  constructor(isRootAlias: (profile: string) => boolean = (p) => p === 'default') {
    this.isRootAlias = isRootAlias
  }

  private payload(reason: string, profile: string | null, sessionId: string | null): SessionsChangedEvent {
    this.version += 1
    const payload: SessionsChangedEvent = { type: 'sessions_changed', version: this.version, reason }
    const normalizedProfile = (profile ?? '').trim()
    if (normalizedProfile && !this.isRootAlias(normalizedProfile)) payload.profile = normalizedProfile
    const normalizedSid = (sessionId ?? '').trim()
    if (normalizedSid) payload.session_id = normalizedSid
    return payload
  }

  /** Merge a pending event with an incoming one without dropping profile-relevant work. */
  static coalesce(pending: SessionsChangedEvent | null, incoming: SessionsChangedEvent): SessionsChangedEvent {
    if (!pending) return incoming
    if ((pending.profile ?? null) === (incoming.profile ?? null)) {
      if ((pending.session_id ?? null) === (incoming.session_id ?? null)) return incoming
      const merged = { ...incoming }
      Reflect.deleteProperty(merged, 'session_id')
      return merged
    }
    const merged = { ...incoming }
    Reflect.deleteProperty(merged, 'profile')
    Reflect.deleteProperty(merged, 'session_id')
    return merged
  }

  publish(reason = 'session_changed', opts: { profile?: string | null; sessionId?: string | null } = {}): void {
    const payload = this.payload(reason, opts.profile ?? null, opts.sessionId ?? null)
    for (const sub of this.subscribers) {
      sub.pending = SessionEventBus.coalesce(sub.pending, payload)
      const wake = sub.wake
      sub.wake = null
      wake?.()
    }
    for (const listener of this.listeners) {
      try { listener(opts.profile ?? null) } catch { /* listener failures never break publishers */ }
    }
  }

  addListener(listener: SessionEventsListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Subscribe with a one-slot queue; `next()` resolves with the coalesced pending event. */
  subscribe(): { next: (signal?: AbortSignal) => Promise<SessionsChangedEvent | null>; close: () => void } {
    const sub: { pending: SessionsChangedEvent | null; wake: (() => void) | null } = { pending: null, wake: null }
    this.subscribers.add(sub)
    return {
      next: (signal) =>
        new Promise((resolve) => {
          const take = () => { const p = sub.pending; sub.pending = null; resolve(p) }
          if (sub.pending) { take(); return }
          if (signal?.aborted) { resolve(null); return }
          sub.wake = take
          signal?.addEventListener('abort', () => { if (sub.wake === take) { sub.wake = null; resolve(null) } }, { once: true })
        }),
      close: () => { this.subscribers.delete(sub) },
    }
  }
}
