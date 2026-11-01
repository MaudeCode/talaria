import type { SessionEventBus } from './events.js'
import { filterAsync } from '../util.js'
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
import { readFileSync, statSync } from 'node:fs'
import { z } from 'zod'
import type { DocumentBackend } from './storage/backend.js'
import { updateDocument } from './storage/document.js'
import { FEEDBACK_ATTACHMENT_LIMITS, type SessionActivityPhase } from '@maudecode/talaria-web-contracts'
import type { BackgroundActivity } from './background-tasks.js'
import type { ActiveRun, StreamRegistry } from './streams.js'
import type { PendingPrompts } from './pending.js'
import type { Session } from './session.js'
import type { SessionPrefixIndex } from './prefix-index.js'
import type { SessionStore } from './store.js'
import { str } from '../util.js'

export const PRESENCE_LEASE_SECONDS = 90
export const PRESENCE_MAX_LEASES = 256
/** How long a tab's sequence fence outlives its lease, so a reloaded tab whose clock moved back recovers. */
export const PRESENCE_FENCE_SECONDS = 15 * 60
const PRESENCE_TAB_RE = /^[A-Za-z0-9_-]{8,64}$/
const DEFAULT_RELAY_URL = 'https://relay.talaria.kil.dev'
const TERMINAL_RETENTION_S = 15 * 60
const REQUEST_TIMEOUT_MS = 10_000
// Sessions started longer ago than this are never announced, which bounds the started ledger.
const STARTED_WINDOW_MS = 24 * 60 * 60 * 1000
const b64u = (data: Buffer): string => data.toString('base64url')

export class RelayPairingError extends Error {
  constructor(message: string, readonly status: number, readonly extra: Record<string, unknown> = {}) { super(message) }
}

class RelayHttpError extends Error {
  readonly retryable: boolean
  constructor(readonly status: number) {
    super(`Talaria relay returned HTTP ${String(status)}`)
    this.retryable = [408, 425, 429].includes(status) || status >= 500
  }
}

const UPLOAD_TIMEOUT_MS = 120_000
const AdmissionIndex = z.number().int().nonnegative().max(FEEDBACK_ATTACHMENT_LIMITS.maxAttachments - 1)
/** Relay's per-entry answer to a feedback manifest (relay/docs/http-api.md, Attachments). */
const FeedbackAdmissionSchema = z.union([
  z.object({ index: AdmissionIndex, status: z.literal('accepted'), uploadToken: z.string().min(1).max(256) }),
  z.object({ index: AdmissionIndex, status: z.enum(['stored', 'missing']) }),
  z.object({ index: AdmissionIndex, status: z.literal('refused'), reason: z.enum(['tier', 'quota', 'disabled']) }),
])
export type FeedbackAdmission = z.infer<typeof FeedbackAdmissionSchema>
const FeedbackAcceptedSchema = z.object({ reportId: z.string().min(1).max(256), attachments: z.array(FeedbackAdmissionSchema).max(FEEDBACK_ATTACHMENT_LIMITS.maxAttachments).optional() })

export interface RelayProfile { identity: string; profile_id: string }
export interface RelayConfig { url: string; publisher_id: string; key_id: string; private_key_path: string; private_key_document?: string; profiles: Record<string, RelayProfile> }

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

/** Python `RelayConfig.from_state`: null when absent or a v1 file (registration is required again); throws on corruption. */
export async function loadRelayConfig(documents: DocumentBackend): Promise<RelayConfig | null> {
  const record = await documents.get('relay', 'config')
  if (!record) return null
  const values = record.value
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
  return { url: validatedOrigin(str(v.url)), publisher_id: validatedOrigin(str(v.publisher_id)), key_id: str(v.key_id), private_key_path: str(v.private_key_path), ...(typeof v.private_key_document === 'string' ? { private_key_document: v.private_key_document } : {}), profiles: normalized }
}

export async function saveRelayConfig(documents: DocumentBackend, config: RelayConfig): Promise<void> {
  const payload = { key_id: config.key_id, private_key_path: config.private_key_path, profiles: sortedProfiles(config.profiles), publisher_id: config.publisher_id, url: config.url, version: 2 }
  const value = { ...payload, ...(config.private_key_document ? { private_key_document: config.private_key_document } : {}) }
  await updateDocument(documents, 'relay', 'config', () => ({ value, result: undefined }), { replaceInvalid: true })
}

