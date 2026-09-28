import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { atomicWriteSecretJson } from '../fs/atomic.js'

export type UpdateNotificationTarget = 'webui' | 'agent'
export type UpdateNotificationPhase = 'applying' | 'awaiting_confirmation' | 'restarting' | 'succeeded' | 'blocked' | 'failed' | 'unknown'
/** `tab` names one open Talaria Web tab; rows stamped with a tab are visible only to that tab. */
export interface UpdateNotificationScope { owner: string; profile: string; serverOwner?: boolean; tab?: string | null }

interface StoredUpdateNotification {
  id: string
  owner: string
  profile: string
  visibility: 'server' | 'profile'
  kind: string
  target: UpdateNotificationTarget | null
  phase: string
  severity: 'info' | 'warning' | 'critical'
  persistent: boolean
  requires_acknowledgement: boolean
  actions: UpdateNotificationAction[]
  destination: UpdateNotificationDestination | null
  title: string
  message: string
  created_at: string
  updated_at: string
  read_at: string | null
  acknowledged_at: string | null
  acknowledged_action_id: string | null
  verified_revision: string | null
  verified_version: string | null
  /** The apply's own explanation of a failed or blocked attempt (sanitized, bounded); null in every other phase. */
  detail: string | null
  performed_action_ids: string[]
  dismissed_at: string | null
  expected_identity: string | null
  tab_id: string | null
  /** Tabs that started or rejoined this update operation from Settings, with when they last did; each tab's Updating dialog follows the operation it joined most recently. */
  watchers: UpdateWatcher[]
}

interface UpdateWatcher { tab: string; at: string }
export interface UpdateNotificationAction { id: string; label: string; style: 'default' | 'primary' | 'destructive'; acknowledges: boolean }
export interface UpdateNotificationDestination { key: string; label: string }
export interface VerifiedUpdateIdentity { revision: string | null; version: string | null }

export type PublicUpdateNotification = Omit<StoredUpdateNotification, 'owner' | 'profile' | 'visibility' | 'dismissed_at' | 'expected_identity' | 'performed_action_ids' | 'tab_id' | 'watchers'> & {
  unread: boolean
  active: boolean
  requires_interaction: boolean
  can_dismiss: boolean
}
export interface FrontendBuildState { current_build: string | null; loaded_build: string | null; refresh_required: boolean; notification_id: string | null }
/** `tab_update` is the update operation the requesting tab most recently started or rejoined, even once dismissed; automatic updates never set it. */
export interface UpdateNotificationList { scope_id: string; notifications: PublicUpdateNotification[]; tab_update: PublicUpdateNotification | null; tab_joined_at: string | null; unread_count: number; clearable_count: number; can_clear: boolean }
export interface CreateUpdateNotificationInput {
  kind: string
  target?: UpdateNotificationTarget | null
  phase: string
  severity?: 'info' | 'warning' | 'critical'
  persistent?: boolean
  requiresAcknowledgement?: boolean
  actions?: UpdateNotificationAction[]
  destination?: UpdateNotificationDestination | null
  title: string
  message: string
  visibility?: 'server' | 'profile'
}

const PHASES = new Set<UpdateNotificationPhase>(['applying', 'awaiting_confirmation', 'restarting', 'succeeded', 'blocked', 'failed', 'unknown'])
const REVISION = /^[a-f0-9]{40}$/
const PER_SCOPE_LIMIT = 50
const GLOBAL_LIMIT = 500
export const FRONTEND_BUILD = /^[a-f0-9]{64}$/
export const TAB_ID = /^[A-Za-z0-9_-]{8,64}$/
export const WEB_REFRESH_KIND = 'web_refresh'
export const WEB_REFRESH_ACTION = 'reload'
/** A closed tab stops checking in; its refresh notice is dropped once unseen this long. An open tab recreates it on its next check. */
const TAB_TTL_MS = 60 * 60 * 1000

