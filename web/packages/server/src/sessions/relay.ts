/**
 * Talaria Relay: publisher pairing, profile enrollment, browser presence
 * leases, and the best-effort snapshot publisher (Python
 * `api/talaria_relay.py`). Snapshots are Ed25519-signed complete states per
 * enrolled profile; failures back off and never block a turn. Each session that
 * first appears in an enrolled profile is announced once with a signed
 * session-started event (contracts/fixtures/publisher-session-started.json).
 */
import { readCapped } from '../http/capped.js'
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { atomicWriteText } from '../fs/atomic.js'
import type { ActiveRun, StreamRegistry } from './streams.js'
import type { PendingPrompts } from './pending.js'
import type { SessionStore } from './store.js'
import { str } from '../util.js'

export const PRESENCE_LEASE_SECONDS = 90
const PRESENCE_MAX_LEASES = 256
const PRESENCE_TAB_RE = /^[A-Za-z0-9_-]{8,64}$/
const DEFAULT_RELAY_URL = 'https://relay.talaria.kil.dev'
const TERMINAL_RETENTION_S = 15 * 60
const REQUEST_TIMEOUT_MS = 10_000
// Sessions started longer ago than this are never announced, which bounds the started ledger.
const STARTED_WINDOW_MS = 24 * 60 * 60 * 1000
const b64u = (data: Buffer): string => data.toString('base64url')

export class RelayPairingError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

class RelayHttpError extends Error {
  readonly retryable: boolean
  constructor(readonly status: number) {
    super(`Talaria relay returned HTTP ${String(status)}`)
    this.retryable = [408, 425, 429].includes(status) || status >= 500
  }
}

export interface RelayProfile { identity: string; profile_id: string }
export interface RelayConfig { url: string; publisher_id: string; key_id: string; private_key_path: string; profiles: Record<string, RelayProfile> }

/** Python `RelayConfig._validated_origin`: a bare origin with no path, query, credentials, or fragment. */
export function validatedOrigin(raw: string, httpsOnly = false): string {
  const value = raw.trim().replace(/\/+$/, '')
  let u: URL
  try { u = new URL(value) } catch { throw new Error(`value must be an ${httpsOnly ? 'HTTPS' : 'HTTP(S)'} origin`) }
  const schemes = httpsOnly ? ['https:'] : ['http:', 'https:']
  if (!schemes.includes(u.protocol) || !u.host || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || value.includes('?') || value.includes('#')) {
    throw new Error(`value must be an ${httpsOnly ? 'HTTPS' : 'HTTP(S)'} origin`)
  }
  return value
}

export function relayStatePath(stateDir: string): string { return join(stateDir, 'talaria-relay.json') }

/** Python `RelayConfig.from_state`: null when absent or a v1 file (registration is required again); throws on corruption. */
export function loadRelayConfig(stateDir: string): RelayConfig | null {
  const path = relayStatePath(stateDir)
  if (!existsSync(path)) return null
  const values: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('saved relay configuration is not an object')
  const v = values as Record<string, unknown>
  if (v.version !== 2) return null
  const profiles = v.profiles
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles) || !Object.keys(profiles).length) throw new Error('saved relay profiles are invalid')
  const normalized: Record<string, RelayProfile> = {}
  for (const [name, profile] of Object.entries(profiles as Record<string, unknown>)) {
    const p = profile as Record<string, unknown> | null
    if (!name || !p || typeof p !== 'object' || typeof p.identity !== 'string' || !p.identity || typeof p.profile_id !== 'string' || !p.profile_id) throw new Error('saved relay profiles are invalid')
    normalized[name] = { identity: p.identity, profile_id: p.profile_id }
  }
  return { url: validatedOrigin(str(v.url)), publisher_id: validatedOrigin(str(v.publisher_id)), key_id: str(v.key_id), private_key_path: str(v.private_key_path), profiles: normalized }
}

export function saveRelayConfig(stateDir: string, config: RelayConfig): void {
  const payload = { key_id: config.key_id, private_key_path: config.private_key_path, profiles: sortedProfiles(config.profiles), publisher_id: config.publisher_id, url: config.url, version: 2 }
  mkdirSync(stateDir, { recursive: true })
  atomicWriteText(relayStatePath(stateDir), JSON.stringify(payload, null, 2) + '\n')
}