function sortedProfiles(profiles: Record<string, RelayProfile>): Record<string, RelayProfile> {
  return Object.fromEntries(Object.keys(profiles).sort().map((k) => [k, { identity: profiles[k]!.identity, profile_id: profiles[k]!.profile_id }]))
}

// The started ledger records announcements; deletions need a separate, non-expiring delivery outbox.
const DeletedViewSchema = z.object({
  id: z.string().min(1), sessionId: z.string().min(1), profile: z.string().min(1),
  through: z.number().int().nonnegative(), identity: z.string().nullable(),
  scope: z.object({ url: z.string(), publisherId: z.string(), profileId: z.string() }).nullable(),
})
type DeletedView = z.infer<typeof DeletedViewSchema>
interface QueuedView { profile: string | null; through: number; deleted?: DeletedView }
const DeletedViewsSchema = z.object({ version: z.literal(1), views: z.array(DeletedViewSchema) })

// A staged deletion cannot clear a session that survived a failed removal or a restart before removal.
async function hasSessionData(store: SessionStore, sid: string): Promise<boolean> {
  if (store.sessions.has(sid)) return true
  return (await store.exists(sid))
}

function parseDeletedViews(raw: unknown): DeletedView[] { return raw === undefined ? [] : DeletedViewsSchema.parse(raw).views }

async function loadDeletedViews(documents: DocumentBackend): Promise<DeletedView[]> { return parseDeletedViews((await documents.get('relay', 'deleted'))?.value) }

async function mutateDeletedViews<T>(documents: DocumentBackend, edit: (views: DeletedView[]) => T | Promise<T>): Promise<T> {
  return (await updateDocument(documents, 'relay', 'deleted', async (raw) => {
    const views = parseDeletedViews(raw)
    const result = await edit(views)
    return { value: { version: 1, views }, result }
  }))
}

/** The profile identity lives in the selected backend, with the JSON adapter retaining its old private file. */
export async function profileIdentity(deps: Pick<RelayPublisherDeps, 'documents' | 'profileHome'>, profile: string): Promise<string> {
  if (!statSync(deps.profileHome(profile)).isDirectory()) throw new Error('Hermes profile is unavailable')
  return (await updateDocument(deps.documents, 'relay-identities', profile, (raw) => {
    const identity = typeof raw === 'string' ? raw.trim() : `pfi_${randomUUID().replace(/-/g, '')}`
    if (!/^pfi_[0-9a-f]{32}$/.test(identity)) throw new Error('invalid Talaria Relay profile identity')
    return { value: typeof raw === 'string' ? raw : identity + '\n', result: identity }
  }))
}

