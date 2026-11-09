/**
 * The notification port: every way of alerting someone who is not looking at Talaria is one channel.
 * The hub subscribes to the session event bus once and fans each change out; channels read the shared
 * `ActivityStates` rows and decide delivery with `alerts.ts`.
 */
import type { AgentNotifyLevel, ServerNotifyResult } from '@maudecode/talaria-web-contracts'
import { SidecarServerError } from '../../sidecar/server-methods.js'
import type { SessionEventBus } from '../events.js'
import { TERMINAL_PHASES, type ActivityStates } from './activity.js'

const TITLE_MAX = 80
const BODY_MAX = 300

export interface NotificationChannel {
  readonly id: string
  start?(): unknown
  stop(): void
  /** Something in the activity rows may differ; channels coalesce and never block the caller. */
  changed(): void
  noteTerminal?(streamId: string, phase: string): void
  markViewed?(sid: string): Promise<void>
  clearDeleted?(sid: string, profile: string | null): Promise<void>
  /** TAL-1970: whether an agent notice about a session in `profile` owned by `owner` reaches any device through this channel. */
  noticeReach?(profile: string | null, owner: string | null): Promise<boolean>
}

/** TAL-1970: the session an agent notice is about. */
export interface NoticeSession { session_id: string; profile: string | null; owner_person_id: string | null }

export class NotificationHub {
  constructor(private readonly activity: ActivityStates, private readonly channels: readonly NotificationChannel[], events: Pick<SessionEventBus, 'addListener'>) {
    events.addListener(() => { this.changed() })
  }

  async start(): Promise<void> { for (const channel of this.channels) await channel.start?.() }
  changed(): void { for (const channel of this.channels) channel.changed() }

  /** Record a finished run before the registry tears it down, then let every channel see it. */
  noteTerminal(streamId: string, phase: string): void {
    if (!(TERMINAL_PHASES as readonly string[]).includes(phase)) return
    this.activity.noteTerminal(streamId, phase)
    for (const channel of this.channels) channel.noteTerminal?.(streamId, phase)
    this.changed()
  }

  /**
   * TAL-1970: the `notify` agent tool. One notice per call, stamped on the session's activity row so every channel alerts
   * once on its next pass; `info` is muted while a Talaria tab is attached to the profile, `attention` never is.
   */
  async notify(session: NoticeSession, input: { title: string; body: string; level?: AgentNotifyLevel | undefined }): Promise<ServerNotifyResult> {
    const title = input.title.trim()
    const body = input.body.trim()
    const level = input.level ?? 'info'
    if (!title || !body) throw new SidecarServerError(`${title ? 'body' : 'title'} is required`, 'invalid_params')
    if (title.length > TITLE_MAX) throw new SidecarServerError(`title is ${String(title.length)} characters; at most ${String(TITLE_MAX)}`, 'title_too_long')
    if (body.length > BODY_MAX) throw new SidecarServerError(`body is ${String(body.length)} characters; at most ${String(BODY_MAX)}`, 'body_too_long')
    // Rows exist only for sessions with a live or recently finished run; a notice no row shows reaches no channel.
    const row = await this.activity.noticeRow(session.session_id)
    const url = `/session/${encodeURIComponent(row ?? session.session_id)}`
    const muted = level === 'info' && this.activity.muted(session.profile ?? 'default')
    const noted = this.activity.noteAgentNotice(row ?? session.session_id, { title, body, level }, muted || !row)
    if ('retryAfter' in noted) return { status: 'rate_limited', notice_id: null, level, url, channels: {}, retry_after_seconds: noted.retryAfter }
    const channels: ServerNotifyResult['channels'] = {}
    for (const channel of this.channels) {
      if (!channel.noticeReach) continue
      channels[channel.id] = !row || !(await channel.noticeReach(session.profile, session.owner_person_id)) ? 'unavailable' : muted ? 'muted' : 'sent'
    }
    if (!muted) this.changed()
    return { status: 'sent', notice_id: noted.notice.id, level, url, channels, retry_after_seconds: null }
  }

  async markViewed(sid: string): Promise<void> { for (const channel of this.channels) await channel.markViewed?.(sid) }
  async clearDeleted(sid: string, profile: string | null): Promise<void> { for (const channel of this.channels) await channel.clearDeleted?.(sid, profile) }
}