const copy = (row: StoredUpdateNotification): PublicUpdateNotification => ({
  id: row.id, kind: row.kind, target: row.target, phase: row.phase, severity: row.severity,
  persistent: row.persistent, requires_acknowledgement: row.requires_acknowledgement, actions: row.actions,
  destination: row.destination,
  title: row.title, message: row.message, created_at: row.created_at, updated_at: row.updated_at, read_at: row.read_at,
  acknowledged_at: row.acknowledged_at, acknowledged_action_id: row.acknowledged_action_id,
  verified_revision: row.verified_revision, verified_version: row.verified_version, detail: row.detail,
  unread: row.read_at === null,
  active: row.kind === 'update' && ['applying', 'restarting'].includes(row.phase),
  requires_interaction: row.requires_acknowledgement && row.acknowledged_at === null,
  can_dismiss: isDismissible(row),
})

const wording = (target: UpdateNotificationTarget, phase: UpdateNotificationPhase): { title: string; message: string } => {
  const name = target === 'webui' ? 'Talaria Web' : 'Hermes Agent'
  const messages: Record<UpdateNotificationPhase, string> = {
    applying: `Installing the selected ${name} update.`,
    awaiting_confirmation: 'This Hermes Agent revision needs confirmation before it can be installed.',
    restarting: target === 'webui' ? 'The update is installed. Talaria Web is restarting.' : 'The update is installed. Hermes Agent is restarting.',
    succeeded: `${name} was updated successfully.`,
    blocked: 'The update is waiting for active work to finish.',
    failed: 'The update could not be completed. Open System settings for details.',
    unknown: 'The connection closed before completion could be verified. Check the installed version before trying again.',
  }
  return { title: `${name} update`, message: messages[phase] }
}

export class UpdateNotificationStore {
  private rows: StoredUpdateNotification[]
  private readonly file: string
  /** Last check-in per tab refresh notice; kept in memory so polling never rewrites the store. */
  private readonly tabSeen = new Map<string, number>()
  private readonly loadedAt: number

  constructor(stateDir: string, private readonly now: () => Date = () => new Date()) {
    this.file = resolve(stateDir, 'update-notifications.json')
    this.rows = this.load()
    this.loadedAt = this.now().valueOf()
  }

  /**
   * Compare the frontend build a tab loaded with the build this server now serves. A mismatch keeps one
   * persistent, tab-scoped refresh notice per tab; a match resolves and removes it. Unknown builds change nothing.
   */
  syncTabBuild(scope: UpdateNotificationScope, loadedBuild: string | null, currentBuild: string | null): FrontendBuildState {
    this.pruneClosedTabs()
    const tab = scope.tab && TAB_ID.test(scope.tab) ? scope.tab : null
    const loaded = loadedBuild && FRONTEND_BUILD.test(loadedBuild) ? loadedBuild : null
    const current = currentBuild && FRONTEND_BUILD.test(currentBuild) ? currentBuild : null
    const state: FrontendBuildState = { current_build: current, loaded_build: loaded, refresh_required: false, notification_id: null }
    if (!tab || !loaded || !current) return state
    const existing = this.rows.find((row) => row.kind === WEB_REFRESH_KIND && row.tab_id === tab && row.owner === scope.owner && row.profile === scope.profile)
    if (loaded === current) {
      if (existing) {
        this.rows = this.rows.filter((row) => row !== existing)
        this.tabSeen.delete(existing.id)
        this.save()
      }
      return state
    }
    state.refresh_required = true
    const stamp = this.now().toISOString()
    if (existing) {
      this.tabSeen.set(existing.id, this.now().valueOf())
      if (existing.expected_identity !== current) {
        existing.expected_identity = current
        existing.updated_at = stamp
        existing.read_at = null
        this.save()
      }
      state.notification_id = existing.id
      return state
    }
    const row: StoredUpdateNotification = {
      id: randomUUID(), owner: scope.owner.slice(0, 256), profile: scope.profile.slice(0, 64), visibility: 'profile',
      kind: WEB_REFRESH_KIND, target: 'webui', phase: 'refresh_required', severity: 'warning',
      persistent: true, requires_acknowledgement: true,
      actions: [{ id: WEB_REFRESH_ACTION, label: 'Refresh now', style: 'primary', acknowledges: false }],
      destination: null, title: 'Talaria Web was updated', message: 'Refresh this tab to load the new version.',
      created_at: stamp, updated_at: stamp, read_at: null, acknowledged_at: null,
      acknowledged_action_id: null, verified_revision: null, verified_version: null, detail: null,
      performed_action_ids: [], dismissed_at: null, expected_identity: current, tab_id: tab, watchers: [],
    }
    if (!this.hasProtectedCapacity(row)) return state
    this.rows.push(row)
    this.tabSeen.set(row.id, this.now().valueOf())
    this.save()
    state.notification_id = row.id
    return state
  }

