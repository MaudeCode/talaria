import { UpdateNotificationPhaseSchema, UpdateStepSchema, AgentUpdateOperationSchema, AgentUpdateRecoverySchema, type UpdateNotification, type AgentUpdateOperation, type AgentRecoveryState } from '@maudecode/talaria-web-contracts'
import { createHash, randomUUID } from 'node:crypto'
import { readDocument } from '../sessions/storage/document.js'
import type { DocumentBackend } from '../sessions/storage/backend.js'
import type { SessionInfo } from '../auth/store.js'
import { str } from '../util.js'
import type { GatewayProcess } from './health.js'

export function updateNotificationOwner(session: SessionInfo | null): string {
  const authType = str(session?.auth_type).trim()
  if (authType === 'oidc') {
    const issuer = str(session?.oidc_issuer).trim()
    const subject = typeof session?.oidc_subject === 'string' ? session.oidc_subject : ''
    if (issuer && subject.trim()) return `oidc:${createHash('sha256').update(JSON.stringify([issuer, subject]), 'utf8').digest('hex')}`
    const token = str(session?.token).trim()
    if (token) return `oidc-session:${createHash('sha256').update(JSON.stringify([token]), 'utf8').digest('hex')}`
  }
  const username = str(session?.username).trim()
  return username ? `${authType || 'auth'}:${username}` : 'local-owner'
}

export type UpdateNotificationTarget = 'webui' | 'agent'
/** `verifying`: the gateway restarted; the server is checking that the new gateway process and the Agent runtime answer (TAL-1138). */
export type UpdateNotificationPhase = (typeof UpdateNotificationPhaseSchema.options)[number]
/** `tab` names one open Talaria Web tab; rows stamped with a tab are visible only to that tab. `rootProfile`: `profile` names the root profile, which profile notices store as `default`. */
export interface UpdateNotificationScope { owner: string; profile: string; serverOwner?: boolean; tab?: string | null; rootProfile?: boolean }

interface StoredUpdateNotification {
  /** Agent startup identity and full-text digest stay internal, including after dismissal. */
  notice_key?: string
  notice_text_hash?: string
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
  /** The apply's own explanation of a failed or blocked attempt, or of a success that needs attention (sanitized, bounded); null otherwise. */
  detail: string | null
  performed_action_ids: string[]
  dismissed_at: string | null
  expected_identity: string | null
  tab_id: string | null
  /** Tabs that started or rejoined this update operation from Settings, with when they last did; each tab's Updating dialog follows the operation it joined most recently. */
  watchers: UpdateWatcher[]
  /** TAL-1138: the server process that scheduled this update's Talaria Web restart; any other process has restarted. */
  web_restart_boot: string | null
  /** TAL-1138: the running gateway task count the wait last saw, or null when the gateway was never busy. */
  gateway_tasks: number | null
  /** TAL-1138: the live gateway processes when the gateway restart began; the check needs a new process for each. */
  gateway_baseline: GatewayProcess[] | null
  /** TAL-1138: the step that was active when the update failed, was blocked, or lost its outcome. */
  failed_step: UpdateStepId | null
  agent_operation?: AgentUpdateOperation
  recovery?: UpdateNotification['recovery']
}

interface UpdateWatcher { tab: string; at: string }
export interface UpdateNotificationAction { id: string; label: string; style: 'default' | 'primary' | 'destructive'; acknowledges: boolean }
export interface UpdateNotificationDestination { key: string; label: string }
export interface VerifiedUpdateIdentity { revision: string | null; version: string | null }

export type UpdateStep = UpdateNotification['steps'][number]
export type UpdateStepId = UpdateStep['id']
/** How an Updating dialog showing this record may close: not at all, with Close, with Restart later, or by itself. */
export type UpdateDialogClose = 'none' | 'close' | 'restart_later' | 'auto'
export type PublicUpdateNotification = Omit<StoredUpdateNotification, 'notice_key' | 'notice_text_hash' | 'owner' | 'profile' | 'visibility' | 'dismissed_at' | 'expected_identity' | 'performed_action_ids' | 'tab_id' | 'watchers' | 'web_restart_boot' | 'gateway_tasks' | 'gateway_baseline' | 'failed_step' | 'agent_operation'> & {
  unread: boolean
  active: boolean
  requires_interaction: boolean
  can_dismiss: boolean
  steps: UpdateStep[]
  presents_dialog: boolean
  dialog_close: UpdateDialogClose
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
  detail?: string | null
  visibility?: 'server' | 'profile'
}

const PHASES = new Set<UpdateNotificationPhase>(UpdateNotificationPhaseSchema.options)
const REVISION = /^[a-f0-9]{40}$/
const PER_SCOPE_LIMIT = 50
const GLOBAL_LIMIT = 500
export const FRONTEND_BUILD = /^[a-f0-9]{64}$/
export const TAB_ID = /^[A-Za-z0-9_-]{8,64}$/
export const WEB_REFRESH_KIND = 'web_refresh'
export const WEB_REFRESH_ACTION = 'reload'
/** TAL-953: restart the gateway now instead of waiting for its running work to finish. */
export const GATEWAY_RESTART_NOW = 'restart_gateway_now'
const GATEWAY_RESTART_NOW_ACTION: UpdateNotificationAction = { id: GATEWAY_RESTART_NOW, label: 'Restart now', style: 'destructive', acknowledges: false }
/** A closed tab stops checking in; its refresh notice is dropped once unseen this long. An open tab recreates it on its next check. */
const TAB_TTL_MS = 60 * 60 * 1000
const FAILED_MESSAGE = 'The update could not be completed.'
const STEP_IDS = new Set<string>(UpdateStepSchema.shape.id.options)
/** Phases in which an update the user started presents its Updating dialog to every tab that can see it. */
const PRESENTING = new Set(['applying', 'restarting', 'verifying', 'recovering'])
const TERMINAL_FAILURE = new Set(['failed', 'blocked', 'unknown'])

