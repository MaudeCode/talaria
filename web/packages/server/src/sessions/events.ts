import type { WebAudioCompletion } from '@maudecode/talaria-web-contracts'
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
  web_audio?: WebAudioCompletion[]
}

/** The bound on `web_audio` per frame, which also bounds the completions retained for a reconnect. */
const WEB_AUDIO_LIMIT = 32

export type SessionEventsListener = (profile: string | null) => void

export class SessionEventBus {
  private version = 0
  private readonly subscribers = new Set<{ pending: SessionsChangedEvent | null; wake: (() => void) | null }>()
  private readonly listeners = new Set<SessionEventsListener>()
  /** TAL-1954: recent completion events, so a reconnect with a cursor can still play one published while it was away. */
  private readonly completions: SessionsChangedEvent[] = []
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
    if (pending.web_audio?.length) incoming = { ...incoming, web_audio: [...pending.web_audio, ...(incoming.web_audio ?? [])].slice(-WEB_AUDIO_LIMIT) }
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

  publish(reason = 'session_changed', opts: { profile?: string | null; sessionId?: string | null; webAudio?: WebAudioCompletion } = {}): void {
    const payload = this.payload(reason, opts.profile ?? null, opts.sessionId ?? null)
    if (opts.webAudio) {
      payload.web_audio = [opts.webAudio]
      this.completions.push(payload)
      if (this.completions.length > WEB_AUDIO_LIMIT) this.completions.shift()
    }
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

  /** Retained completion events after `cursor` through `through`, each with one unexpired `web_audio` entry. */
  completionsSince(cursor: number, through: number): SessionsChangedEvent[] {
    const now = Date.now()
    return this.completions.filter((event) => event.version > cursor && event.version <= through && (event.web_audio?.[0]?.expires_at ?? 0) > now)
  }

  /**
   * Subscribe with a one-slot queue; `next()` resolves with the coalesced pending event. `version` is the newest event
   * published before this subscription, so every later one reaches its queue.
   */
  subscribe(): { version: number; next: (signal?: AbortSignal) => Promise<SessionsChangedEvent | null>; close: () => void } {
    const sub: { pending: SessionsChangedEvent | null; wake: (() => void) | null } = { pending: null, wake: null }
    this.subscribers.add(sub)
    return {
      version: this.version,
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