  begin(scope: UpdateNotificationScope, target: UpdateNotificationTarget): PublicUpdateNotification {
    const text = wording(target, 'applying')
    const created = this.create(scope, {
      kind: 'update', target, phase: 'applying', ...text,
      destination: { key: 'settings.system', label: 'Open System settings' },
      visibility: 'server',
    })
    this.watch(scope, created.id)
    return created
  }

  /** Let the requesting tab follow an update operation it started or rejoined. Watchers live as long as the record; only a server owner's Update click adds one. */
  watch(scope: UpdateNotificationScope, id: string): void {
    const tab = scope.tab && TAB_ID.test(scope.tab) ? scope.tab : null
    const row = this.rows.find((entry) => entry.id === id && entry.kind === 'update' && this.isVisible(entry, scope))
    if (!tab || !row) return
    row.watchers = [...row.watchers.filter((watcher) => watcher.tab !== tab), { tab, at: this.now().toISOString() }]
    this.save()
  }

  create(scope: UpdateNotificationScope, input: CreateUpdateNotificationInput): PublicUpdateNotification {
    const kind = safeToken(input.kind, '')
    const phase = safeToken(input.phase, '')
    const title = safeText(input.title, '', 160)
    const message = safeText(input.message, '', 500)
    const actions = safeActions(input.actions)
    if (!kind || !phase || !title || !message) throw new Error('Invalid update notification')
    if (input.requiresAcknowledgement && !actions.some((action) => action.acknowledges)) throw new Error('Required acknowledgement needs an acknowledging action')
    const stamp = this.now().toISOString()
    const row: StoredUpdateNotification = {
      id: randomUUID(), owner: scope.owner.slice(0, 256), profile: scope.profile.slice(0, 64), visibility: input.visibility ?? 'profile',
      kind, target: input.target ?? null, phase, severity: input.severity ?? 'info',
      persistent: input.requiresAcknowledgement === true || input.persistent === true,
      requires_acknowledgement: input.requiresAcknowledgement === true, actions,
      destination: safeDestination(input.destination), title, message,
      created_at: stamp, updated_at: stamp, read_at: null, acknowledged_at: null,
      acknowledged_action_id: null, verified_revision: null, verified_version: null, detail: null,
      performed_action_ids: [], dismissed_at: null, expected_identity: null, tab_id: null, watchers: [],
    }
    if (!this.hasProtectedCapacity(row)) throw new Error('Update notification protected capacity reached')
    this.rows.push(row)
    this.save()
    return copy(row)
  }

  activeUpdate(scope: UpdateNotificationScope, target: UpdateNotificationTarget): PublicUpdateNotification | null {
    const row = [...this.rows].reverse().find((entry) => this.isVisible(entry, scope) && entry.kind === 'update' && entry.target === target && ['applying', 'awaiting_confirmation', 'restarting'].includes(entry.phase))
    return row ? copy(row) : null
  }

  transition(id: string, phase: UpdateNotificationPhase, expectedIdentity?: string | null, verifiedIdentity?: VerifiedUpdateIdentity, detail?: unknown): PublicUpdateNotification | null {
    const row = this.rows.find((entry) => entry.id === id)
    if (!row) return null
    const phaseChanged = row.phase !== phase
    row.phase = phase
    if (row.target) Object.assign(row, wording(row.target, phase))
    row.updated_at = this.now().toISOString()
    if (phaseChanged) row.read_at = null
    row.expected_identity = expectedIdentity?.trim().slice(0, 160) || null
    row.detail = phase === 'failed' || phase === 'blocked' ? safeDetail(detail) : null
    if (verifiedIdentity) {
      row.verified_revision = typeof verifiedIdentity.revision === 'string' && REVISION.test(verifiedIdentity.revision) ? verifiedIdentity.revision : null
      row.verified_version = safeText(verifiedIdentity.version, '', 80) || null
    }
    this.save()
    return copy(row)
  }