/** TAL-953: the waiting gateway restart's message, with the running task count once one is known. */
const gatewayWaitingMessage = (tasks: number): string => tasks > 0
  ? `Waiting for ${String(tasks)} running gateway task${tasks === 1 ? '' : 's'} to finish before restarting the gateway.`
  : 'Waiting for running gateway tasks to finish before restarting the gateway.'

const wording = (target: UpdateNotificationTarget, phase: UpdateNotificationPhase): { title: string; message: string } => {
  const name = target === 'webui' ? 'Talaria Web' : 'Hermes Agent'
  const messages: Record<UpdateNotificationPhase, string> = {
    applying: `Installing the selected ${name} update.`,
    awaiting_confirmation: 'This Hermes Agent revision needs confirmation before it can be installed.',
    waiting_for_idle: gatewayWaitingMessage(0),
    restarting: target === 'webui' ? 'The update is installed. Talaria Web is restarting.' : 'The update is installed. The messaging gateway is restarting.',
    verifying: 'The update is installed. Checking that Hermes Agent responds.',
    recovering: 'Attempting recovery',
    succeeded: `${name} was updated successfully.`,
    blocked: 'The update is waiting for active work to finish.',
    failed: FAILED_MESSAGE,
    unknown: 'The connection closed before completion could be verified. Check the installed version before trying again.',
  }
  return { title: `${name} update`, message: messages[phase] }
}

const RELOAD_IN_DIALOG: UpdateNotificationAction = { id: WEB_REFRESH_ACTION, label: 'Reload', style: 'primary', acknowledges: false }
/** Release tags name versions as `web-v1.2.3`; the dialog shows `1.2.3`. */
const shownVersion = (version: string | null): string => version ? ` ${version.replace(/^web-(?:exp-)?v/, '')}` : ''

/** TAL-1138: the step an update is on, or null once it succeeded. `webPending`: its Talaria Web restart has not happened yet. */
function currentStep(row: StoredUpdateNotification, webPending: boolean): UpdateStepId | null {
  if (TERMINAL_FAILURE.has(row.phase)) return row.failed_step ?? 'install'
  if (row.phase === 'succeeded') return null
  if (row.phase === 'recovering') return 'recovery'
  if (row.phase === 'restarting') return row.target === 'webui' ? 'web_restart' : 'gateway_restart'
  if (row.phase === 'waiting_for_idle') return webPending ? 'web_restart' : 'gateway_wait'
  if (row.phase === 'verifying') return webPending ? 'web_restart' : 'agent_ready'
  return 'install'
}

/**
 * TAL-1138: the update's steps as the Updating dialog lists them. Web: Installing, Restarting Talaria Web, Ready.
 * Agent: Installing, Restarting Talaria Web, Waiting for gateway tasks (only once the gateway was busy), Restarting
 * gateway, Agent responding. An update that finished without restarting anything lists only the steps it ran.
 */
function updateSteps(row: StoredUpdateNotification, webPending: boolean): UpdateStep[] {
  if (row.kind !== 'update' || !row.target) return []
  const current = currentStep(row, webPending)
  const undecided = ['applying', 'awaiting_confirmation'].includes(row.phase)
  // Each restart step needs its own evidence: a scheduled Web restart, or a gateway restart under way or recorded.
  const webRestarts = undecided || row.web_restart_boot !== null || current === 'web_restart'
  const gatewayRestarts = row.recovery?.operation.failed_stage === 'gateway_restart' || undecided || ['waiting_for_idle', 'restarting'].includes(row.phase) || row.gateway_baseline !== null || current === 'gateway_wait' || current === 'gateway_restart'
  const succeeded = row.phase === 'succeeded'
  const recovered = row.recovery && ['target_installed', 'baseline_restored', 'other_revision'].includes(row.recovery.outcome)
  const tasks = row.gateway_tasks ?? 0
  const plan: [UpdateStepId, string][] = row.target === 'webui'
    ? [['install', 'Installing'], ...(webRestarts ? [['web_restart', 'Restarting Talaria Web'] as [UpdateStepId, string]] : []), ['ready', succeeded ? `Talaria Web${shownVersion(row.verified_version)} is ready` : 'Ready']]
    : [
      ['install', 'Installing'],
      ...(webRestarts ? [['web_restart', 'Restarting Talaria Web'] as [UpdateStepId, string]] : []),
      ...(row.gateway_tasks !== null || current === 'gateway_wait' ? [['gateway_wait', tasks > 0 ? `Waiting for ${String(tasks)} gateway task${tasks === 1 ? '' : 's'}` : 'Waiting for gateway tasks'] as [UpdateStepId, string]] : []),
      ...(gatewayRestarts ? [['gateway_restart', 'Restarting gateway'] as [UpdateStepId, string]] : []),
      ...(row.recovery || current === 'recovery' ? [['recovery', 'Attempting recovery'] as [UpdateStepId, string]] : []),
      ['agent_ready', succeeded || recovered ? `Hermes Agent${shownVersion(row.verified_version)} is running` : 'Agent responding'],
    ]
  const at = current === null ? plan.length : plan.findIndex(([id]) => id === current)
  if (recovered && !succeeded) return plan.map(([id, label]) => ({ id, label, state: id === (row.recovery?.operation.failed_stage ?? 'install') ? 'failed' : 'done' }))
  return plan.map(([id, label], index) => ({ id, label, state: row.phase === 'recovering' && id === row.recovery?.operation.failed_stage ? 'failed' : index < at ? 'done' : index > at ? 'pending' : TERMINAL_FAILURE.has(row.phase) ? 'failed' : 'active' }))
}

export class UpdateNotificationStore {
  private rows: StoredUpdateNotification[] = []
  private revision: string | null = null
  private writes: Promise<void> = Promise.resolve()
  /** Last check-in per tab refresh notice; kept in memory so polling never rewrites the store. */
  private readonly tabSeen = new Map<string, number>()
  private readonly loadedAt: number
  /** This server process; an update whose Web restart another process scheduled has restarted Web. */
  private readonly boot = randomUUID()