function sortedProfiles(profiles: Record<string, RelayProfile>): Record<string, RelayProfile> {
  return Object.fromEntries(Object.keys(profiles).sort().map((k) => [k, { identity: profiles[k]!.identity, profile_id: profiles[k]!.profile_id }]))
}

/** Python `_profile_identity`: a persistent `pfi_<32 hex>` per profile home, minted on first use (0600). */
export function profileIdentity(profileHome: string): string {
  const path = join(profileHome, '.talaria-relay-profile-id')
  let identity: string
  if (existsSync(path)) identity = readFileSync(path, 'utf8').trim()
  else {
    identity = `pfi_${randomUUID().replace(/-/g, '')}`
    atomicWriteText(path, identity + '\n', { mode: 0o600 })
  }
  if (!/^pfi_[0-9a-f]{32}$/.test(identity)) throw new Error('invalid Talaria Relay profile identity')
  return identity
}

function loadKey(path: string): KeyObject {
  const key = createPrivateKey(readFileSync(path))
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Talaria publisher key must be an Ed25519 private key')
  return key
}

function signedHeaders(key: KeyObject, keyId: string, method: string, path: string, body: string, now: () => number): Record<string, string> {
  const timestamp = String(Math.floor(now()))
  const nonce = randomUUID().replace(/-/g, '')
  const signed = [method, path, timestamp, nonce, b64u(createHash('sha256').update(body, 'utf8').digest())].join('\n')
  return { 'Content-Type': 'application/json', 'X-Talaria-Key-Id': keyId, 'X-Talaria-Timestamp': timestamp, 'X-Talaria-Nonce': nonce, 'X-Talaria-Signature': b64u(cryptoSign(null, Buffer.from(signed, 'utf8'), key)) }
}

// ── presence leases ───────────────────────────────────────────────────────

/** Profile-scoped browser activity leases; a fresh active lease mutes alerts for that profile. */
export class PresenceLeases {
  private readonly leases = new Map<string, { expires: number; seq: number; active: boolean }>()
  constructor(private readonly now: () => number) {}

  private prune(now: number): void {
    for (const [key, entry] of this.leases) if (entry.expires <= now) this.leases.delete(key)
  }

  private apply(profile: string, tabId: string, seq: number, active: boolean): void {
    const now = this.now()
    this.prune(now)
    const key = `${profile}\n${tabId}`
    const current = this.leases.get(key)
    if (current && seq <= current.seq) return
    this.leases.delete(key)
    if (this.leases.size >= PRESENCE_MAX_LEASES) this.leases.delete(this.leases.keys().next().value!)
    this.leases.set(key, { expires: now + PRESENCE_LEASE_SECONDS, seq, active })
  }

  renew(profile: string, tabId: string, seq = 1): void { this.apply(profile, tabId, seq, true) }
  revoke(profile: string, tabId: string, seq = 1): void { this.apply(profile, tabId, seq, false) }

  has(profile: string): boolean {
    this.prune(this.now())
    for (const [key, entry] of this.leases) if (entry.active && key.startsWith(`${profile}\n`)) return true
    return false
  }

  /** Python `update_presence`. */
  update(body: unknown, profile: string): { ok: true; lease_seconds: number } {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RelayPairingError('Invalid presence request', 400)
    const { tab_id: tabId, active, seq } = body as Record<string, unknown>
    if (typeof tabId !== 'string' || !PRESENCE_TAB_RE.test(tabId) || typeof active !== 'boolean' || typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq > 2 ** 53) {
      throw new RelayPairingError('Invalid presence request', 400)
    }
    const name = profile.trim()
    if (!name) throw new RelayPairingError('Hermes profile is unavailable', 403)
    if (active) this.renew(name, tabId, seq)
    else this.revoke(name, tabId, seq)
    return { ok: true, lease_seconds: active ? PRESENCE_LEASE_SECONDS : 0 }
  }
}

// ── publisher ─────────────────────────────────────────────────────────────

export interface RelayPublisherDeps {
  registry: StreamRegistry
  pending: PendingPrompts
  store: SessionStore
  presence: PresenceLeases
  profileHome: (profile: string) => string
  profilesMatch: (row: string | null | undefined, active: string | null | undefined) => boolean
  /** The profile's messageful Agent `state.db` sessions (`readImportableAgentSessionRows`). */
  agentSessions: (profile: string) => Record<string, unknown>[]
  fetch: () => typeof fetch
  now: () => number
  log: (line: string) => void
}

