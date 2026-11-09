/**
 * Per-profile session activity shared by every notification channel: one row per session with a live or
 * recently finished run, its phase, and whether a browser tab for the profile mutes alerts. Channels add their
 * own transport fields (the Relay adds revisions and event IDs) on top of these rows.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { AgentNotifyLevel, DecisionReviewRef, SessionActivityPhase } from '@maudecode/talaria-web-contracts'
import { settledActivityPhase, type BackgroundActivity } from '../background-tasks.js'
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
// TAL-1970: per session, at most NOTICE_LIMIT notices per NOTICE_WINDOW_S and one `attention` notice per ATTENTION_GAP_S.
const NOTICE_LIMIT = 5
const NOTICE_WINDOW_S = 10 * 60
const ATTENTION_GAP_S = 60
// The rate limit allows at most 10 notices in a finished run's retention; a row never carries more.
const NOTICES_SHOWN = 10

/** TAL-1970: what the agent's `notify` asked to tell the user; a row carries the session's recent unmuted ones. */
export interface AgentNotice { id: string; title: string; body: string; level: AgentNotifyLevel }

export interface ActivityDeps {
  registry: StreamRegistry
  pending: PendingPrompts
  store: SessionStore
  presence: PresenceLeases
  background?: BackgroundActivity
  activitySummary?: (session: Session) => ReturnType<SessionPrefixIndex['activitySummary']>
  profilesMatch: (row: string | null | undefined, active: string | null | undefined) => boolean
  /** TAL-1966: the session's newest decision review by creation, which alerts once when a row first holds it. */
  decisionReview?: (sid: string) => Pick<DecisionReviewRef, 'review_id' | 'title'> | null
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
  /** The approval at the head of the queue while the session waits for one, as an opaque digest (TAL-59). */
  approvalHeadId?: string
  /** TAL-1966: the session's newest decision review by creation and its title; its alert opens the review. */
  decisionReviewId?: string
  decisionReviewTitle?: string
  /** TAL-1970: the session's unmuted agent notices, oldest first, until they expire; each one a channel has not seen alerts once. */
  agentNotices?: AgentNotice[]
  /** TAL-48: the session's person under person isolation; channels never send it, they filter by it. */
  ownerPersonId: string | null
}

type TrackedRun = ActiveRun & { relay_phase?: string; terminal_at?: number }

/** A staged deletion cannot clear a session that survived a failed removal or a restart before removal. */
export async function hasSessionData(store: SessionStore, sid: string): Promise<boolean> {
  if (store.sessions.has(sid)) return true
  return (await store.exists(sid))
}

/** Stable for one approval across snapshots and restarts; the digest carries nothing the approval says. */
export function approvalHeadId(sid: string, approvalId: string): string {
  return createHash('sha256').update(`${sid}\0${approvalId}`, 'utf8').digest('base64url').slice(0, 22)
}

/** Python `build_states` without the Relay's revision numbering. */
export class ActivityStates {
  private readonly terminal = new Map<string, ActiveRun & { relay_phase: string; terminal_at: number }>()
  /** TAL-1970: per session, when each notice of the window was accepted, and the unmuted ones the rows carry, with their time. */
  private readonly notices = new Map<string, { sent: { at: number; level: AgentNotifyLevel }[]; shown: { notice: AgentNotice; at: number }[] }>()

  constructor(private readonly deps: ActivityDeps) {}

  /** Whether a session of profile `row` shows under the `active` profile, as the rows decide it. */
  profileMatches(row: string | null | undefined, active: string): boolean { return this.deps.profilesMatch(row, active) }

  /** Whether a Talaria tab attached to the profile mutes alerts now (the rows' `alertEligible`). */
  muted(profile: string): boolean { return this.deps.presence.has(profile) }

  /**
   * TAL-1970: count an agent notice against the session's limits. A refusal records nothing and says how many seconds
   * until the next call can go through; an accepted muted notice counts but never reaches a row.
   */
  noteAgentNotice(sid: string, input: Omit<AgentNotice, 'id'>, muted: boolean): { notice: AgentNotice } | { retryAfter: number } {
    const now = this.deps.now()
    this.pruneNotices(now)
    const entry = this.notices.get(sid) ?? { sent: [], shown: [] }
    let retryAt = entry.sent.length >= NOTICE_LIMIT ? entry.sent[entry.sent.length - NOTICE_LIMIT]!.at + NOTICE_WINDOW_S : 0
    const attention = entry.sent.findLast((sent) => sent.level === 'attention')
    if (input.level === 'attention' && attention) retryAt = Math.max(retryAt, attention.at + ATTENTION_GAP_S)
    if (retryAt > now) return { retryAfter: Math.max(1, Math.ceil(retryAt - now)) }
    const notice: AgentNotice = { id: `an_${randomBytes(8).toString('hex')}`, ...input }
    entry.sent.push({ at: now, level: input.level })
    if (!muted) entry.shown = [...entry.shown, { notice, at: now }].slice(-NOTICES_SHOWN)
    this.notices.delete(sid)
    if (this.notices.size >= TERMINAL_MAX) this.notices.delete(this.notices.keys().next().value!)
    this.notices.set(sid, entry)
    return { notice }
  }

  /**
   * TAL-1970: the session whose activity row carries a notice from `sid`: its own, or the parent's for a child run shown on
   * its parent (which then opens), or null while no row shows it, so nothing could alert.
   */
  async noticeRow(sid: string): Promise<string | null> {
    const runs = [...this.deps.registry.activeRuns.values()].filter((run) => run.session_id.trim() === sid && !(run as { health_only?: boolean }).health_only)
    const run = runs[0] ?? this.terminal.get(sid)
    if (run) return run.activity_parent_session_id || sid
    return (await this.deps.background?.sessionIds())?.includes(sid) ? sid : null
  }

  /**
   * A notice stays on its row as long as a finished run's row lasts, beside the later ones, so a channel that passes or
   * publishes late still sees every notice it has not alerted for.
   */
  private pruneNotices(now: number): void {
    for (const [sid, entry] of this.notices) {
      entry.sent = entry.sent.filter((sent) => sent.at > now - NOTICE_WINDOW_S)
      entry.shown = entry.shown.filter((shown) => shown.at >= now - TERMINAL_RETENTION_S)
      if (!entry.sent.length && !entry.shown.length) this.notices.delete(sid)
    }
  }

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
    this.pruneNotices(this.deps.now())
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
      const relay_phase = terminal === null ? undefined : settledActivityPhase(terminal)
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
      const approval = this.deps.pending.approvalPending(sid).pending
      if (!(TERMINAL_PHASES as readonly string[]).includes(phase) && approval) phase = 'waiting_for_approval'
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
      const approvalId = phase === 'waiting_for_approval' ? str(approval?.approval_id) : ''
      const review = this.deps.decisionReview?.(sid)
      const notices = this.notices.get(sid)?.shown.map((shown) => shown.notice) ?? []
      states.push({ sessionId: sid, streamId: run.stream_id || null, ...(snapshot ? { activityPhase: snapshot.activity_phase } : {}), title: (session.title || 'Untitled').slice(0, 120), phase, startedAt: Math.floor((run.started_at || this.deps.now()) * 1000), updatedAt, deepLink: `/sessions/${encodeURIComponent(sid)}`, alertEligible, ...(approvalId ? { approvalHeadId: approvalHeadId(sid, approvalId) } : {}), ...(review ? { decisionReviewId: review.review_id, decisionReviewTitle: review.title } : {}), ...(notices.length ? { agentNotices: notices } : {}), ownerPersonId: session.owner_person_id })
    }
    return states
  }
}