  list(scope: UpdateNotificationScope): UpdateNotificationList {
    this.pruneClosedTabs()
    const scoped = this.rows.filter((row) => this.isVisible(row, scope) && row.dismissed_at === null)
    const ordered = scoped.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    const protectedRows = ordered.filter(isProtected)
    const visible = [...protectedRows, ...ordered.filter((row) => !isProtected(row)).slice(0, Math.max(0, PER_SCOPE_LIMIT - protectedRows.length))]
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    const notifications = visible.map(copy)
    const clearableCount = scoped.filter(isDismissible).length
    const tab = scope.tab && TAB_ID.test(scope.tab) ? scope.tab : null
    const joinedAt = (row: StoredUpdateNotification) => row.watchers.find((watcher) => watcher.tab === tab)?.at ?? ''
    const tabUpdate = tab ? this.rows.filter((row) => row.kind === 'update' && joinedAt(row) !== '' && this.isVisible(row, scope))
      .sort((a, b) => joinedAt(b).localeCompare(joinedAt(a)) || b.created_at.localeCompare(a.created_at))[0] : undefined
    return { scope_id: updateNotificationScopeId(scope), notifications, tab_update: tabUpdate ? copy(tabUpdate) : null, tab_joined_at: tabUpdate ? joinedAt(tabUpdate) : null, unread_count: visible.filter((row) => row.read_at === null).length, clearable_count: clearableCount, can_clear: clearableCount > 0 }
  }

  clear(scope: UpdateNotificationScope): UpdateNotificationList {
    const stamp = this.now().toISOString()
    let changed = false
    for (const row of this.rows) {
      if (!this.isVisible(row, scope) || row.dismissed_at !== null || !isDismissible(row)) continue
      row.dismissed_at = stamp
      changed = true
    }
    if (changed) this.save()
    return this.list(scope)
  }

  read(scope: UpdateNotificationScope, id: string): PublicUpdateNotification | null {
    const row = this.visible(scope, id)
    if (!row) return null
    if (row.read_at === null) { row.read_at = this.now().toISOString(); this.save() }
    return copy(row)
  }

  dismiss(scope: UpdateNotificationScope, id: string): 'dismissed' | 'not_found' | 'acknowledgement_required' {
    const row = this.rows.find((entry) => entry.id === id && this.isVisible(entry, scope))
    if (!row) return 'not_found'
    if (row.requires_acknowledgement && row.acknowledged_at === null) return 'acknowledgement_required'
    if (row.dismissed_at === null) { const stamp = this.now().toISOString(); row.dismissed_at = stamp; row.read_at ??= stamp; this.save() }
    return 'dismissed'
  }

  action(scope: UpdateNotificationScope, id: string, actionId: string): PublicUpdateNotification | null {
    const row = this.visible(scope, id)
    const action = row?.actions.find((candidate) => candidate.id === actionId)
    if (!row || !action) return null
    if (row.performed_action_ids.includes(action.id)) return copy(row)
    const stamp = this.now().toISOString()
    row.updated_at = stamp
    row.read_at ??= stamp
    row.performed_action_ids.push(action.id)
    if (action.acknowledges) {
      row.acknowledged_at = stamp
      row.acknowledged_action_id = action.id
    }
    this.save()
    return copy(row)
  }

  cancelUpdate(scope: UpdateNotificationScope, id: string): PublicUpdateNotification | null {
    const row = this.rows.find((entry) => entry.id === id && this.isVisible(entry, scope) && entry.kind === 'update')
    if (!row) return null
    if (row.phase === 'blocked' && row.message === 'The update was cancelled before installation.') return copy(row)
    if (row.phase !== 'awaiting_confirmation') return null
    const stamp = this.now().toISOString()
    row.phase = 'blocked'
    row.message = 'The update was cancelled before installation.'
    row.updated_at = stamp
    row.read_at ??= stamp
    this.save()
    return copy(row)
  }