/** Per relay profile scope: sessions started before `floor` (first tracking) are never announced. */
type StartedLedger = Map<string, { floor: number; sessions: Map<string, { startedAt: number; sent: boolean }> }>

export interface RelayState { sessionId: string; streamId: string | null; eventId: string; revision: number; title: string; phase: string; updatedAt: number; deepLink: string; alertEligible?: false }

/** Python `TalariaRelayPublisher`: coalesces changes into signed complete snapshots with capped backoff. */
export class RelayPublisher {
  private readonly key: KeyObject
  private readonly revisionPath: string
  private readonly startedPath: string
  private startedUnsupportedLogged = false
  private lastRevision = 0
  private terminal = new Map<string, ActiveRun & { relay_phase: string; terminal_at: number }>()
  private readonly disabledProfiles = new Set<string>()
  private readonly views = new Map<string, { profile: string | null; through: number }>()
  private viewedUnsupportedLogged = false
  private alertEligibilitySupported = true
  private stopped = false
  private loop: Promise<void> | null = null
  private dirty = false
  private wake: (() => void) | null = null
  private timer: NodeJS.Timeout | null = null
  private failures = 0

  constructor(readonly config: RelayConfig, private readonly deps: RelayPublisherDeps) {
    this.key = loadKey(config.private_key_path)
    this.revisionPath = join(dirname(config.private_key_path), 'talaria-relay-revision')
    this.startedPath = join(dirname(config.private_key_path), 'talaria-relay-started.json')
    try { this.lastRevision = Number.parseInt(readFileSync(this.revisionPath, 'utf8'), 10) || 0 } catch { this.lastRevision = 0 }
  }

  /** Carry unpublished terminal state, queued views, and the revision floor from the publisher being replaced. */
  inherit(previous: RelayPublisher): void {
    for (const [sid, run] of previous.terminal) this.terminal.set(sid, run)
    for (const [sid, view] of previous.views) this.views.set(sid, view)
    this.lastRevision = Math.max(this.lastRevision, previous.lastRevision)
  }

  start(publishInitial = true): void {
    if (this.loop) return
    this.loop = this.run()
    if (publishInitial) this.changed()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.wake?.()
  }

  changed(): void {
    this.dirty = true
    this.wake?.()
  }

  noteTerminal(streamId: string, phase: string): void {
    const run = this.deps.registry.activeRuns.get(streamId)
    const sid = str(run?.session_id).trim()
    if (!run || !sid) return
    this.terminal.set(sid, { ...run, relay_phase: phase, terminal_at: this.deps.now() })
    this.changed()
  }

  /** Queue a viewed acknowledgement; the loop sends it after the snapshot carrying the session's terminal state. */
  markViewed(sid: string, profile: string | null): void {
    this.views.set(sid, { profile, through: Math.floor(this.deps.now() * 1000) })
    this.changed()
  }

  /** Send the views queued before the snapshot just published, so the relay already holds every outcome they saw. */
  private async flushViews(ready: Map<string, { profile: string | null; through: number }>): Promise<void> {
    for (const [sid, view] of ready) {
      for (const [profile, cfg] of Object.entries(this.config.profiles)) {
        if (!this.deps.profilesMatch(view.profile, profile) || !this.publishes(profile, cfg)) continue
        const path = `/v1/publishers/${encodeURIComponent(this.config.publisher_id)}/profiles/${encodeURIComponent(cfg.profile_id)}/sessions/${encodeURIComponent(sid)}/viewed`
        try {
          await this.put(path, JSON.stringify({ through: view.through }))
        } catch (error) {
          if (!(error instanceof RelayHttpError) || error.retryable) throw error
          if (error.status === 404 && !this.viewedUnsupportedLogged) {
            this.viewedUnsupportedLogged = true
            this.deps.log('[relay] Talaria relay does not support viewed acknowledgements (HTTP 404); Live Activities clear only from the app')
          } else if (error.status !== 404) this.deps.log(`[relay] Talaria relay rejected a viewed acknowledgement (HTTP ${String(error.status)})`)
        }
      }
      if (this.views.get(sid) === view) this.views.delete(sid)
    }
  }

  private nextRevision(): number {
    this.lastRevision = Math.max(this.lastRevision + 1, Math.floor(this.deps.now() * 1000))
    return this.lastRevision
  }