  constructor(private readonly documents: DocumentBackend, private readonly now: () => Date = () => new Date()) {
    this.loadedAt = this.now().valueOf()
  }

  async initialize(): Promise<void> { this.rows = await this.load() }

  /** Startup warnings outlive any chat or Agent. Repeats retain read/dismissal state until the full text changes. */
  async agentWarning(scope: UpdateNotificationScope, key: string, notice: { text: string; level: unknown } | null): Promise<void> {
    const row = this.rows.find((entry) => entry.kind === 'agent_warning' && entry.notice_key === key && entry.owner === scope.owner && entry.profile === scope.profile)
    if (!notice) {
      if (!row) return
      this.rows = this.rows.filter((entry) => entry !== row)
      return this.save()
    }
    const message = safeText(notice.text, '', 500)
    if (!message) return
    const textHash = createHash('sha256').update(notice.text).digest('hex')
    const severity = notice.level === 'error' ? 'critical' : notice.level === 'warn' ? 'warning' : 'info'
    if (!row) {
      await this.createRow(scope, { kind: 'agent_warning', target: 'agent', phase: 'active', severity, persistent: true, title: 'Agent warning', message }, { notice_key: key, notice_text_hash: textHash })
      return
    }
    row.updated_at = this.now().toISOString()
    if (row.notice_text_hash !== textHash) {
      row.message = message
      row.severity = severity
      row.notice_text_hash = textHash
      row.read_at = null
      row.dismissed_at = null
    }
    await this.save()
  }

