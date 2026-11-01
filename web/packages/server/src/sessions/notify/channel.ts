/**
 * The notification port: every way of alerting someone who is not looking at Talaria is one channel.
 * The hub subscribes to the session event bus once and fans each change out; channels read the shared
 * `ActivityStates` rows and decide delivery with `alerts.ts`.
 */
import type { SessionEventBus } from '../events.js'
import { TERMINAL_PHASES, type ActivityStates } from './activity.js'

export interface NotificationChannel {
  readonly id: string
  start?(): unknown
  stop(): void
  /** Something in the activity rows may differ; channels coalesce and never block the caller. */
  changed(): void
  noteTerminal?(streamId: string, phase: string): void
  markViewed?(sid: string): Promise<void>
  clearDeleted?(sid: string, profile: string | null): Promise<void>
}

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

  async markViewed(sid: string): Promise<void> { for (const channel of this.channels) await channel.markViewed?.(sid) }
  async clearDeleted(sid: string, profile: string | null): Promise<void> { for (const channel of this.channels) await channel.clearDeleted?.(sid, profile) }
}