  reconcileInterruptedUpdates(currentWebIdentity: string | null, currentWebVersion: string | null = null): void {
    let changed = false
    for (const row of this.rows) {
      if (row.kind !== 'update' || (row.target !== 'webui' && row.target !== 'agent') || !['applying', 'restarting'].includes(row.phase)) continue
      const phase: UpdateNotificationPhase = row.target === 'webui' && row.phase === 'restarting' && currentWebIdentity && REVISION.test(currentWebIdentity) && row.expected_identity === currentWebIdentity ? 'succeeded' : 'unknown'
      row.phase = phase
      Object.assign(row, wording(row.target, phase))
      row.updated_at = this.now().toISOString()
      row.read_at = null
      if (phase === 'succeeded') {
        row.verified_revision = currentWebIdentity
        row.verified_version = safeText(currentWebVersion, '', 80) || null
      }
      changed = true
    }
    if (changed) this.save()
  }

  private visible(scope: UpdateNotificationScope, id: string): StoredUpdateNotification | null {
    return this.rows.find((row) => row.id === id && this.isVisible(row, scope) && row.dismissed_at === null) ?? null
  }

  private isVisible(row: StoredUpdateNotification, scope: UpdateNotificationScope): boolean {
    if (row.tab_id !== null) return row.tab_id === scope.tab && row.owner === scope.owner && row.profile === scope.profile
    if (row.visibility === 'server') return scope.serverOwner === true && (row.owner === scope.owner || row.owner === '*')
    return row.owner === scope.owner && row.profile === scope.profile
  }

  private hasProtectedCapacity(row: StoredUpdateNotification): boolean {
    const peers = this.rows.filter((entry) => isProtected(entry) && isTabNotice(entry) === isTabNotice(row))
    return peers.filter((entry) => retentionBucket(entry) === retentionBucket(row)).length < PER_SCOPE_LIMIT && peers.length < GLOBAL_LIMIT
  }

  private pruneClosedTabs(): void {
    const cutoff = this.now().valueOf() - TAB_TTL_MS
    const closed = this.rows.filter((row) => row.tab_id !== null && (this.tabSeen.get(row.id) ?? this.loadedAt) < cutoff)
    if (closed.length === 0) return
    for (const row of closed) this.tabSeen.delete(row.id)
    this.rows = this.rows.filter((row) => !closed.includes(row))
    this.save()
  }

  private load(): StoredUpdateNotification[] {
    if (!existsSync(this.file)) return []
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!Array.isArray(parsed)) return []
      return parsed.flatMap((value): StoredUpdateNotification[] => {
        if (!isRecord(value)) return []
        const row = value
        if (typeof row.id !== 'string' || typeof row.owner !== 'string' || typeof row.profile !== 'string'
          || (row.target != null && row.target !== 'webui' && row.target !== 'agent') || typeof row.phase !== 'string'
          || typeof row.created_at !== 'string' || typeof row.updated_at !== 'string'
          || (row.tab_id != null && !(typeof row.tab_id === 'string' && TAB_ID.test(row.tab_id)))) return []
        const kind = safeToken(row.kind, 'update')
        const target = row.target === 'webui' || row.target === 'agent' ? row.target : null
        const phase = safeToken(row.phase, 'unknown')
        const fallback = target && PHASES.has(phase as UpdateNotificationPhase) ? wording(target, phase as UpdateNotificationPhase) : { title: 'Server notification', message: 'This server needs your attention.' }
        return [{
          id: row.id, owner: row.owner.slice(0, 256), profile: row.profile.slice(0, 64), visibility: row.visibility === 'profile' ? 'profile' : 'server', kind, target, phase,
          severity: row.severity === 'critical' || row.severity === 'warning' ? row.severity : 'info',
          persistent: row.persistent === true,
          requires_acknowledgement: row.requires_acknowledgement === true,
          actions: safeActions(row.actions),
          destination: safeDestination(row.destination),
          title: safeText(row.title, fallback.title, 160), message: safeText(row.message, fallback.message, 500),
          created_at: row.created_at, updated_at: row.updated_at,
          read_at: typeof row.read_at === 'string' ? row.read_at : null,
          acknowledged_at: typeof row.acknowledged_at === 'string' ? row.acknowledged_at : null,
          acknowledged_action_id: typeof row.acknowledged_action_id === 'string' ? row.acknowledged_action_id.slice(0, 64) : null,
          verified_revision: typeof row.verified_revision === 'string' && REVISION.test(row.verified_revision) ? row.verified_revision : null,
          verified_version: safeText(row.verified_version, '', 80) || null,
          detail: safeDetail(row.detail),
          performed_action_ids: Array.isArray(row.performed_action_ids) ? row.performed_action_ids.map((id) => safeToken(id, '')).filter(Boolean).slice(0, 16) : [],
          dismissed_at: typeof row.dismissed_at === 'string' ? row.dismissed_at : null,
          expected_identity: typeof row.expected_identity === 'string' ? row.expected_identity.slice(0, 160) : null,
          tab_id: typeof row.tab_id === 'string' ? row.tab_id : null,
          watchers: Array.isArray(row.watchers) ? row.watchers.flatMap((watcher): UpdateWatcher[] => isRecord(watcher) && typeof watcher.tab === 'string' && TAB_ID.test(watcher.tab) && typeof watcher.at === 'string' ? [{ tab: watcher.tab, at: watcher.at }] : []) : [],
        }]
      })
    } catch { return [] }
  }

  /** Tab refresh notices are bounded by `hasProtectedCapacity` and kept apart, so they never evict or block other notifications. */
  private save(): void {
    const tabNotices = this.rows.filter(isTabNotice)
    const sorted = this.rows.filter((row) => !isTabNotice(row)).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    const protectedRows = sorted.filter(isProtected)
    if (protectedRows.length > GLOBAL_LIMIT) throw new Error('Update notification protected capacity exceeded')
    const kept: StoredUpdateNotification[] = [...protectedRows]
    const counts = new Map<string, number>()
    for (const row of protectedRows) {
      const key = retentionBucket(row)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    for (const row of sorted) {
      if (isProtected(row)) continue
      const key = retentionBucket(row)
      const count = counts.get(key) ?? 0
      if (count >= PER_SCOPE_LIMIT || kept.length >= GLOBAL_LIMIT) continue
      counts.set(key, count + 1)
      kept.push(row)
    }
    this.rows = [...kept.reverse(), ...tabNotices]
    mkdirSync(dirname(this.file), { recursive: true })
    atomicWriteSecretJson(this.file, this.rows)
  }
}