  /**
   * Compare the frontend build a tab loaded with the build this server now serves. A mismatch keeps one
   * persistent, tab-scoped refresh notice per tab; a match resolves and removes it. Unknown builds change nothing.
   */
  async syncTabBuild(scope: UpdateNotificationScope, loadedBuild: string | null, currentBuild: string | null): Promise<FrontendBuildState> {
    await this.pruneClosedTabs()
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
        await this.save()
      }
      return state
    }
    state.refresh_required = true
    // TAL-1138/TAL-1622: while a Web update's Updating dialog shows in this tab, it is the tab's only reload prompt.
    if (this.rows.some((row) => row.target === 'webui' && this.isVisible(row, scope) && this.presentsDialog(row, tab, true))) {
      if (existing) {
        this.rows = this.rows.filter((row) => row !== existing)
        this.tabSeen.delete(existing.id)
        await this.save()
      }
      return state
    }
    const stamp = this.now().toISOString()
    if (existing) {
      this.tabSeen.set(existing.id, this.now().valueOf())
      if (existing.expected_identity !== current) {
        existing.expected_identity = current
        existing.updated_at = stamp
        existing.read_at = null
        await this.save()
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
      web_restart_boot: null, gateway_tasks: null, gateway_baseline: null, failed_step: null,
    }
    if (!this.hasProtectedCapacity(row)) return state
    this.rows.push(row)
    this.tabSeen.set(row.id, this.now().valueOf())
    await this.save()
    state.notification_id = row.id
    return state
  }

  async begin(scope: UpdateNotificationScope, target: UpdateNotificationTarget): Promise<PublicUpdateNotification> {
    const text = wording(target, 'applying')
    const created = (await this.create(scope, {
      kind: 'update', target, phase: 'applying', ...text,
      destination: { key: 'settings.system', label: 'Open System settings' },
      visibility: 'server',
    }))
    await this.watch(scope, created.id)
    return created
  }

  /** Saved before the native lease can change source; the row ID is the operation ID. */
  async bindAgentOperation(id: string, baseline: string, target: string): Promise<void> {
    const row = this.rows.find((entry) => entry.id === id && entry.target === 'agent' && entry.phase === 'applying')
    if (!row) throw new Error('The initiating Agent update is no longer active.')
    const operation = AgentUpdateOperationSchema.parse({ operation_id: id, baseline_revision: baseline, target_revision: target, stage: 'install' })
    if (row.agent_operation && (row.agent_operation.baseline_revision !== baseline || row.agent_operation.target_revision !== target)) throw new Error('The update target changed within the same operation.')
    row.agent_operation = operation
    await this.save()
  }

  async handoffAgentRecovery(id: string, detail: unknown, identity?: VerifiedUpdateIdentity): Promise<boolean> {
    const row = this.rows.find((entry) => entry.id === id && entry.agent_operation)
    if (!row) return false
    if (TERMINAL_FAILURE.has(row.phase) || row.phase === 'succeeded') return true
    row.recovery ??= { operation: row.agent_operation!, attempt_error: safeDetail(detail), runtime_revision: null, outcome: 'recovering' }
    row.recovery.attempt_error ??= safeDetail(detail)
    await this.transition(id, 'recovering', null, identity, row.recovery.attempt_error)
    return true
  }

  pendingAgentOperation(): string | undefined {
    return this.rows.findLast((row) => row.kind === 'update' && row.target === 'agent' && row.agent_operation && ['applying', 'recovering'].includes(row.phase))?.id
  }

  /** A retained notice still needs loaded-readiness verification after native debt clears. */
  hasPendingAgentRecovery(): boolean {
    const row = this.rows.findLast((entry) => entry.kind === 'agent_recovery')
    return this.pendingAgentOperation() !== undefined || (row !== undefined && row.phase !== 'succeeded')
  }

  /** Only a transaction-bound active operation can absorb recovery; orphan receipts retain their own notice. */
  async agentRecovery(state: AgentRecoveryState): Promise<void> {
    if (state.phase === 'idle') return
    const id = state.operation_id ?? state.operation?.operation_id
    const original = id ? this.rows.find((row) => row.id === id && row.agent_operation && ['applying', 'recovering'].includes(row.phase)) : undefined
    if (original) {
      const expected = original.agent_operation!
      const evidence = state.operation
      const bound = evidence?.operation_id === expected.operation_id && evidence.baseline_revision === expected.baseline_revision && evidence.target_revision === expected.target_revision
      original.recovery ??= { operation: expected, attempt_error: original.detail, runtime_revision: null, outcome: 'recovering' }
      const recovery = original.recovery
      if (bound) {
        const failedStage = evidence.failed_stage ?? recovery.operation.failed_stage
        recovery.operation = { ...evidence, ...(failedStage ? { failed_stage: failedStage } : {}) }
        recovery.attempt_error ??= safeDetail(evidence.attempt_error)
        original.failed_step = failedStage ?? evidence.stage
      }
      recovery.runtime_revision = state.runtime_revision ?? null
      const identity = state.verified_revision ? { revision: state.verified_revision, version: state.verified_version ?? null } : state.phase === 'complete' ? { revision: null, version: null } : undefined
      if (state.phase === 'complete') {
        const verified = bound && evidence.recovered_revision === state.verified_revision && state.runtime_revision === state.verified_revision
        const actual = state.verified_version || state.verified_revision || 'unknown version'
        recovery.rollback = verified && state.verified_revision === expected.baseline_revision ? evidence.source_moved ?? null : verified ? false : null
        recovery.outcome = !verified ? 'unknown' : state.verified_revision === expected.target_revision ? 'target_installed' : state.verified_revision === expected.baseline_revision ? 'baseline_restored' : 'other_revision'
        await this.transition(original.id, recovery.outcome === 'target_installed' ? 'succeeded' : recovery.outcome === 'unknown' ? 'unknown' : 'failed', null, identity, recovery.attempt_error)
        if (recovery.outcome === 'target_installed') original.message = `Hermes Agent ${actual} is running after automatic recovery.`
        else if (recovery.outcome === 'baseline_restored') {
          if (recovery.rollback === true) original.message = `The requested update failed. Automatic recovery rolled back to the previous revision, ${actual}.`
          else if (recovery.rollback === false) original.message = `The requested update failed. Service recovered on the unchanged previous revision, ${actual}; no rollback occurred.`
          else original.message = `The requested update failed. Service recovered on the previous revision, ${actual}; rollback could not be verified.`
        } else if (recovery.outcome === 'other_revision') original.message = `The requested update failed. Service recovered on ${actual}; the selected target was not installed.`
        else original.message = `The update outcome could not be verified after recovery. ${state.verified_revision ? 'Current version' : 'Loaded version'}: ${actual}.`
      } else if (state.phase === 'blocked') {
        recovery.outcome = 'blocked'
        await this.transition(original.id, 'blocked', null, identity, [recovery.attempt_error, state.detail].filter(Boolean).join('\n'))
        original.message = 'Automatic recovery could not finish. ' + (state.verified_version ? `Current version: ${state.verified_version}. ` : '') + 'Check the recovery details before retrying.'
        original.failed_step = 'recovery'
      } else {
        await this.transition(original.id, 'recovering', null, identity, [recovery.attempt_error, state.detail].filter(Boolean).join('\n'))
      }
      if (state.phase === 'complete' || state.phase === 'blocked') original.detail = safeDetail([original.message, original.detail, recovery.attempt_error].filter((value, index, values) => Boolean(value) && values.indexOf(value) === index).join('\n'))
      await this.save()
      if (state.phase === 'complete' && this.rows.some((row) => row.kind === 'agent_recovery' && row.phase !== 'succeeded')) {
        await this.agentRecovery({ phase: state.phase, attempt: state.attempt, detail: state.detail, retry_at: state.retry_at })
      }
      return
    }
    // A stale callback cannot rewrite a terminal attempt or create a second notice for that operation.
    if (id && this.rows.some((row) => row.id === id) && (state.phase !== 'complete' || !this.rows.some((row) => row.kind === 'agent_recovery' && row.phase !== 'succeeded'))) return
    const phase = state.phase === 'complete' ? 'succeeded' : state.phase === 'running' ? 'applying' : 'blocked'
    const title = 'Hermes Agent recovery'
    const message = state.phase === 'complete' ? 'Hermes Agent is usable again. The original update result is unchanged.'
      : state.phase === 'running' ? 'Recovering Hermes Agent after an interrupted update.'
        : state.phase === 'waiting' ? 'Hermes Agent recovery will retry automatically.' : 'Hermes Agent recovery needs attention.'
    const row = this.rows.findLast((entry) => entry.kind === 'agent_recovery')
    if (!row) {
      await this.create({ owner: '*', profile: 'default', serverOwner: true }, {
        kind: 'agent_recovery', target: 'agent', phase, title, message, visibility: 'server',
        severity: state.phase === 'blocked' ? 'warning' : 'info',
      })
      return this.agentRecovery(state)
    }
    if (row.phase === phase && row.message === message && row.detail === safeDetail(state.detail)) return
    row.phase = phase
    row.title = title
    row.message = message
    row.detail = safeDetail(state.detail)
    row.severity = state.phase === 'blocked' ? 'warning' : 'info'
    row.updated_at = this.now().toISOString()
    row.dismissed_at = null
    row.read_at = null
    await this.save()
  }

  /**
   * A question the server asks about one profile (TAL-1274), seen by every server owner while that profile is active. Its
   * open row is refreshed in place; null withdraws it once nothing asks it any more. An answered row stays as history.
   */
  async profileQuestion(profile: string, kind: string, input: CreateUpdateNotificationInput | null): Promise<void> {
    const open = this.rows.find((row) => row.kind === kind && row.owner === '*' && row.profile === profile && row.acknowledged_at === null)
    if (!input) {
      if (!open) return
      this.rows = this.rows.filter((row) => row !== open)
      return this.save()
    }
    if (!open) {
      await this.create({ owner: '*', profile, serverOwner: true }, { ...input, kind, requiresAcknowledgement: true })
      return
    }
    const message = safeText(input.message, '', 500)
    const detail = safeDetail(input.detail)
    if (!message || (open.message === message && open.detail === detail)) return
    open.message = message
    open.detail = detail
    open.updated_at = this.now().toISOString()
    open.read_at = null
    await this.save()
  }

  /** Drop all profile-scoped state, including dismissed warning identities, when a profile is deleted. */
  async forgetProfile(profile: string): Promise<void> {
    const kept = this.rows.filter((row) => !(row.visibility === 'profile' && row.profile === profile))
    if (kept.length === this.rows.length) return
    this.rows = kept
    await this.save()
  }

  /** The open question `id` of `kind` this scope sees, or null. */
  openQuestion(scope: UpdateNotificationScope, id: string, kind: string): PublicUpdateNotification | null {
    const row = this.visible(scope, id)
    return row?.kind === kind && row.owner === '*' && row.acknowledged_at === null ? this.publish(row, scope.tab) : null
  }

  /** Record the answer to an open question: its outcome replaces the question, which then leaves only Dismiss. */
  async answerQuestion(scope: UpdateNotificationScope, id: string, kind: string, actionId: string, outcome: string): Promise<PublicUpdateNotification | null> {
    const row = this.visible(scope, id)
    if (row?.kind !== kind || row.owner !== '*' || row.acknowledged_at !== null || !row.actions.some((action) => action.id === actionId)) return null
    const stamp = this.now().toISOString()
    Object.assign(row, {
      phase: 'succeeded', severity: 'info', message: safeText(outcome, row.message, 500), detail: null, actions: [],
      updated_at: stamp, read_at: row.read_at ?? stamp, acknowledged_at: stamp, acknowledged_action_id: actionId,
      performed_action_ids: [...row.performed_action_ids, actionId],
    })
    await this.save()
    return this.publish(row, scope.tab)
  }

  /** Let the requesting tab follow an update operation it started or rejoined. Watchers live as long as the record; only a server owner's Update click adds one. */
  async watch(scope: UpdateNotificationScope, id: string): Promise<void> {
    const tab = scope.tab && TAB_ID.test(scope.tab) ? scope.tab : null
    const row = this.rows.find((entry) => entry.id === id && entry.kind === 'update' && this.isVisible(entry, scope))
    if (!tab || !row) return
    row.watchers = [...row.watchers.filter((watcher) => watcher.tab !== tab), { tab, at: this.now().toISOString() }]
    await this.save()
  }

  async create(scope: UpdateNotificationScope, input: CreateUpdateNotificationInput): Promise<PublicUpdateNotification> {
    return this.publish(await this.createRow(scope, input))
  }

  private async createRow(scope: UpdateNotificationScope, input: CreateUpdateNotificationInput, notice: Pick<StoredUpdateNotification, 'notice_key' | 'notice_text_hash'> = {}): Promise<StoredUpdateNotification> {
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
      ...notice, kind, target: input.target ?? null, phase, severity: input.severity ?? 'info',
      persistent: input.requiresAcknowledgement === true || input.persistent === true,
      requires_acknowledgement: input.requiresAcknowledgement === true, actions,
      destination: safeDestination(input.destination), title, message,
      created_at: stamp, updated_at: stamp, read_at: null, acknowledged_at: null,
      acknowledged_action_id: null, verified_revision: null, verified_version: null, detail: safeDetail(input.detail),
      performed_action_ids: [], dismissed_at: null, expected_identity: null, tab_id: null, watchers: [],
      web_restart_boot: null, gateway_tasks: null, gateway_baseline: null, failed_step: null,
    }
    if (!this.hasProtectedCapacity(row)) throw new Error('Update notification protected capacity reached')
    this.rows.push(row)
    await this.save()
    return row
  }

  activeUpdate(scope: UpdateNotificationScope, target: UpdateNotificationTarget): PublicUpdateNotification | null {
    const row = [...this.rows].reverse().find((entry) => this.isVisible(entry, scope) && entry.kind === 'update' && entry.target === target && ['applying', 'awaiting_confirmation', 'restarting', 'verifying', 'recovering'].includes(entry.phase))
    return row ? this.publish(row) : null
  }

  async transition(id: string, phase: UpdateNotificationPhase, expectedIdentity?: string | null, verifiedIdentity?: VerifiedUpdateIdentity, detail?: unknown): Promise<PublicUpdateNotification | null> {
    const row = this.rows.find((entry) => entry.id === id)
    if (!row) return null
    if (phase === 'applying' && !['applying', 'awaiting_confirmation'].includes(row.phase)) return this.publish(row)
    const failedStep = currentStep(row, this.webPending(row))
    if (phase === 'failed' && row.target === 'agent' && row.agent_operation && ['restarting', 'verifying'].includes(row.phase)
        && (failedStep === 'gateway_restart' || failedStep === 'agent_ready')) {
      row.recovery ??= { operation: { ...row.agent_operation, failed_stage: failedStep }, attempt_error: safeDetail(detail), runtime_revision: null, outcome: 'recovering' }
      phase = 'recovering'
    }
    const phaseChanged = row.phase !== phase
    // TAL-1138: a failure keeps the step it stopped at, so the dialog marks that step failed.
    if (!TERMINAL_FAILURE.has(phase)) row.failed_step = null
    else if (!TERMINAL_FAILURE.has(row.phase)) row.failed_step = currentStep(row, this.webPending(row)) ?? 'install'
    if (row.kind === 'update' && row.target === 'webui' && phase === 'restarting') row.web_restart_boot = this.boot
    row.phase = phase
    if (row.target) Object.assign(row, wording(row.target, phase))
    if (phase === 'awaiting_confirmation') row.message = safeText(detail, row.message, 500)
    row.updated_at = this.now().toISOString()
    if (phaseChanged) row.read_at = null
    row.expected_identity = expectedIdentity?.trim().slice(0, 160) || null
    row.detail = phase === 'applying' || phase === 'failed' || phase === 'blocked' || phase === 'succeeded' || phase === 'waiting_for_idle' || phase === 'verifying' || phase === 'recovering' || phase === 'unknown' ? safeDetail(detail) : null
    // The gateway restart is server-wide: every server owner sees the wait and can restart now, and a later update joins it.
    if (row.kind === 'update' && phase === 'waiting_for_idle' && row.visibility === 'server') row.owner = '*'
    // Only a waiting gateway restart offers an action; entering the wait offers it afresh.
    if (row.kind === 'update') {
      row.actions = phase === 'waiting_for_idle' ? [GATEWAY_RESTART_NOW_ACTION] : []
      row.performed_action_ids = row.performed_action_ids.filter((action) => action !== GATEWAY_RESTART_NOW)
    }
    if (verifiedIdentity) {
      row.verified_revision = typeof verifiedIdentity.revision === 'string' && REVISION.test(verifiedIdentity.revision) ? verifiedIdentity.revision : null
      row.verified_version = safeText(verifiedIdentity.version, '', 80) || null
    }
    await this.save()
    return this.publish(row)
  }

  /** TAL-953: update the waiting gateway restart's message as its running task count changes. */
  async gatewayWaiting(id: string, tasks: number): Promise<void> {
    const row = this.rows.find((entry) => entry.id === id && entry.kind === 'update' && entry.phase === 'waiting_for_idle')
    const message = gatewayWaitingMessage(tasks)
    const counted = tasks > 0 ? tasks : row?.gateway_tasks ?? null
    if (!row || (row.message === message && row.gateway_tasks === counted)) return
    row.message = message
    row.gateway_tasks = counted
    row.updated_at = this.now().toISOString()
    await this.save()
  }

  /** TAL-1138: this Agent update scheduled a Talaria Web restart; its gateway steps follow the restarted server. */
  async markWebRestart(id: string): Promise<void> {
    const row = this.rows.find((entry) => entry.id === id && entry.kind === 'update')
    if (!row || row.web_restart_boot === this.boot) return
    row.web_restart_boot = this.boot
    row.updated_at = this.now().toISOString()
    await this.save()
  }

  /** TAL-1138: the live gateway processes a restart must replace before the update's check can pass. */
  async recordGatewayBaseline(id: string, baseline: GatewayProcess[]): Promise<void> {
    const row = this.rows.find((entry) => entry.id === id && entry.kind === 'update')
    if (!row) return
    row.gateway_baseline = baseline.slice(0, 8).map((entry) => ({ ...entry }))
    await this.save()
  }

  /**
   * TAL-953: gateway restarts still waiting for idle, and (TAL-1138) restarted gateways still being checked, newest
   * first, with the profile each update ran under, so a restarted server resumes them.
   */
  pendingGatewayRestarts(): { id: string; profile: string; detail: string | null; phase: 'waiting_for_idle' | 'verifying'; baseline: GatewayProcess[] | null }[] {
    return this.rows.filter((row) => row.kind === 'update' && (row.phase === 'waiting_for_idle' || row.phase === 'verifying'))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((row) => ({ id: row.id, profile: row.profile, detail: row.detail, phase: row.phase as 'waiting_for_idle' | 'verifying', baseline: row.gateway_baseline }))
  }

  /** `stale`: the requesting tab runs an older frontend build than the server serves (`syncTabBuild`'s comparison). */
  async list(scope: UpdateNotificationScope, stale = false): Promise<UpdateNotificationList> {
    await this.pruneClosedTabs()
    const scoped = this.rows.filter((row) => this.isVisible(row, scope) && row.dismissed_at === null)
    const ordered = scoped.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    const protectedRows = ordered.filter(isProtected)
    const visible = [...protectedRows, ...ordered.filter((row) => !isProtected(row)).slice(0, Math.max(0, PER_SCOPE_LIMIT - protectedRows.length))]
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    const tab = scope.tab && TAB_ID.test(scope.tab) ? scope.tab : null
    const notifications = visible.map((row) => this.publish(row, tab, stale))
    const clearableCount = scoped.filter(isDismissible).length
    const joinedAt = (row: StoredUpdateNotification) => row.watchers.find((watcher) => watcher.tab === tab)?.at ?? ''
    const tabUpdate = tab ? this.rows.filter((row) => row.kind === 'update' && joinedAt(row) !== '' && this.isVisible(row, scope))
      .sort((a, b) => joinedAt(b).localeCompare(joinedAt(a)) || b.created_at.localeCompare(a.created_at))[0] : undefined
    return { scope_id: updateNotificationScopeId(scope), notifications, tab_update: tabUpdate ? this.publish(tabUpdate, tab, stale) : null, tab_joined_at: tabUpdate ? joinedAt(tabUpdate) : null, unread_count: visible.filter((row) => row.read_at === null).length, clearable_count: clearableCount, can_clear: clearableCount > 0 }
  }

  async clear(scope: UpdateNotificationScope, stale = false): Promise<UpdateNotificationList> {
    const stamp = this.now().toISOString()
    let changed = false
    for (const row of this.rows) {
      if (!this.isVisible(row, scope) || row.dismissed_at !== null || !isDismissible(row)) continue
      row.dismissed_at = stamp
      changed = true
    }
    if (changed) (await this.save())
    return (await this.list(scope, stale))
  }

  async read(scope: UpdateNotificationScope, id: string): Promise<PublicUpdateNotification | null> {
    const row = this.visible(scope, id)
    if (!row) return null
    if (row.read_at === null) { row.read_at = this.now().toISOString(); (await this.save()) }
    return this.publish(row)
  }

  async dismiss(scope: UpdateNotificationScope, id: string): Promise<'dismissed' | 'not_found' | 'acknowledgement_required'> {
    const row = this.rows.find((entry) => entry.id === id && this.isVisible(entry, scope))
    if (!row) return 'not_found'
    if (!isDismissible(row)) return 'acknowledgement_required'
    if (row.dismissed_at === null) { const stamp = this.now().toISOString(); row.dismissed_at = stamp; row.read_at ??= stamp; (await this.save()) }
    return 'dismissed'
  }

  async action(scope: UpdateNotificationScope, id: string, actionId: string): Promise<PublicUpdateNotification | null> {
    const row = this.visible(scope, id)
    // A Reload in the Updating dialog is offered only while the tab is stale; the action itself never depends on it.
    const action = row ? this.publish(row, scope.tab, true).actions.find((candidate) => candidate.id === actionId) : undefined
    if (!row || !action) return null
    if (row.performed_action_ids.includes(action.id)) return this.publish(row, scope.tab, true)
    const stamp = this.now().toISOString()
    row.updated_at = stamp
    row.read_at ??= stamp
    row.performed_action_ids.push(action.id)
    if (action.acknowledges) {
      row.acknowledged_at = stamp
      row.acknowledged_action_id = action.id
    }
    await this.save()
    return this.publish(row, scope.tab, true)
  }

  async cancelUpdate(scope: UpdateNotificationScope, id: string): Promise<PublicUpdateNotification | null> {
    const row = this.rows.find((entry) => entry.id === id && this.isVisible(entry, scope) && entry.kind === 'update')
    if (!row) return null
    if (row.phase === 'blocked' && row.message === 'The update was cancelled before installation.') return this.publish(row)
    if (row.phase !== 'awaiting_confirmation') return null
    const stamp = this.now().toISOString()
    row.phase = 'blocked'
    row.message = 'The update was cancelled before installation.'
    row.updated_at = stamp
    row.read_at ??= stamp
    await this.save()
    return this.publish(row)
  }

  async reconcileInterruptedUpdates(currentWebIdentity: string | null, currentWebVersion: string | null = null): Promise<void> {
    let changed = false
    for (const row of this.rows) {
      if (row.kind === 'agent_recovery' && row.phase === 'applying') {
        row.phase = 'unknown'
        row.message = 'Agent recovery was interrupted. Current readiness has not been verified.'
        row.severity = 'warning'
        row.updated_at = this.now().toISOString()
        row.read_at = null
        changed = true
        continue
      }
      if (row.kind === 'update' && row.agent_operation && row.phase === 'applying') {
        row.phase = 'recovering'
        Object.assign(row, wording('agent', 'recovering'))
        row.updated_at = this.now().toISOString()
        row.read_at = null
        changed = true
        continue
      }
      if (row.kind !== 'update' || (row.target !== 'webui' && row.target !== 'agent') || !['applying', 'restarting'].includes(row.phase)) continue
      const phase: UpdateNotificationPhase = row.target === 'webui' && row.phase === 'restarting' && currentWebIdentity && REVISION.test(currentWebIdentity) && row.expected_identity === currentWebIdentity ? 'succeeded' : 'unknown'
      row.failed_step = phase === 'unknown' ? currentStep(row, false) ?? 'install' : null
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
    if (changed) (await this.save())
  }

  /** TAL-1138: this update's Talaria Web restart is scheduled but has not happened yet. */
  private webPending(row: StoredUpdateNotification): boolean { return row.web_restart_boot === this.boot }

  /**
   * TAL-1138: a Web update that `tab` started finished while the tab still runs the old build. The tab's Updating
   * dialog offers Reload in place of the separate refresh notice; a later Web update takes that over.
   */
  private reloadsInDialog(row: StoredUpdateNotification, tab: string | null | undefined, stale: boolean): boolean {
    if (!stale || !tab || row.kind !== 'update' || row.target !== 'webui' || row.phase !== 'succeeded' || !row.watchers.some((watcher) => watcher.tab === tab)) return false
    return !this.rows.some((other) => other !== row && other.kind === 'update' && other.target === 'webui' && other.created_at > row.created_at)
  }

  /** Whether `tab` shows this record's Updating dialog: while a user-started update runs, or to offer its Reload. */
  private presentsDialog(row: StoredUpdateNotification, tab: string | null | undefined, stale: boolean): boolean {
    return this.reloadsInDialog(row, tab, stale) || (row.kind === 'update' && row.watchers.length > 0 && (PRESENTING.has(row.phase) || (row.phase === 'waiting_for_idle' && this.webPending(row))))
  }

  /** The record as clients see it; `tab` and `stale` (its loaded build is not the one served) decide the Reload in its dialog. */
  private publish(row: StoredUpdateNotification, tab: string | null = null, stale = false): PublicUpdateNotification {
    const webPending = this.webPending(row)
    const reload = this.reloadsInDialog(row, tab, stale)
    const presents = this.presentsDialog(row, tab, stale)
    return {
      id: row.id, kind: row.kind, target: row.target, phase: row.phase, severity: row.severity,
      persistent: row.persistent, requires_acknowledgement: row.requires_acknowledgement,
      // The Restart now action waits for the restarted Web server, which runs the gateway restart.
      actions: reload ? [RELOAD_IN_DIALOG] : row.kind === 'update' && row.phase === 'waiting_for_idle' && webPending ? [] : row.actions,
      destination: row.kind === 'update' && row.phase === 'failed' && row.destination?.key === 'settings.system' ? null : row.destination,
      title: row.title,
      // Old persisted failures still carry the obsolete guidance; correct only that generic copy.
      message: row.kind === 'update' && row.phase === 'failed' && row.message === `${FAILED_MESSAGE} Open System settings for details.` ? FAILED_MESSAGE : row.message,
      created_at: row.created_at, updated_at: row.updated_at, read_at: row.read_at,
      acknowledged_at: row.acknowledged_at, acknowledged_action_id: row.acknowledged_action_id,
      verified_revision: row.verified_revision, verified_version: row.verified_version, detail: row.detail,
      ...(row.recovery ? { recovery: row.recovery } : {}),
      unread: row.read_at === null,
      active: ['update', 'agent_recovery'].includes(row.kind) && PRESENTING.has(row.phase),
      requires_interaction: row.requires_acknowledgement && row.acknowledged_at === null,
      can_dismiss: isDismissible(row),
      steps: updateSteps(row, webPending),
      presents_dialog: presents,
      dialog_close: presents ? 'none' : row.kind !== 'update' ? 'close' : row.phase === 'waiting_for_idle' ? 'restart_later' : row.phase === 'succeeded' ? 'auto' : 'close',
    }
  }

  private visible(scope: UpdateNotificationScope, id: string): StoredUpdateNotification | null {
    return this.rows.find((row) => row.id === id && this.isVisible(row, scope) && row.dismissed_at === null) ?? null
  }

  private isVisible(row: StoredUpdateNotification, scope: UpdateNotificationScope): boolean {
    if (row.tab_id !== null) return row.tab_id === scope.tab && row.owner === scope.owner && row.profile === scope.profile
    if (row.visibility === 'server') return scope.serverOwner === true && (row.owner === scope.owner || row.owner === '*')
    if (row.owner === '*') return scope.serverOwner === true && (row.profile === scope.profile || (row.profile === 'default' && scope.rootProfile === true))
    return row.owner === scope.owner && row.profile === scope.profile
  }

  private hasProtectedCapacity(row: StoredUpdateNotification): boolean {
    const peers = this.rows.filter((entry) => isProtected(entry) && isTabNotice(entry) === isTabNotice(row))
    return peers.filter((entry) => retentionBucket(entry) === retentionBucket(row)).length < PER_SCOPE_LIMIT && peers.length < GLOBAL_LIMIT
  }

  private async pruneClosedTabs(): Promise<void> {
    const cutoff = this.now().valueOf() - TAB_TTL_MS
    const closed = this.rows.filter((row) => row.tab_id !== null && (this.tabSeen.get(row.id) ?? this.loadedAt) < cutoff)
    if (closed.length === 0) return
    for (const row of closed) this.tabSeen.delete(row.id)
    this.rows = this.rows.filter((row) => !closed.includes(row))
    await this.save()
  }

  private async load(): Promise<StoredUpdateNotification[]> {
    try {
      const record = await readDocument(this.documents, 'update-notifications', 'update-notifications', { replaceInvalid: true })
      this.revision = record?.revision ?? null
      const parsed = record?.value
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
        // TAL-1138: `verifying` is stored as Stable's `restarting` plus a flag Stable ignores.
        const phase = row.phase === 'restarting' && row.recovering === true ? 'recovering' : row.phase === 'restarting' && row.verifying === true ? 'verifying' : safeToken(row.phase, 'unknown')
        const fallback = target && PHASES.has(phase as UpdateNotificationPhase) ? wording(target, phase as UpdateNotificationPhase) : { title: 'Server notification', message: 'This server needs your attention.' }
        return [{
          ...(typeof row.notice_key === 'string' ? { notice_key: row.notice_key, notice_text_hash: typeof row.notice_text_hash === 'string' ? row.notice_text_hash : '' } : {}),
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
          web_restart_boot: typeof row.web_restart_boot === 'string' ? row.web_restart_boot.slice(0, 64) : null,
          gateway_tasks: typeof row.gateway_tasks === 'number' && Number.isInteger(row.gateway_tasks) && row.gateway_tasks > 0 ? row.gateway_tasks : null,
          gateway_baseline: Array.isArray(row.gateway_baseline) ? row.gateway_baseline.slice(0, 8).flatMap((entry): GatewayProcess[] => isRecord(entry) && typeof entry.dir === 'string' && typeof entry.pid === 'number' && Number.isInteger(entry.pid) && entry.pid > 0 && (entry.start_time === null || typeof entry.start_time === 'number') ? [{ dir: entry.dir, pid: entry.pid, start_time: entry.start_time }] : []) : null,
          ...(AgentUpdateOperationSchema.safeParse(row.agent_operation).success ? { agent_operation: AgentUpdateOperationSchema.parse(row.agent_operation) } : {}),
          ...(AgentUpdateRecoverySchema.safeParse(row.recovery).success ? { recovery: AgentUpdateRecoverySchema.parse(row.recovery) } : {}),
          failed_step: typeof row.failed_step === 'string' && STEP_IDS.has(row.failed_step) ? row.failed_step as UpdateStepId : null,
        }]
      })
    } catch { return [] }
  }

  /** Tab refresh notices are bounded by `hasProtectedCapacity` and kept apart, so they never evict or block other notifications. */
  private async save(): Promise<void> {
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
    // TAL-1138 fields are written only once set, so records that never use them keep their stored bytes. A check in
    // progress is stored as `restarting`, which the current Stable release counts as active and reconciles on startup.
    const rows = structuredClone(this.rows).map(({ web_restart_boot, gateway_tasks, gateway_baseline, failed_step, ...row }) => ({
      ...row,
      ...(row.phase === 'verifying' ? { phase: 'restarting', verifying: true } : {}),
      ...(row.phase === 'recovering' ? { phase: 'restarting', recovering: true } : {}),
      ...(web_restart_boot === null ? {} : { web_restart_boot }),
      ...(gateway_tasks === null ? {} : { gateway_tasks }),
      ...(gateway_baseline === null ? {} : { gateway_baseline }),
      ...(failed_step === null ? {} : { failed_step }),
    }))
    const write = this.writes.catch(() => undefined).then(async () => { this.revision = await this.documents.put('update-notifications', 'update-notifications', rows, this.revision) })
    this.writes = write
    await write
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
/** A waiting gateway restart carries its Restart now action, so it stays until the restart runs. */
const isWaitingGatewayRestart = (row: StoredUpdateNotification): boolean => row.kind === 'update' && row.phase === 'waiting_for_idle'
const isDismissible = (row: StoredUpdateNotification): boolean => (!row.requires_acknowledgement || row.acknowledged_at !== null) && !isWaitingGatewayRestart(row) && !(row.kind === 'update' && row.phase === 'recovering')
/** Warning identities, including dismissed rows, must survive ordinary history pruning. */
const isProtected = (row: StoredUpdateNotification): boolean => row.kind === 'agent_warning' || (row.requires_acknowledgement && row.acknowledged_at === null) || (row.kind === 'update' && ['applying', 'awaiting_confirmation', 'waiting_for_idle', 'restarting', 'verifying', 'recovering'].includes(row.phase))
const retentionBucket = (row: StoredUpdateNotification): string => `${row.owner}\u0000${row.visibility === 'server' ? '*' : row.profile}`
export const updateNotificationScopeId = (scope: UpdateNotificationScope): string => createHash('sha256').update(`${scope.owner}\u0000${scope.profile}\u0000${scope.serverOwner === true ? 'owner' : 'member'}`).digest('hex').slice(0, 24)