async function loadKey(documents: DocumentBackend, config: RelayConfig): Promise<KeyObject> {
  const value = config.private_key_document ? (await documents.get('relay-keys', config.private_key_document))?.value : readFileSync(config.private_key_path, 'utf8')
  if (typeof value !== 'string') throw new Error('Talaria publisher key is missing')
  const key = createPrivateKey(value)
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

/**
 * Profile-scoped browser activity leases; a fresh active lease mutes alerts for that profile.
 * Each tab's entry also fences its sequence number for PRESENCE_FENCE_SECONDS past lease expiry,
 * so a delayed lower sequence stays rejected. At most PRESENCE_MAX_LEASES tabs are kept; the least
 * recently updated tab is evicted first, which drops its fence too.
 */
export class PresenceLeases {
  private readonly leases = new Map<string, { expires: number; seq: number; active: boolean }>()
  constructor(private readonly now: () => number) {}

  private apply(profile: string, tabId: string, seq: number, active: boolean): void {
    const now = this.now()
    for (const [key, entry] of this.leases) if (entry.expires + PRESENCE_FENCE_SECONDS <= now) this.leases.delete(key)
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
    const now = this.now()
    for (const [key, entry] of this.leases) if (entry.active && entry.expires > now && key.startsWith(`${profile}\n`)) return true
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
  documents: DocumentBackend
  registry: StreamRegistry
  pending: PendingPrompts
  store: SessionStore
  presence: PresenceLeases
  background?: BackgroundActivity
  activitySummary?: (session: Session) => ReturnType<SessionPrefixIndex['activitySummary']>
  profileHome: (profile: string) => string
  profilesMatch: (row: string | null | undefined, active: string | null | undefined) => boolean
  /** The profile's messageful Agent `state.db` sessions (`readImportableAgentSessionRows`). */
  agentSessions: (profile: string) => Promise<Record<string, unknown>[]>
  fetch: () => typeof fetch
  now: () => number
  log: (line: string) => void
}

/** Per relay profile scope: sessions started before `floor` (first tracking) are never announced. */
type StartedLedger = Map<string, { floor: number; sessions: Map<string, { startedAt: number; sent: boolean }> }>

export interface RelayState { sessionId: string; streamId: string | null; eventId: string; revision: number; title: string; phase: string; activityPhase?: SessionActivityPhase; startedAt: number; updatedAt: number; deepLink: string; alertEligible?: false }

/** Python `TalariaRelayPublisher`: coalesces changes into signed complete snapshots with capped backoff. */
export class RelayPublisher {
  private key!: KeyObject
  private startedUnsupportedLogged = false
  private lastRevision = 0
  private terminal = new Map<string, ActiveRun & { relay_phase: string; terminal_at: number }>()
  private readonly disabledProfiles = new Set<string>()
  private readonly views = new Map<string, QueuedView>()
  private viewedUnsupportedLogged = false
  private alertEligibilitySupported = true
  private stopped = false
  private loop: Promise<void> | null = null
  private dirty = false
  private wake: (() => void) | null = null
  private timer: NodeJS.Timeout | null = null
  private failures = 0

  constructor(readonly config: RelayConfig, private readonly deps: RelayPublisherDeps) {}

  async initialize(): Promise<void> {
    this.key = await loadKey(this.deps.documents, this.config)
    try { await this.mutateStarted((ledger) => { this.trackProfiles(ledger) }) } catch { /* the first pass retries */ }
    try { this.lastRevision = Number.parseInt(str((await this.deps.documents.get('relay', 'revision'))?.value), 10) || 0 } catch { this.lastRevision = 0 }
  }

  /** Carry unpublished terminal state, queued views, and the revision floor from the publisher being replaced. */
  inherit(previous: RelayPublisher): void {
    for (const [sid, run] of previous.terminal) this.terminal.set(sid, run)
    for (const [sid, view] of previous.views) this.views.set(sid, view)
    this.lastRevision = Math.max(this.lastRevision, previous.lastRevision)
  }

  async start(publishInitial = true): Promise<void> {
    if (this.loop) return
    this.loop = this.run()
    if (publishInitial || (await loadDeletedViews(this.deps.documents)).length) this.changed()
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

  /** Bind an unconfigured deletion once, before sending, so retries cannot cross relay or profile identities. */
  private async pendingDeleted(): Promise<DeletedView[]> {
    const views = await mutateDeletedViews(this.deps.documents, async (views) => {
      for (const view of views) {
        if (view.scope) continue
        const cfg = this.config.profiles[view.profile]
        if (!cfg || (view.identity !== null && cfg.identity !== view.identity) || !await this.publishes(view.profile, cfg)) continue
        view.identity = cfg.identity
        view.scope = { url: this.config.url, publisherId: this.config.publisher_id, profileId: cfg.profile_id }
      }
      return views
    })
    return filterAsync(views, async (view) => !await hasSessionData(this.deps.store, view.sessionId))
  }

  /** Send the views queued before the snapshot just published, so the relay already holds every outcome they saw. */
  private async flushViews(ready: readonly (readonly [string, QueuedView])[]): Promise<void> {
    for (const [sid, view] of ready) {
      if (view.deleted && (await hasSessionData(this.deps.store, sid))) continue
      let accepted = false
      for (const [profile, cfg] of Object.entries(this.config.profiles)) {
        if (!this.deps.profilesMatch(view.profile, profile) || !(await this.publishes(profile, cfg))) continue
        if (view.deleted && (view.deleted.identity !== cfg.identity || view.deleted.scope?.url !== this.config.url || view.deleted.scope.publisherId !== this.config.publisher_id || view.deleted.scope.profileId !== cfg.profile_id)) continue
        const path = `/v1/publishers/${encodeURIComponent(this.config.publisher_id)}/profiles/${encodeURIComponent(cfg.profile_id)}/sessions/${encodeURIComponent(sid)}/viewed`
        try {
          await this.put(path, JSON.stringify({ through: view.through }))
          if (view.deleted && !await hasSessionData(this.deps.store, sid)) {
            const revision = (await this.reserveRevisions(1))[0]!
            await this.put(path.replace(/\/viewed$/, '/activity'), JSON.stringify({ eventId: `deleted:${view.deleted.id}`, revision, state: null }))
          }
          accepted = true
        } catch (error) {
          if (!(error instanceof RelayHttpError) || error.retryable) throw error
          if (error.status === 404 && !this.viewedUnsupportedLogged) {
            this.viewedUnsupportedLogged = true
            this.deps.log('[relay] Talaria relay does not support viewed acknowledgements (HTTP 404); Live Activities clear only from the app')
          } else if (error.status !== 404) this.deps.log(`[relay] Talaria relay rejected a viewed acknowledgement (HTTP ${String(error.status)})`)
        }
      }
      if (view.deleted) {
        if (accepted) await mutateDeletedViews(this.deps.documents, (views) => { const index = views.findIndex((entry) => entry.id === view.deleted!.id && entry.through === view.through); if (index >= 0) views.splice(index, 1) })
      } else if (this.views.get(sid) === view) this.views.delete(sid)
    }
  }

  private async reserveRevisions(count: number): Promise<number[]> {
    return (await updateDocument(this.deps.documents, 'relay', 'revision', (raw) => {
      let floor = Number.parseInt(str(raw), 10) || 0
      const revisions = Array.from({ length: count }, () => {
        this.lastRevision = Math.max(this.lastRevision + 1, floor + 1, Math.floor(this.deps.now() * 1000))
        floor = this.lastRevision
        return floor
      })
      return { value: `${String(this.lastRevision)}\n`, result: revisions }
    }))
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
        const ready: (readonly [string, QueuedView])[] = [...this.views, ...(await this.pendingDeleted()).map((view) => [view.sessionId, { profile: view.profile, through: view.through, deleted: view }] as const)]
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
  async buildStates(profile: string): Promise<RelayState[]> {
    const cutoff = this.deps.now() - TERMINAL_RETENTION_S
    const backgroundIds = new Set<string>()
    for (const sid of await this.deps.background?.sessionIds() ?? []) {
      if ((await this.deps.background!.receipts(sid)).some((receipt) => ['running', 'attention', 'unknown'].includes(receipt.status) || (receipt.completed_at ?? 0) >= cutoff)) backgroundIds.add(sid)
    }
    for (const [sid, run] of this.terminal) if (run.terminal_at < cutoff && !backgroundIds.has(sid)) this.terminal.delete(sid)
    const bySession = new Map<string, ActiveRun & { relay_phase?: string; terminal_at?: number }>()
    for (const run of this.deps.registry.activeRuns.values()) {
      if ((run as { health_only?: boolean }).health_only) continue
      const sid = run.session_id.trim()
      if (!sid) continue
      const current = bySession.get(sid)
      if (!current || run.started_at > current.started_at) bySession.set(sid, run)
    }
    for (const [sid, run] of this.terminal) if (!bySession.has(sid)) bySession.set(sid, run)
    for (const sid of backgroundIds) {
      if (bySession.has(sid) || !await hasSessionData(this.deps.store, sid)) continue
      const session = await this.deps.store.get(sid)
      const latest = this.deps.activitySummary?.(session)
      const terminal = latest?.terminalState ?? null
      const relay_phase = terminal === null ? undefined : terminal === 'completed' || terminal === 'tool_limit_reached' ? 'completed' : terminal === 'cancelled' ? 'cancelled' : 'failed'
      bySession.set(sid, { session_id: sid, stream_id: latest?.turnId ?? '', started_at: latest?.timestamp ?? 0, phase: 'settled', workspace: session.workspace, model: session.model, provider: session.model_provider, ephemeral: false,
        ...(relay_phase ? { relay_phase, terminal_at: Number(latest?.timestamp) || session.updated_at } : {}) })
    }
    const alertEligible = this.alertEligibilitySupported ? !this.deps.presence.has(profile) : true
    const states: RelayState[] = []
    for (const [sid, run] of bySession) {
      if (run.activity_parent_session_id) continue
      let session
      try { session = (await this.deps.store.get(sid, { metadataOnly: true })) } catch { continue }
      if (!this.deps.profilesMatch(session.profile, profile)) continue
      const revision = 0
      let phase = run.relay_phase ?? 'running'
      if (!['completed', 'failed', 'cancelled'].includes(phase) && this.deps.pending.approvalPending(sid).pending) phase = 'waiting_for_approval'
      if (phase === 'running' && this.deps.pending.clarifyPending(sid).pending) phase = 'waiting_for_input'
      if (phase === 'running' && run.phase.endsWith('starting')) phase = 'starting'
      const snapshot = await this.deps.background?.snapshot(sid, session.profile, { ...(run.relay_phase ? { excludeStreamId: run.stream_id, terminalPhase: run.relay_phase as SessionActivityPhase } : {}) })
      if ([...this.deps.registry.activeRuns.values()].some((current) => current.session_id === sid && current.stream_id !== run.stream_id && current.started_at >= run.started_at)) { this.changed(); continue }
      try {
        if (!this.deps.profilesMatch((await this.deps.store.get(sid, { metadataOnly: true })).profile, profile)) continue
      } catch { continue }
      if (run.phase === 'settled' && !run.stream_id) phase = snapshot?.activity_phase ?? 'stale'
      // A finished run keeps the instant it ended, so a viewer who saw that turn covers it whenever the snapshot is built.
      const updatedAt = Math.floor((run.terminal_at ?? this.deps.now()) * 1000)
      const state: RelayState = { sessionId: sid, streamId: run.stream_id || null, eventId: `snapshot:${String(revision)}:${sid}`, revision, ...(snapshot ? { activityPhase: snapshot.activity_phase } : {}), title: (session.title || 'Untitled').slice(0, 120), phase, startedAt: Math.floor((run.started_at || this.deps.now()) * 1000), updatedAt, deepLink: `/sessions/${encodeURIComponent(sid)}` }
      if (!alertEligible) state.alertEligible = false
      states.push(state)
    }
    if (states.length) {
      const revisions = await this.reserveRevisions(states.length)
      for (const [index, state] of states.entries()) {
        state.revision = revisions[index]!
        state.eventId = `snapshot:${String(state.revision)}:${state.sessionId}`
      }
    }
    return states
  }

  async publishSnapshot(isolatePermanent = false): Promise<void> {
    let retryable: RelayHttpError | null = null
    for (const [profile, cfg] of Object.entries(this.config.profiles)) {
      if (!(await this.publishes(profile, cfg))) continue
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

  private async publishes(profile: string, cfg: RelayProfile): Promise<boolean> {
    if (cfg.identity) {
      try { if ((await profileIdentity(this.deps, profile)) !== cfg.identity) return false } catch { return false }
    }
    return !this.disabledProfiles.has(cfg.profile_id)
  }

  /** Validation publish for one newly enrolled profile (Python `publish_profile`). */
  async publishProfile(profileId: string, expectedIdentity: string): Promise<void> {
    for (const [profile, cfg] of Object.entries(this.config.profiles)) {
      if (cfg.profile_id !== profileId) continue
      if (cfg.identity !== expectedIdentity || (await profileIdentity(this.deps, profile)) !== expectedIdentity) throw new RelayPairingError('Hermes profile changed during relay enrollment', 409)
      await this.publishProfileSnapshot(profile, profileId)
      return
    }
    throw new RelayPairingError('Talaria Relay profile enrollment is unavailable', 502)
  }

  // The ledger is reread for every change, so a restarted or replacement publisher resends an unsent event under its ID.
  private parseStarted(raw: unknown): StartedLedger {
    const ledger: StartedLedger = new Map()

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

  private startedDocument(ledger: StartedLedger): unknown {
    const profiles = [...ledger].map(([profileId, p]) => ({ profileId, floor: p.floor, sessions: [...p.sessions].map(([sessionId, e]) => ({ sessionId, startedAt: e.startedAt, sent: e.sent })) }))
    return { version: 1, profiles }
  }

  private async mutateStarted<T>(edit: (ledger: StartedLedger) => T | Promise<T>): Promise<T> {
    return (await updateDocument(this.deps.documents, 'relay', 'started', async (raw) => {
      const ledger = this.parseStarted(raw)
      const result = await edit(ledger)
      return { value: this.startedDocument(ledger), result }
    }, { replaceInvalid: true }))
  }

  /** Give each enrolled profile without a ledger entry a floor of now; true when the ledger changed. */
  private trackProfiles(ledger: StartedLedger): boolean {
    const nowMs = Math.floor(this.deps.now() * 1000)
    let changed = false
    for (const cfg of Object.values(this.config.profiles)) {
      if (ledger.has(cfg.profile_id)) continue
      ledger.set(cfg.profile_id, { floor: nowMs, sessions: new Map() })
      changed = true
    }
    return changed
  }

  /** Record every messageful Web or Agent session that started in an enrolled profile since tracking began. */
  private async observeStarted(): Promise<StartedLedger> {
    // Agent rows come from the listing worker first, so the ledger's load-to-save stays synchronous.
    const agentRows = new Map<string, Record<string, unknown>[]>()
    for (const [profile, cfg] of Object.entries(this.config.profiles)) {
      if (!(await this.publishes(profile, cfg))) continue
      try { agentRows.set(profile, await this.deps.agentSessions(profile)) } catch { agentRows.set(profile, []) }
    }
    let index: Record<string, unknown>[] = []
    try { index = await this.deps.store.readIndexEntries() } catch { /* no resident index */ }
    const eligible = new Set<string>()
    for (const [profile, cfg] of Object.entries(this.config.profiles)) if (await this.publishes(profile, cfg)) eligible.add(profile)
    return (await this.mutateStarted((ledger) => {
    const nowMs = Math.floor(this.deps.now() * 1000)
    this.trackProfiles(ledger)
    for (const [profile, cfg] of Object.entries(this.config.profiles)) {
      if (!eligible.has(profile)) continue
      const entry = ledger.get(cfg.profile_id)!
      const floor = Math.max(entry.floor, nowMs - STARTED_WINDOW_MS)
      for (const [sid, e] of entry.sessions) if (e.startedAt < floor) { entry.sessions.delete(sid) }
      // A compressed Agent chat keeps its lineage root's id and start, so later segments are not new sessions.
      const agent = agentRows.get(profile) ?? []
      const seen = [
        ...index.filter((row) => Number(row.message_count) > 0 && this.deps.profilesMatch(row.profile as string | null | undefined, profile)).map((row) => [row.session_id, row.created_at]),
        ...agent.map((row) => [row._lineage_root_id || row.id, row.started_at]),
      ]
      for (const [rawSid, created] of seen) {
        const sid = str(rawSid).trim()
        const startedAt = Math.floor(Number(created) * 1000)
        if (!sid || sid.length > 191 || !Number.isSafeInteger(startedAt) || startedAt < floor || entry.sessions.has(sid)) continue
        entry.sessions.set(sid, { startedAt, sent: false })
      }
    }
    return ledger
    }))
  }

  /** Announce each newly observed session once, oldest first, to the relay scope of the profile that owns it. */
  async publishStarted(): Promise<void> {
    const ledger = await this.observeStarted()
    for (const [profile, cfg] of Object.entries(this.config.profiles)) {
      if (!(await this.publishes(profile, cfg))) continue
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
        await this.mutateStarted((latest) => { const sent = latest.get(cfg.profile_id)?.sessions.get(sid); if (sent) sent.sent = true })
      }
    }
  }

  private async publishProfileSnapshot(profile: string, profileId: string): Promise<void> {
    const states = (await this.buildStates(profile))
    const config = this.config.profiles[profile]
    if (config?.profile_id !== profileId || !await this.publishes(profile, config)) return
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
  events: SessionEventBus
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
  async start(): Promise<boolean> {
    if (this.publisher) return true
    let candidate: RelayPublisher | null = null
    try {
      const config = (await loadRelayConfig(this.deps.documents))
      if (!config) return false
      candidate = new RelayPublisher(config, this.deps)
      await candidate.initialize()
      this.candidate = candidate
      this.adopt(candidate, null)
      await candidate.start(false)
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
  async markViewed(sid: string): Promise<void> {
    const publisher = this.publisher ?? this.candidate
    publisher?.markViewed(sid, (await this.deps.store.get(sid, { metadataOnly: true })).profile)
  }

  /** Persist before reporting successful deletion, even when publication is unavailable. */
  async clearDeleted(sid: string, profile: string | null): Promise<void> {
    const publisher = this.publisher ?? this.candidate
    const name = this.deps.canonicalProfile(profile ?? 'default')
    const key = JSON.stringify([name, sid])
    const live = (await hasSessionData(this.deps.store, sid))
    if (!live && this.clearedDeleted.has(key)) return
    await mutateDeletedViews(this.deps.documents, async (views) => {
    const queued = views.find((view) => view.sessionId === sid && view.profile === name)
    if (queued && live) {
      const through = Math.max(queued.through, Math.floor(this.deps.now() * 1000))
      if (through !== queued.through) { queued.through = through }
    } else if (!queued) {
      let config = publisher?.config ?? null
      if (!config) {
        try { config = (await loadRelayConfig(this.deps.documents)) } catch { /* preserve unconfigured cleanup */ }
      }
      const cfg = config?.profiles[name]
      let identity = cfg?.identity ?? null
      if (identity === null) {
        try { identity = (await profileIdentity(this.deps, name)) } catch { /* bind when this profile becomes available */ }
      }
      views.push({
        id: randomUUID(), sessionId: sid, profile: name, through: Math.floor(this.deps.now() * 1000), identity,
        scope: config && cfg ? { url: config.url, publisherId: config.publisher_id, profileId: cfg.profile_id } : null,
      })
    }
    })
    this.clearedDeleted.add(key)
    publisher?.changed()
  }

  /** Terminal turn events reach the relay even mid-swap (Python `note_talaria_terminal`). */
  noteTerminal(streamId: string, phase: string): void {
    if (!['completed', 'failed', 'cancelled'].includes(phase)) return
    const publisher = this.publisher ?? this.candidate
    publisher?.noteTerminal(streamId, phase)
    const current = this.publisher ?? this.candidate
    if (current && current !== publisher) current.noteTerminal(streamId, phase)
    const run = this.deps.registry.activeRuns.get(streamId)
    if (phase !== 'completed' || !run || run.ephemeral || (run as { health_only?: boolean }).health_only) return
    // Capture the run before teardown; this never materializes an owner-managed session.
    void this.deps.store.get(run.session_id, { metadataOnly: true }).then((session) => {
      this.noteWebCompletion(session.profile ?? 'default', run.session_id, run.stream_id)
    }).catch(() => undefined)
  }

  /** Shared Web-only projection for direct turns and receipt-confirmed native owner executions. */
  noteWebCompletion(profileName: string, sessionId: string, runIdentity: string): void {
    const profile = this.deps.canonicalProfile(profileName)
    const expires = this.deps.now() * 1000 + 60_000
    void (async () => {
      const scope = await profileIdentity(this.deps, profile)
      const identity = createHash('sha256').update(JSON.stringify([scope, runIdentity])).digest('hex')
      this.deps.events.publish('web_completion', { profile, sessionId, webAudio: { identity, scope, profile, eligible: true, expires_at: expires } })
    })().catch(() => undefined)
  }

  /** Python `configure_talaria_relay_publisher`: validate with a real snapshot before swapping publishers. */
  private async configure(config: RelayConfig, validate: { profileId: string; identity: string } | null): Promise<void> {
    const candidate = new RelayPublisher(config, this.deps)
    await candidate.initialize()
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
    await candidate.start(false)
    candidate.changed()
  }

  /** Python `pair_talaria_relay`, serialised so concurrent enrollments preserve both mappings. */
  pair(body: unknown, profile: string, operator: boolean): Promise<{ ok: true; publisher_id: string }> {
    const run = this.pairing.then(() => this.pairUnlocked(body, profile, operator))
    this.pairing = run.catch(() => undefined)
    return run
  }

  private async relayPost(url: string, body: string, headers: Record<string, string>, reject: string, failure?: (response: Response | null) => RelayPairingError, acceptedStatus?: number): Promise<Record<string, unknown>> {
    let res: Response
    try {
      res = await this.deps.fetch()(url, { method: 'POST', body, headers, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch {
      throw failure?.(null) ?? new RelayPairingError('Could not reach Talaria Relay', 502)
    }
    if (!res.ok || (acceptedStatus !== undefined && res.status !== acceptedStatus)) { void res.body?.cancel(); throw failure?.(res) ?? new RelayPairingError(`${reject} (HTTP ${String(res.status)})`, res.status >= 400 && res.status < 500 ? 409 : 502) }
    let payload: unknown
    try { const raw = await readCapped(res, 256 * 1024); if (!raw) throw new Error('too large'); payload = JSON.parse(raw.toString('utf8')) } catch { throw failure?.(null) ?? new RelayPairingError('Talaria Relay returned an invalid response', 502) }
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}
  }

  private feedbackOrigin(config: RelayConfig | null): string {
    return config?.url ?? (this.deps.env.HERMES_WEBUI_TALARIA_RELAY_URL ?? DEFAULT_RELAY_URL).trim().replace(/\/+$/, '')
  }

  /** Feedback shares publisher identity, signing, response bounds and transport with enrollment. */
  async submitFeedback(body: string): Promise<{ reportId: string; attachments: FeedbackAdmission[] }> {
    const config = await loadRelayConfig(this.deps.documents)
    const url = this.feedbackOrigin(config)
    const key = config ? await loadKey(this.deps.documents, config) : null
    const failure = (response: Response | null): RelayPairingError => {
      if (response?.status === 429) {
        const raw = response.headers.get('Retry-After') ?? ''
        const seconds = /^\d+$/.test(raw) ? Number(raw) : Math.ceil((Date.parse(raw) - this.deps.now() * 1000) / 1000)
        return new RelayPairingError('rate_limited', 429, { retryAfterSeconds: Number.isSafeInteger(seconds) ? Math.max(0, seconds) : 60 })
      }
      if (response?.status === 404) return new RelayPairingError('feedback_unavailable', 503)
      if (response && response.status >= 400 && response.status < 500) return new RelayPairingError('invalid', 400)
      return new RelayPairingError('relay_unreachable', 502)
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const path = '/v1/feedback'
        const headers = config && key ? signedHeaders(key, config.key_id, 'POST', path, body, this.deps.now) : { 'Content-Type': 'application/json' }
        const payload = await this.relayPost(url + path, body, headers, '', failure, 202)
        const parsed = FeedbackAcceptedSchema.safeParse(payload)
        if (!parsed.success) throw failure(null)
        return { reportId: parsed.data.reportId, attachments: parsed.data.attachments ?? [] }
      } catch (error) {
        if (attempt === 0 && error instanceof RelayPairingError && error.message === 'relay_unreachable') continue
        throw error
      }
    }
  }

  /** One attachment PUT with its upload token; `unknown` means the outcome must be reconciled by resubmitting. */
  async uploadFeedbackAttachment(reportId: string, index: number, uploadToken: string, data: Buffer): Promise<'stored' | 'invalid' | 'expired' | 'disabled' | 'unknown'> {
    const url = `${this.feedbackOrigin(await loadRelayConfig(this.deps.documents))}/v1/feedback/${encodeURIComponent(reportId)}/attachments/${String(index)}`
    let res: Response
    try {
      res = await this.deps.fetch()(url, { method: 'PUT', body: data, headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/octet-stream' }, redirect: 'error', signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) })
    } catch { return 'unknown' }
    let error: unknown
    try { const raw = await readCapped(res, 4096); error = raw ? (JSON.parse(raw.toString('utf8')) as { error?: unknown }).error : undefined } catch { /* the status alone decides */ }
    if (res.status === 200) return 'stored'
    if (res.status === 400 && error === 'invalid_attachment') return 'invalid'
    if (res.status === 410) return 'expired'
    if (res.status === 503 && error === 'attachments_disabled') return 'disabled'
    return 'unknown'
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
      identity = (await profileIdentity(this.deps, canonical))
    } catch {
      throw new RelayPairingError('Hermes profile is unavailable', 403)
    }
    const existing = (await loadRelayConfig(this.deps.documents))
    if (existing) {
      if (existing.url !== relayUrl || existing.publisher_id !== publisherId) throw new RelayPairingError('This Hermes server is registered to a different relay', 409)
      const known = existing.profiles[canonical]
      const profileId = known?.identity === identity ? known.profile_id : `prf_${randomUUID().replace(/-/g, '')}`
      const requestBody = JSON.stringify({ invitation, publisherId, profileId })
      const path = '/v1/pairings/profile/redeem'
      const payload = await this.relayPost(existing.url + path, requestBody, signedHeaders((await loadKey(this.deps.documents, existing)), existing.key_id, 'POST', path, requestBody, this.deps.now), 'Talaria Relay rejected the profile enrollment')
      if (payload.protocolVersion !== 2 || payload.publisherId !== publisherId || payload.profileId !== profileId) throw new RelayPairingError('Talaria Relay returned an invalid response', 502)
      const config: RelayConfig = { ...existing, profiles: { ...existing.profiles, [canonical]: { identity, profile_id: profileId } } }
      await saveRelayConfig(this.deps.documents, config)
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
    const keyDocument = createHash('sha256').update(keyId, 'utf8').digest('hex').slice(0, 16)
    await updateDocument(this.deps.documents, 'relay-keys', keyDocument, () => ({ value: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), result: undefined }))
    const config: RelayConfig = { url: relayUrl, publisher_id: finalPublisher, key_id: keyId, private_key_path: '', private_key_document: keyDocument, profiles: { [canonical]: { identity, profile_id: pairedProfile } } }
    await saveRelayConfig(this.deps.documents, config)
    await this.configure(config, { profileId: pairedProfile, identity })
    return { ok: true, publisher_id: finalPublisher }
  }
}