const safeToken = (value: unknown, fallback: string): string => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) ? value : fallback
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const safeText = (value: unknown, fallback: string, limit: number): string => typeof value === 'string' && value.trim() ? value.trim().replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, limit) : fallback
/** Keeps line breaks (build output, recovery commands); drops other control characters. */
const safeDetail = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim().replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f]+/g, ' ').slice(0, 2000) : null
const safeActions = (value: unknown): UpdateNotificationAction[] => !Array.isArray(value) ? [] : value.slice(0, 4).flatMap((raw): UpdateNotificationAction[] => {
  if (!raw || typeof raw !== 'object') return []
  const action = raw as Partial<UpdateNotificationAction>
  const id = safeToken(action.id, '')
  const label = safeText(action.label, '', 80)
  if (!id || !label) return []
  return [{ id, label, style: action.style === 'primary' || action.style === 'destructive' ? action.style : 'default', acknowledges: action.acknowledges === true }]
})
const safeDestination = (value: unknown): UpdateNotificationDestination | null => {
  if (!value || typeof value !== 'object') return null
  const destination = value as Partial<UpdateNotificationDestination>
  const key = typeof destination.key === 'string' && /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(destination.key) ? destination.key : ''
  const label = safeText(destination.label, '', 80)
  return key && label ? { key, label } : null
}
const isTabNotice = (row: StoredUpdateNotification): boolean => row.tab_id !== null
const isDismissible = (row: StoredUpdateNotification): boolean => !row.requires_acknowledgement || row.acknowledged_at !== null
const isProtected = (row: StoredUpdateNotification): boolean => (row.requires_acknowledgement && row.acknowledged_at === null) || (row.kind === 'update' && ['applying', 'awaiting_confirmation', 'restarting'].includes(row.phase))
const retentionBucket = (row: StoredUpdateNotification): string => `${row.owner}\u0000${row.visibility === 'server' ? '*' : row.profile}`
export const updateNotificationScopeId = (scope: UpdateNotificationScope): string => createHash('sha256').update(`${scope.owner}\u0000${scope.profile}\u0000${scope.serverOwner === true ? 'owner' : 'member'}`).digest('hex').slice(0, 24)
