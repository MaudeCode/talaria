/**
 * Per-profile session activity shared by every notification channel: one row per session with a live or
 * recently finished run, its phase, and whether a browser tab for the profile mutes alerts. Channels add their
 * own transport fields (the Relay adds revisions and event IDs) on top of these rows.
 */
import type { SessionActivityPhase } from '@maudecode/talaria-web-contracts'
import type { BackgroundActivity } from '../background-tasks.js'
import type { PendingPrompts } from '../pending.js'
import type { SessionPrefixIndex } from '../prefix-index.js'
import type { PresenceLeases } from '../relay.js'
import type { Session } from '../session.js'
import type { SessionStore } from '../store.js'
import type { ActiveRun, StreamRegistry } from '../streams.js'
import { str } from '../../util.js'

const TERMINAL_RETENTION_S = 15 * 60
// ponytail: bounds the terminal ledger when no channel ever reads it; the oldest finished run goes first.
const TERMINAL_MAX = 1024
export const TERMINAL_PHASES = ['completed', 'failed', 'cancelled'] as const

export interface ActivityDeps {
  registry: StreamRegistry
  pending: PendingPrompts
  store: SessionStore
  presence: PresenceLeases
  background?: BackgroundActivity
  activitySummary?: (session: Session) => ReturnType<SessionPrefixIndex['activitySummary']>
  profilesMatch: (row: string | null | undefined, active: string | null | undefined) => boolean
  now: () => number
}

export interface ActivityState {
  sessionId: string
  streamId: string | null
  title: string
  phase: string
  activityPhase?: SessionActivityPhase
  startedAt: number
  updatedAt: number
  deepLink: string
  alertEligible: boolean
  /** TAL-48: the session's person under person isolation; channels never send it, they filter by it. */
  ownerPersonId: string | null
}

type TrackedRun = ActiveRun & { relay_phase?: string; terminal_at?: number }

/** A staged deletion cannot clear a session that survived a failed removal or a restart before removal. */
export async function hasSessionData(store: SessionStore, sid: string): Promise<boolean> {
  if (store.sessions.has(sid)) return true
  return (await store.exists(sid))
}

/** Python `build_states` without the Relay's revision numbering. */
export class ActivityStates {
  private readonly terminal = new Map<string, ActiveRun & { relay_phase: string; terminal_at: number }>()

  constructor(private readonly deps: ActivityDeps) {}

  /** Record a finished run before its registry entry is torn down; false when the stream is unknown. */
  noteTerminal(streamId: string, phase: string): boolean {
    const run = this.deps.registry.activeRuns.get(streamId)
    const sid = str(run?.session_id).trim()
    if (!run || !sid) return false
    this.terminal.delete(sid)
    if (this.terminal.size >= TERMINAL_MAX) this.terminal.delete(this.terminal.keys().next().value!)
    this.terminal.set(sid, { ...run, relay_phase: phase, terminal_at: this.deps.now() })
    return true
  }

  /** Carry another tracker's finished runs (a replacement publisher built without the shared tracker). */
  inherit(previous: ActivityStates): void {
    if (previous === this) return
    for (const [sid, run] of previous.terminal) this.terminal.set(sid, run)
  }

  /** `retry` runs when a newer run for a session appeared mid-build, so the caller builds again. */
  async states(profile: string, retry: () => void): Promise<ActivityState[]> {
    const cutoff = this.deps.now() - TERMINAL_RETENTION_S
    const backgroundIds = new Set<string>()
    for (const sid of await this.deps.background?.sessionIds() ?? []) {
      if ((await this.deps.background!.receipts(sid)).some((receipt) => ['running', 'attention', 'unknown'].includes(receipt.status) || (receipt.completed_at ?? 0) >= cutoff)) backgroundIds.add(sid)
    }
    for (const [sid, run] of this.terminal) if (run.terminal_at < cutoff && !backgroundIds.has(sid)) this.terminal.delete(sid)
    const bySession = new Map<string, TrackedRun>()
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
    const alertEligible = !this.deps.presence.has(profile)
    const states: ActivityState[] = []
    for (const [sid, run] of bySession) {
      if (run.activity_parent_session_id) continue
      let session
      try { session = (await this.deps.store.get(sid, { metadataOnly: true })) } catch { continue }
      if (!this.deps.profilesMatch(session.profile, profile)) continue
      let phase = run.relay_phase ?? 'running'
      if (!(TERMINAL_PHASES as readonly string[]).includes(phase) && this.deps.pending.approvalPending(sid).pending) phase = 'waiting_for_approval'
      if (phase === 'running' && this.deps.pending.clarifyPending(sid).pending) phase = 'waiting_for_input'
      if (phase === 'running' && run.phase.endsWith('starting')) phase = 'starting'
      const snapshot = await this.deps.background?.snapshot(sid, session.profile, { ...(run.relay_phase ? { excludeStreamId: run.stream_id, terminalPhase: run.relay_phase as SessionActivityPhase } : {}) })
      if ([...this.deps.registry.activeRuns.values()].some((current) => current.session_id === sid && current.stream_id !== run.stream_id && current.started_at >= run.started_at)) { retry(); continue }
      try {
        if (!this.deps.profilesMatch((await this.deps.store.get(sid, { metadataOnly: true })).profile, profile)) continue
      } catch { continue }
      if (run.phase === 'settled' && !run.stream_id) phase = snapshot?.activity_phase ?? 'stale'
      // A finished run keeps the instant it ended, so a viewer who saw that turn covers it whenever the snapshot is built.
      const updatedAt = Math.floor((run.terminal_at ?? this.deps.now()) * 1000)
      states.push({ sessionId: sid, streamId: run.stream_id || null, ...(snapshot ? { activityPhase: snapshot.activity_phase } : {}), title: (session.title || 'Untitled').slice(0, 120), phase, startedAt: Math.floor((run.started_at || this.deps.now()) * 1000), updatedAt, deepLink: `/sessions/${encodeURIComponent(sid)}`, alertEligible, ownerPersonId: session.owner_person_id })
    }
    return states
  }
}