  private sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      this.wake = () => { if (this.timer) clearTimeout(this.timer); this.timer = null; this.wake = null; resolve() }
      this.timer = setTimeout(() => { this.wake = null; this.timer = null; resolve() }, seconds * 1000)
      this.timer.unref()
    })
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      if (!this.dirty) await this.sleep(60)
      if (this.stopped) return
      this.dirty = false
      try {
        const ready = new Map(this.views)
        await this.publishSnapshot(true)
        await this.flushViews(ready)
        await this.publishStarted()
        if (this.failures) this.deps.log('[relay] Talaria relay snapshot recovered')
        this.failures = 0
      } catch (error) {
        if (error instanceof RelayHttpError && !error.retryable) {
          this.deps.log(`[relay] Talaria relay publisher stopped after permanent HTTP ${String(error.status)}`)
          return
        }
        this.failures += 1
        const delay = Math.min(5 * 2 ** Math.min(this.failures - 1, 6) * (0.8 + Math.random() * 0.4), 300)
        this.deps.log(`[relay] Talaria relay snapshot ${this.failures === 1 ? 'failed' : 'still failing'} (${(error as Error).message}); retrying in ${delay.toFixed(1)}s`)
        await this.sleep(delay)
        if (!this.stopped) this.dirty = true
      }
    }
  }

  /** Python `build_states`: one row per session with a live or recently terminal run in this profile. */
  buildStates(profile: string): RelayState[] {
    const cutoff = this.deps.now() - TERMINAL_RETENTION_S
    for (const [sid, run] of this.terminal) if (run.terminal_at < cutoff) this.terminal.delete(sid)
    const bySession = new Map<string, ActiveRun & { relay_phase?: string; terminal_at?: number }>()
    for (const run of this.deps.registry.activeRuns.values()) {
      if ((run as { health_only?: boolean }).health_only) continue
      const sid = run.session_id.trim()
      if (!sid) continue
      const current = bySession.get(sid)
      if (!current || run.started_at > current.started_at) bySession.set(sid, run)
    }
    for (const [sid, run] of this.terminal) if (!bySession.has(sid)) bySession.set(sid, run)
    const alertEligible = this.alertEligibilitySupported ? !this.deps.presence.has(profile) : true
    const states: RelayState[] = []
    for (const [sid, run] of bySession) {
      let session
      try { session = this.deps.store.get(sid, { metadataOnly: true }) } catch { continue }
      if (!this.deps.profilesMatch(session.profile, profile)) continue
      const revision = this.nextRevision()
      let phase = run.relay_phase ?? 'running'
      if (!['completed', 'failed', 'cancelled'].includes(phase) && this.deps.pending.approvalPending(sid).pending) phase = 'waiting_for_approval'
      if (phase === 'running' && this.deps.pending.clarifyPending(sid).pending) phase = 'waiting_for_input'
      if (phase === 'running' && run.phase.endsWith('starting')) phase = 'starting'
      // A finished run keeps the instant it ended, so a viewer who saw that turn covers it whenever the snapshot is built.
      const updatedAt = Math.floor((run.terminal_at ?? this.deps.now()) * 1000)
      const state: RelayState = { sessionId: sid, streamId: run.stream_id || null, eventId: `snapshot:${String(revision)}:${sid}`, revision, title: (session.title || 'Untitled').slice(0, 120), phase, updatedAt, deepLink: `/sessions/${encodeURIComponent(sid)}` }
      if (!alertEligible) state.alertEligible = false
      states.push(state)
    }
    if (states.length) atomicWriteText(this.revisionPath, `${String(this.lastRevision)}\n`)
    return states
  }

  async publishSnapshot(isolatePermanent = false): Promise<void> {
    let retryable: RelayHttpError | null = null
    for (const [profile, cfg] of Object.entries(this.config.profiles)) {
      if (!this.publishes(profile, cfg)) continue
      try {
        await this.publishProfileSnapshot(profile, cfg.profile_id)
      } catch (error) {
        if (!(error instanceof RelayHttpError) || !isolatePermanent) throw error
        if (error.retryable) { retryable ??= error; continue }
        this.disabledProfiles.add(cfg.profile_id)
        this.deps.log(`[relay] Talaria relay disabled profile after permanent HTTP ${String(error.status)}`)
      }
    }
    if (retryable) throw retryable
  }

  private publishes(profile: string, cfg: RelayProfile): boolean {
    if (cfg.identity) {
      try { if (profileIdentity(this.deps.profileHome(profile)) !== cfg.identity) return false } catch { return false }
    }
    return !this.disabledProfiles.has(cfg.profile_id)
  }

  /** Validation publish for one newly enrolled profile (Python `publish_profile`). */
  async publishProfile(profileId: string, expectedIdentity: string): Promise<void> {
    for (const [profile, cfg] of Object.entries(this.config.profiles)) {
      if (cfg.profile_id !== profileId) continue
      if (cfg.identity !== expectedIdentity || profileIdentity(this.deps.profileHome(profile)) !== expectedIdentity) throw new RelayPairingError('Hermes profile changed during relay enrollment', 409)
      await this.publishProfileSnapshot(profile, profileId)
      return
    }
    throw new RelayPairingError('Talaria Relay profile enrollment is unavailable', 502)
  }

  // The ledger is reread for every change, so a restarted or replacement publisher resends an unsent event under its ID.
  private loadStarted(): StartedLedger {
    const ledger: StartedLedger = new Map()
    let raw: unknown
    try { raw = JSON.parse(readFileSync(this.startedPath, 'utf8')) } catch { return ledger }
    const profiles = (raw as { profiles?: unknown } | null)?.profiles
    if (!Array.isArray(profiles)) return ledger
    for (const p of profiles as { profileId?: unknown; floor?: unknown; sessions?: unknown }[]) {
      if (typeof p?.profileId !== 'string' || typeof p.floor !== 'number' || !Array.isArray(p.sessions)) continue
      const sessions = new Map<string, { startedAt: number; sent: boolean }>()
      for (const e of p.sessions as { sessionId?: unknown; startedAt?: unknown; sent?: unknown }[]) {
        if (typeof e?.sessionId === 'string' && typeof e.startedAt === 'number') sessions.set(e.sessionId, { startedAt: e.startedAt, sent: e.sent === true })
      }
      ledger.set(p.profileId, { floor: p.floor, sessions })
    }
    return ledger
  }

  private saveStarted(ledger: StartedLedger): void {
    const profiles = [...ledger].map(([profileId, p]) => ({ profileId, floor: p.floor, sessions: [...p.sessions].map(([sessionId, e]) => ({ sessionId, startedAt: e.startedAt, sent: e.sent })) }))
    atomicWriteText(this.startedPath, JSON.stringify({ version: 1, profiles }) + '\n')
  }

  /** Record every messageful Web or Agent session that started in an enrolled profile since tracking began. */
  private observeStarted(): StartedLedger {
    const ledger = this.loadStarted()
    const nowMs = Math.floor(this.deps.now() * 1000)
    let changed = false
    let index: Record<string, unknown>[] = []
    try { index = this.deps.store.readIndexEntries() } catch { index = [] }
    for (const [profile, cfg] of Object.entries(this.config.profiles)) {
      if (!this.publishes(profile, cfg)) continue
      let entry = ledger.get(cfg.profile_id)
      if (!entry) { entry = { floor: nowMs, sessions: new Map() }; ledger.set(cfg.profile_id, entry); changed = true }
      const floor = Math.max(entry.floor, nowMs - STARTED_WINDOW_MS)
      for (const [sid, e] of entry.sessions) if (e.startedAt < floor) { entry.sessions.delete(sid); changed = true }
      // A compressed Agent chat keeps its lineage root's id and start, so later segments are not new sessions.
      let agent: Record<string, unknown>[] = []
      try { agent = this.deps.agentSessions(profile) } catch { agent = [] }
      const seen = [
        ...index.filter((row) => Number(row.message_count) > 0 && this.deps.profilesMatch(row.profile as string | null | undefined, profile)).map((row) => [row.session_id, row.created_at]),
        ...agent.map((row) => [row._lineage_root_id || row.id, row.started_at]),
      ]
      for (const [rawSid, created] of seen) {
        const sid = str(rawSid).trim()
        const startedAt = Math.floor(Number(created) * 1000)
        if (!sid || sid.length > 191 || !Number.isSafeInteger(startedAt) || startedAt < floor || entry.sessions.has(sid)) continue
        entry.sessions.set(sid, { startedAt, sent: false })
        changed = true
      }
    }
    if (changed) this.saveStarted(ledger)
    return ledger
  }

  /** Announce each newly observed session once, oldest first, to the relay scope of the profile that owns it. */
  async publishStarted(): Promise<void> {
    const ledger = this.observeStarted()
    for (const [profile, cfg] of Object.entries(this.config.profiles)) {
      if (!this.publishes(profile, cfg)) continue
      const unsent = [...(ledger.get(cfg.profile_id)?.sessions ?? [])].filter(([, e]) => !e.sent).sort((a, b) => a[1].startedAt - b[1].startedAt)
      for (const [sid, e] of unsent) {
        const path = `/v1/publishers/${encodeURIComponent(this.config.publisher_id)}/profiles/${encodeURIComponent(cfg.profile_id)}/sessions/${encodeURIComponent(sid)}/started`
        const body = JSON.stringify({ version: 1, eventId: `started:${sid}`, publisherId: this.config.publisher_id, profileId: cfg.profile_id, sessionId: sid, startedAt: e.startedAt })
        try {
          await this.put(path, body)
        } catch (error) {
          if (!(error instanceof RelayHttpError) || error.retryable) throw error
          if (error.status !== 404) this.deps.log(`[relay] Talaria relay rejected a session-started event (HTTP ${String(error.status)})`)
          else if (!this.startedUnsupportedLogged) {
            this.startedUnsupportedLogged = true
            this.deps.log('[relay] Talaria relay does not support session-started events (HTTP 404); devices refresh on their own schedule')
          }
        }
        const latest = this.loadStarted()
        const sent = latest.get(cfg.profile_id)?.sessions.get(sid)
        if (sent && !sent.sent) { sent.sent = true; this.saveStarted(latest) }
      }
    }
  }

  private async publishProfileSnapshot(profile: string, profileId: string): Promise<void> {
    const states = this.buildStates(profile)
    try {
      await this.putSnapshot(profileId, states)
    } catch (error) {
      if (!(error instanceof RelayHttpError) || error.retryable || !states.some((s) => 'alertEligible' in s)) throw error
      // A relay that predates alertEligible rejects unknown fields: resend eligible and stop stamping.
      for (const state of states) delete state.alertEligible
      await this.putSnapshot(profileId, states)
      this.alertEligibilitySupported = false
      this.deps.log(`[relay] Talaria relay rejected alertEligible (HTTP ${String(error.status)}); publishing alert-eligible snapshots only`)
    }
  }

  private async putSnapshot(profileId: string, states: RelayState[]): Promise<void> {
    const body = JSON.stringify({ snapshotId: `webui:${randomUUID().replace(/-/g, '')}`, states })
    await this.put(`/v1/publishers/${encodeURIComponent(this.config.publisher_id)}/profiles/${encodeURIComponent(profileId)}/snapshot`, body)
  }

  private async put(path: string, body: string): Promise<void> {
    let res: Response
    try {
      res = await this.deps.fetch()(this.config.url + path, { method: 'PUT', body, headers: signedHeaders(this.key, this.config.key_id, 'PUT', path, body, this.deps.now), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (error) {
      throw new Error(`Could not reach Talaria Relay: ${(error as Error).message}`)
    }
    if (!res.ok) throw new RelayHttpError(res.status)
  }
}

// ── pairing and lifecycle ─────────────────────────────────────────────────

export interface RelayServiceDeps extends RelayPublisherDeps {
  stateDir: string
  env: Record<string, string | undefined>
  canonicalProfile: (profile: string) => string
  addListener: (listener: () => void) => () => void
}

/** Owns the current publisher and the pairing state machine (Python module-level `_publisher` and friends). */
export class RelayService {
  readonly presence: PresenceLeases
  private publisher: RelayPublisher | null = null
  private candidate: RelayPublisher | null = null
  private unsubscribe: (() => void) | null = null
  private pairing: Promise<unknown> = Promise.resolve()
  private readonly clearedDeleted = new Set<string>()

  constructor(private readonly deps: RelayServiceDeps) { this.presence = deps.presence }

  current(): RelayPublisher | null { return this.publisher }

  /** Python `start_talaria_relay_publisher`: resume from saved state; invalid state disables the publisher. */
  start(): boolean {
    if (this.publisher) return true
    let candidate: RelayPublisher | null = null
    try {
      const config = loadRelayConfig(this.deps.stateDir)
      if (!config) return false
      candidate = new RelayPublisher(config, this.deps)
      this.candidate = candidate
      this.adopt(candidate, null)
      candidate.start(false)
      return true
    } catch (error) {
      candidate?.stop()
      this.publisher = null
      this.candidate = null
      this.deps.log(`[relay] Talaria relay publisher disabled: invalid configuration (${(error as Error).message})`)
      return false
    }
  }

  stop(): void {
    const previous = this.publisher
    this.publisher = null
    this.candidate = null
    this.unsubscribe?.()
    this.unsubscribe = null
    previous?.stop()
  }

  private adopt(candidate: RelayPublisher, previous: RelayPublisher | null): void {
    this.unsubscribe?.()
    this.unsubscribe = this.deps.addListener(() => { candidate.changed() })
    this.publisher = candidate
    this.candidate = null
    if (previous) { candidate.inherit(previous); previous.stop() }
  }

  /** A viewed session clears its finished runs on the relay; without a publisher there is nothing to clear. */
  markViewed(sid: string): void {
    const publisher = this.publisher ?? this.candidate
    publisher?.markViewed(sid, this.deps.store.get(sid, { metadataOnly: true }).profile)
  }

  /**
   * A deleted session can never be viewed, so its finished runs are cleared once, under the profile it had (the
   * store no longer knows it). Later lookups of the same id do not resend.
   */
  clearDeleted(sid: string, profile: string | null): void {
    const publisher = this.publisher ?? this.candidate
    if (!publisher || this.clearedDeleted.has(sid)) return
    // ponytail: grows by one id per deleted session per process; reset on restart is fine because the relay ack is idempotent.
    this.clearedDeleted.add(sid)
    publisher.markViewed(sid, profile)
  }

  /** Terminal turn events reach the relay even mid-swap (Python `note_talaria_terminal`). */
  noteTerminal(streamId: string, phase: string): void {
    if (!['completed', 'failed', 'cancelled'].includes(phase)) return
    const publisher = this.publisher ?? this.candidate
    publisher?.noteTerminal(streamId, phase)
    const current = this.publisher ?? this.candidate
    if (current && current !== publisher) current.noteTerminal(streamId, phase)
  }

  /** Python `configure_talaria_relay_publisher`: validate with a real snapshot before swapping publishers. */
  private async configure(config: RelayConfig, validate: { profileId: string; identity: string } | null): Promise<void> {
    const candidate = new RelayPublisher(config, this.deps)
    const previous = this.publisher
    this.candidate = candidate
    if (previous) candidate.inherit(previous)
    try {
      if (validate) await candidate.publishProfile(validate.profileId, validate.identity)
      else await candidate.publishSnapshot()
    } catch (error) {
      if (this.candidate === candidate) this.candidate = null
      throw new RelayPairingError(error instanceof RelayPairingError ? error.message : 'Could not publish the initial Talaria Relay snapshot', error instanceof RelayPairingError ? error.status : 502)
    }
    this.adopt(candidate, previous)
    candidate.start(false)
    candidate.changed()
  }

  /** Python `pair_talaria_relay`, serialised so concurrent enrollments preserve both mappings. */
  pair(body: unknown, profile: string, operator: boolean): Promise<{ ok: true; publisher_id: string }> {
    const run = this.pairing.then(() => this.pairUnlocked(body, profile, operator))
    this.pairing = run.catch(() => undefined)
    return run
  }

  private async relayPost(url: string, body: string, headers: Record<string, string>, reject: string): Promise<Record<string, unknown>> {
    let res: Response
    try {
      res = await this.deps.fetch()(url, { method: 'POST', body, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch {
      throw new RelayPairingError('Could not reach Talaria Relay', 502)
    }
    if (!res.ok) throw new RelayPairingError(`${reject} (HTTP ${String(res.status)})`, res.status >= 400 && res.status < 500 ? 409 : 502)
    let payload: unknown
    try { const raw = await readCapped(res, 256 * 1024); if (!raw) throw new Error('too large'); payload = JSON.parse(raw.toString('utf8')) } catch { throw new RelayPairingError('Talaria Relay returned an invalid response', 502) }
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}
  }

  private async pairUnlocked(body: unknown, rawProfile: string, operator: boolean): Promise<{ ok: true; publisher_id: string }> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RelayPairingError('Invalid pairing request', 400)
    const b = body as Record<string, unknown>
    const label = b.label || 'Talaria Web'
    if ([b.relay_url, b.publisher_id, b.publisher_invitation, label].some((v) => typeof v !== 'string')) throw new RelayPairingError('Missing relay pairing fields', 400)
    const invitation = b.publisher_invitation as string
    let relayUrl: string
    let publisherId: string
    try {
      relayUrl = validatedOrigin(b.relay_url as string, true)
      publisherId = validatedOrigin(b.publisher_id as string)
    } catch (error) {
      throw new RelayPairingError((error as Error).message, 400)
    }
    const allowed = (this.deps.env.HERMES_WEBUI_TALARIA_RELAY_URL ?? DEFAULT_RELAY_URL).trim().replace(/\/+$/, '')
    if (relayUrl !== allowed) throw new RelayPairingError('Untrusted Talaria Relay origin', 400)
    if (invitation.length < 1 || invitation.length > 256 || (label as string).length < 1 || (label as string).length > 80) throw new RelayPairingError('Invalid relay pairing fields', 400)
    const profile = rawProfile.trim()
    if (!profile) throw new RelayPairingError('Hermes profile is unavailable', 403)
    let canonical: string
    let identity: string
    try {
      canonical = this.deps.canonicalProfile(profile)
      identity = profileIdentity(this.deps.profileHome(canonical))
    } catch {
      throw new RelayPairingError('Hermes profile is unavailable', 403)
    }
    const existing = loadRelayConfig(this.deps.stateDir)
    if (existing) {
      if (existing.url !== relayUrl || existing.publisher_id !== publisherId) throw new RelayPairingError('This Hermes server is registered to a different relay', 409)
      const known = existing.profiles[canonical]
      const profileId = known?.identity === identity ? known.profile_id : `prf_${randomUUID().replace(/-/g, '')}`
      const requestBody = JSON.stringify({ invitation, publisherId, profileId })
      const path = '/v1/pairings/profile/redeem'
      const payload = await this.relayPost(existing.url + path, requestBody, signedHeaders(loadKey(existing.private_key_path), existing.key_id, 'POST', path, requestBody, this.deps.now), 'Talaria Relay rejected the profile enrollment')
      if (payload.protocolVersion !== 2 || payload.publisherId !== publisherId || payload.profileId !== profileId) throw new RelayPairingError('Talaria Relay returned an invalid response', 502)
      const config: RelayConfig = { ...existing, profiles: { ...existing.profiles, [canonical]: { identity, profile_id: profileId } } }
      saveRelayConfig(this.deps.stateDir, config)
      await this.configure(config, { profileId, identity })
      return { ok: true, publisher_id: publisherId }
    }
    if (!operator) throw new RelayPairingError('An owner must register this Hermes server with Talaria Relay before profile enrollment', 409)
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const profileId = `prf_${randomUUID().replace(/-/g, '')}`
    const publicRaw = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url')
    const payload = await this.relayPost(relayUrl + '/v1/pairings/publisher/redeem', JSON.stringify({ invitation, publisherId, profileId, label, publicKey: b64u(publicRaw) }), { 'Content-Type': 'application/json' }, 'Talaria Relay rejected server registration')
    const keyId = payload.keyId
    const pairedPublisher = payload.publisherId
    const pairedProfile = payload.profileId
    const preserved = payload.profileIdPreserved
    if (payload.protocolVersion !== 2 || typeof keyId !== 'string' || !keyId || typeof pairedPublisher !== 'string' || typeof pairedProfile !== 'string' || !pairedProfile || typeof preserved !== 'boolean' || (pairedProfile !== profileId && !preserved)) {
      throw new RelayPairingError('Talaria Relay returned an invalid response', 502)
    }
    let finalPublisher: string
    try { finalPublisher = validatedOrigin(pairedPublisher) } catch { throw new RelayPairingError('Talaria Relay returned an invalid response', 502) }
    const keyPath = join(this.deps.stateDir, `talaria-relay-publisher-${createHash('sha256').update(keyId, 'utf8').digest('hex').slice(0, 16)}.pem`)
    mkdirSync(this.deps.stateDir, { recursive: true })
    atomicWriteText(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 })
    const config: RelayConfig = { url: relayUrl, publisher_id: finalPublisher, key_id: keyId, private_key_path: keyPath, profiles: { [canonical]: { identity, profile_id: pairedProfile } } }
    saveRelayConfig(this.deps.stateDir, config)
    await this.configure(config, { profileId: pairedProfile, identity })
    return { ok: true, publisher_id: finalPublisher }
  }
}
