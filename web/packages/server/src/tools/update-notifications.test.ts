import { initializeStore } from '../test/storage.js'
import { JsonDocuments } from '../test/storage.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { UpdateNotificationStore, type UpdateNotificationScope } from './update-notifications.js'
import { gatewayDrainDetail } from './updates.js'

const roots: string[] = []
const temp = () => { const path = mkdtempSync(join(tmpdir(), 'talaria-notifications-')); roots.push(path); return path }
const alice: UpdateNotificationScope = { owner: 'oidc:alice', profile: 'work', serverOwner: true }

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('UpdateNotificationStore', () => {
  it.each([['error', 'critical'], ['warn', 'warning'], ['info', 'info'], ['success', 'info']])('persists startup %s warnings with %s severity and scoped dismissal', async (level, severity) => {
    const root = temp()
    let now = new Date('2026-10-14T12:00:00Z')
    const store = await initializeStore(new UpdateNotificationStore(new JsonDocuments(root), () => now))
    const key = 'startup-warning.1234'
    const text = 'Synthetic Agent startup warning.'
    await Promise.all([store.agentWarning(alice, key, { text, level }), store.agentWarning(alice, key, { text, level })])
    const original = (await store.list(alice)).notifications[0]!
    expect((await store.list(alice)).notifications).toHaveLength(1)
    expect(original).toMatchObject({ kind: 'agent_warning', severity, persistent: true, actions: [], destination: null })
    expect(original).not.toHaveProperty('notice_key')
    expect(original).not.toHaveProperty('notice_text_hash')
    await store.read(alice, original.id)
    now = new Date('2026-10-14T12:01:00Z')
    await store.agentWarning(alice, key, { text, level: 'error' })
    expect((await store.list(alice)).notifications[0]).toMatchObject({ ...original, updated_at: now.toISOString(), read_at: '2026-10-14T12:00:00.000Z', unread: false })
    await store.dismiss(alice, original.id)
    const restarted = await initializeStore(new UpdateNotificationStore(new JsonDocuments(root), () => now))
    await restarted.agentWarning(alice, key, { text, level })
    expect((await restarted.list(alice)).notifications).toEqual([])
    const bob = { ...alice, owner: 'oidc:bob' }
    const personal = { ...alice, profile: 'personal' }
    for (const scope of [bob, personal]) await restarted.agentWarning(scope, key, { text, level })
    await restarted.agentWarning(alice, key, { text: text + ' Changed.', level })
    expect((await restarted.list(alice)).notifications).toMatchObject([{ id: original.id, unread: true, read_at: null, message: text + ' Changed.' }])
    await restarted.agentWarning(alice, key, null)
    await restarted.agentWarning(alice, key, null)
    expect((await restarted.list(alice)).notifications).toEqual([])
    for (const scope of [bob, personal]) expect((await restarted.list(scope)).notifications).toHaveLength(1)
  })

  it('keeps a dismissed startup warning identity when ordinary history is pruned', async () => {
    const root = temp()
    const store = await initializeStore(new UpdateNotificationStore(new JsonDocuments(root)))
    const key = 'startup-warning.retained'
    const warning = { text: 'Retain this warning identity.', level: 'warn' }
    await store.agentWarning(alice, key, warning)
    const original = (await store.list(alice)).notifications[0]!
    await store.dismiss(alice, original.id)
    for (let i = 0; i < 55; i++) await store.create(alice, { kind: 'system', phase: 'notice', title: 'Synthetic notice', message: String(i) })
    const restarted = await initializeStore(new UpdateNotificationStore(new JsonDocuments(root)))
    await restarted.agentWarning(alice, key, warning)
    expect((await restarted.list(alice)).notifications.some((row) => row.kind === 'agent_warning')).toBe(false)
  })

  it('reopens a warning when text beyond the display limit changes', async () => {
    const store = await initializeStore(new UpdateNotificationStore(new JsonDocuments(temp())))
    const key = 'startup-warning.long'
    await store.agentWarning(alice, key, { text: 'x'.repeat(501), level: 'warn' })
    const original = (await store.list(alice)).notifications[0]!
    await store.dismiss(alice, original.id)
    await store.agentWarning(alice, key, { text: 'x'.repeat(500) + 'y', level: 'warn' })
    expect((await store.list(alice)).notifications).toMatchObject([{ id: original.id, unread: true }])
  })

  it('follows the operation a tab rejoined within the millisecond it started another', async () => {
    const now = new Date('2026-10-14T12:00:00Z')
    const scope = { ...alice, tab: 'tab-rejoin' }
    const store = await initializeStore(new UpdateNotificationStore(new JsonDocuments(temp()), () => now))
    const waiting = await store.begin(scope, 'agent')
    const repeated = await store.begin(scope, 'agent')
    await store.watch(scope, waiting.id)
    expect((await store.list(scope)).tab_update?.id).toBe(waiting.id)
    expect(repeated.id).not.toBe(waiting.id)
  })

  it('keeps the initiating dialog active and non-dismissible throughout automatic recovery', async () => {
    const root = temp()
    const scope = { ...alice, tab: 'tab-recovery' }
    const store = await initializeStore(new UpdateNotificationStore(new JsonDocuments(root)))
    const original = await store.begin(scope, 'agent')
    await store.transition(original.id, 'recovering', null, { revision: 'b'.repeat(40), version: '2.0.0' }, 'Synthetic service resume failed.')
    await store.watch({ ...scope, tab: 'tab-secondclient' }, original.id)
    const expected = { id: original.id, phase: 'recovering', active: true, presents_dialog: true, dialog_close: 'none', can_dismiss: false }
    expect((await store.list(scope)).tab_update).toMatchObject(expected)
    expect((await store.list(scope)).tab_update?.steps).toContainEqual({ id: 'recovery', label: 'Attempting recovery', state: 'active' })
    expect(await store.dismiss(scope, original.id)).toBe('acknowledgement_required')
    const restarted = await initializeStore(new UpdateNotificationStore(new JsonDocuments(root)))
    await restarted.reconcileInterruptedUpdates(null)
    expect((await restarted.list(scope)).tab_update).toMatchObject(expected)
    expect((await restarted.list({ ...scope, tab: 'tab-secondclient' })).tab_update).toMatchObject(expected)
    await restarted.transition(original.id, 'applying', null, undefined, 'Late progress frame')
    expect((await restarted.list(scope)).tab_update).toMatchObject(expected)
  })

  it.each(['target', 'baseline', 'other', 'wrong-runtime', 'missing-target', 'blocked'] as const)('reports transaction-bound recovery truthfully: %s', async (outcome) => {
    const root = temp()
    const scope = { ...alice, tab: 'tab-recovery' }
    let store = await initializeStore(new UpdateNotificationStore(new JsonDocuments(root)))
    if (outcome === 'target') await store.agentRecovery({ phase: 'waiting', attempt: 1, detail: 'Earlier standalone recovery.', retry_at: null })
    const original = await store.begin(scope, 'agent')
    const baseline = 'a'.repeat(40), target = 'b'.repeat(40)
    await store.bindAgentOperation(original.id, baseline, target)
    await store.handoffAgentRecovery(original.id, 'Synthetic resume failed.')
    store = await initializeStore(new UpdateNotificationStore(new JsonDocuments(root)))
    await store.reconcileInterruptedUpdates(null)
    const revision = outcome === 'baseline' ? baseline : outcome === 'other' ? 'c'.repeat(40) : target
    const operation = { operation_id: original.id, baseline_revision: baseline, target_revision: target, stage: 'gateway_restart' as const, failed_stage: 'gateway_restart' as const, source_moved: true, recovered_revision: revision }
    for (const phase of ['running', 'waiting'] as const) {
      await store.agentRecovery({ phase, attempt: 1, retry_at: null, detail: 'Synthetic bounded retry.', operation_id: original.id, operation })
      expect((await store.list(scope)).tab_update).toMatchObject({ id: original.id, phase: 'recovering', active: true, dialog_close: 'none', recovery: { attempt_error: 'Synthetic resume failed.', operation: { failed_stage: 'gateway_restart' } } })
      expect((await store.list(scope)).tab_update?.steps).toContainEqual({ id: 'gateway_restart', label: 'Restarting gateway', state: 'failed' })
    }
    await store.agentRecovery({ phase: outcome === 'blocked' ? 'blocked' : 'complete', attempt: 3, retry_at: null, detail: 'Synthetic supervisor is unavailable.', operation_id: original.id,
      ...(outcome === 'missing-target' ? {} : { operation }), verified_revision: revision, runtime_revision: outcome === 'wrong-runtime' ? baseline : revision, verified_version: 'v2.0.0' })
    const final = (await store.list(scope)).tab_update!
    expect(final).toMatchObject({ phase: outcome === 'target' ? 'succeeded' : outcome === 'blocked' ? 'blocked' : ['wrong-runtime', 'missing-target'].includes(outcome) ? 'unknown' : 'failed', active: false, presents_dialog: false, dialog_close: outcome === 'target' ? 'auto' : 'close', verified_revision: revision })
    expect(final.message).toContain(outcome === 'target' ? 'after automatic recovery' : outcome === 'baseline' ? 'rolled back to the previous revision' : outcome === 'other' ? 'selected target was not installed' : outcome === 'blocked' ? 'could not finish' : 'could not be verified')
    expect(final.detail).toContain('Synthetic resume failed.')
    if (outcome === 'target') expect((await store.list(scope)).notifications.find((row) => row.kind === 'agent_recovery')).toMatchObject({ phase: 'succeeded', message: 'Hermes Agent is usable again. The original update result is unchanged.' })
    const newer = await store.begin(scope, 'agent')
    await store.bindAgentOperation(newer.id, target, 'd'.repeat(40))
    await store.handoffAgentRecovery(newer.id, 'New operation failed.')
    await store.agentRecovery({ phase: 'complete', attempt: 4, retry_at: null, detail: '', operation_id: original.id, operation, verified_revision: target, runtime_revision: target })
    expect((await store.list(scope)).tab_update).toMatchObject({ id: newer.id, phase: 'recovering', active: true })
    expect((await store.list(scope)).notifications.find((row) => row.id === original.id)).toEqual(final)
  })

  it('resumes a bound apply whose response was lost at server restart', async () => {
    const root = temp()
    const scope = { ...alice, tab: 'tab-recovery' }
    const store = await initializeStore(new UpdateNotificationStore(new JsonDocuments(root)))
    const original = await store.begin(scope, 'agent')
    await store.bindAgentOperation(original.id, 'a'.repeat(40), 'b'.repeat(40))
    const restarted = await initializeStore(new UpdateNotificationStore(new JsonDocuments(root)))
    await restarted.reconcileInterruptedUpdates(null)
    expect((await restarted.list(scope)).tab_update).toMatchObject({ id: original.id, phase: 'recovering', message: 'Attempting recovery', active: true, dialog_close: 'none' })
    await restarted.agentRecovery({ phase: 'complete', attempt: 1, detail: '', retry_at: null,
      operation: { operation_id: original.id, baseline_revision: 'a'.repeat(40), target_revision: 'b'.repeat(40), stage: 'agent_ready', recovered_revision: 'b'.repeat(40) },
      verified_revision: 'b'.repeat(40), runtime_revision: 'b'.repeat(40), verified_version: 'v2.0.0' })
    expect((await restarted.list(scope)).tab_update).toMatchObject({ id: original.id, phase: 'succeeded', dialog_close: 'auto' })
  })

  it('hands a correlated readiness failure to recovery before making it terminal', async () => {
    const scope = { ...alice, tab: 'tab-recovery' }
    const store = await initializeStore(new UpdateNotificationStore(new JsonDocuments(temp())))
    const original = await store.begin(scope, 'agent')
    await store.bindAgentOperation(original.id, 'a'.repeat(40), 'b'.repeat(40))
    await store.transition(original.id, 'verifying', null, { revision: 'b'.repeat(40), version: 'v2.0.0' })
    await store.transition(original.id, 'failed', null, undefined, 'Synthetic loaded runtime is not ready.')
    expect((await store.list(scope)).tab_update).toMatchObject({ id: original.id, phase: 'recovering', active: true, dialog_close: 'none', recovery: { attempt_error: 'Synthetic loaded runtime is not ready.', operation: { failed_stage: 'agent_ready' } } })
    await store.agentRecovery({ phase: 'complete', attempt: 1, detail: '', retry_at: null,
      operation: { operation_id: original.id, baseline_revision: 'a'.repeat(40), target_revision: 'b'.repeat(40), stage: 'agent_ready', recovered_revision: 'b'.repeat(40) },
      verified_revision: 'b'.repeat(40), runtime_revision: 'b'.repeat(40), verified_version: 'v2.0.0' })
    expect((await store.list(scope)).tab_update).toMatchObject({ id: original.id, phase: 'succeeded', recovery: { operation: { failed_stage: 'agent_ready' } } })
  })

  it('clears an old installed identity when recovery can prove only the loaded runtime', async () => {
    const scope = { ...alice, tab: 'tab-recovery' }
    const store = await initializeStore(new UpdateNotificationStore(new JsonDocuments(temp())))
    const original = await store.begin(scope, 'agent')
    await store.bindAgentOperation(original.id, 'a'.repeat(40), 'b'.repeat(40))
    await store.handoffAgentRecovery(original.id, 'Synthetic lost response.', { revision: 'b'.repeat(40), version: 'v2.0.0' })
    await store.agentRecovery({ phase: 'complete', attempt: 1, retry_at: null, detail: '', operation_id: original.id, runtime_revision: 'a'.repeat(40), verified_version: 'v1.0.0' })
    expect((await store.list(scope)).tab_update).toMatchObject({ phase: 'unknown', verified_revision: null, verified_version: null })
  })

  it('reconciles an interrupted recovery notice without changing the failed update history', async () => {
    const root = temp()
    const store = await initializeStore(new UpdateNotificationStore(new JsonDocuments(root)))
    const original = await store.begin(alice, 'agent')
    await store.transition(original.id, 'failed')
    await store.agentRecovery({ phase: 'running', detail: '', attempt: 1, retry_at: null })
    const restarted = await initializeStore(new UpdateNotificationStore(new JsonDocuments(root)))
    await restarted.reconcileInterruptedUpdates('a'.repeat(40), '1.0.0')
    const rows = (await restarted.list(alice)).notifications
    expect(rows.find((row) => row.kind === 'agent_recovery')).toMatchObject({ phase: 'unknown', active: false })
    expect(rows.find((row) => row.id === original.id)?.phase).toBe('failed')
    await restarted.agentRecovery({ phase: 'complete', detail: '', attempt: 1, retry_at: null })
    expect((await restarted.list(alice)).notifications.find((row) => row.kind === 'agent_recovery')?.phase).toBe('succeeded')
  })
  it('preserves the failed update while projecting automatic recovery and its actual outcome', async () => {
    const store = await initializeStore(new UpdateNotificationStore(new JsonDocuments(temp())))
    const original = await store.begin(alice, 'agent')
    await store.transition(original.id, 'failed', null, undefined, 'Synthetic update failed before source mutation.')
    for (const phase of ['running', 'waiting', 'blocked', 'complete'] as const) {
      await store.agentRecovery({ phase, detail: phase === 'blocked' ? 'The recorded supervisor identity is unavailable.' : '', attempt: 2, retry_at: null })
      const list = await store.list(alice)
      expect(list.notifications.find((row) => row.id === original.id)).toMatchObject({ phase: 'failed', verified_revision: null })
      expect(list.notifications.filter((row) => row.kind === 'agent_recovery')).toHaveLength(1)
      expect(list.notifications.find((row) => row.kind === 'agent_recovery')).toMatchObject({ phase: phase === 'complete' ? 'succeeded' : phase === 'running' ? 'applying' : 'blocked', verified_revision: null })
    }
    expect((await store.list(alice)).notifications.find((row) => row.kind === 'agent_recovery')?.message).toBe('Hermes Agent is usable again. The original update result is unchanged.')
  })
  it.each(['agent', 'webui'] as const)('projects truthful %s failures with or without detail across every public path', async (target) => {
    const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(temp()))))
    const scope = { ...alice, tab: 'tab-aaaaaaaa' }
    const created = (await store.begin(scope, target))
    expect(created.destination?.key).toBe('settings.system')
    const expected = { id: created.id, target, phase: 'failed', message: 'The update could not be completed.', destination: null, detail: 'Build failed.\nTry again.' }
    expect((await store.transition(created.id, 'failed', null, undefined, 'Build failed.\r\nTry again.'))).toMatchObject(expected)
    expect((await store.list(scope))).toMatchObject({ notifications: [expected], tab_update: expected })
    expect((await store.read(scope, created.id))).toMatchObject({ ...expected, unread: false })
    expect((await store.transition(created.id, 'failed'))).toMatchObject({ ...expected, detail: null })
    expect((await store.transition(created.id, 'blocked'))?.destination?.key).toBe('settings.system')
  })

  it.each(['agent', 'webui'] as const)('normalizes old saved %s failures without changing detail, identity, read or dismissal state', async (target) => {
    const root = temp()
    const scope = { ...alice, tab: 'tab-aaaaaaaa' }
    const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root))))
    const created = (await store.begin(scope, target))
    await store.transition(created.id, 'failed', null, { revision: 'a'.repeat(40), version: '1.2.3' }, 'Build failed.\nTry again.')
    await store.read(scope, created.id)
    const dismissed = (await store.begin(alice, target))
    await store.transition(dismissed.id, 'failed')
    await store.dismiss(alice, dismissed.id)
    const system = (await store.create(alice, { kind: 'system', target, phase: 'failed', title: 'System failure', message: 'System detail.', destination: { key: 'settings.system', label: 'Open System settings' } }))
    const file = join(root, 'update-notifications.json')
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { id: string; message: string }[]
    for (const row of saved) if (row.id !== system.id) row.message = 'The update could not be completed. Open System settings for details.'
    writeFileSync(file, JSON.stringify(saved))
    const before = readFileSync(file, 'utf8')
    const reloaded = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root))))
    const expected = { id: created.id, target, phase: 'failed', message: 'The update could not be completed.', destination: null, detail: 'Build failed.\nTry again.', unread: false, verified_revision: 'a'.repeat(40), verified_version: '1.2.3' }
    expect((await reloaded.list(scope))).toMatchObject({ tab_update: expected })
    expect((await reloaded.list(scope)).notifications.find((row) => row.id === created.id)).toMatchObject(expected)
    expect((await reloaded.list(scope)).notifications.some((row) => row.id === dismissed.id)).toBe(false)
    expect((await reloaded.list(scope)).notifications.find((row) => row.id === system.id)).toEqual(system)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('keeps acknowledgement distinct from read and clear, idempotently', async () => {
    const root = temp()
    let now = new Date('2026-09-26T12:00:00Z')
    const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root), () => now)))
    const created = (await store.create(alice, {
      kind: 'system', phase: 'attention', severity: 'critical', persistent: true, requiresAcknowledgement: true,
      title: 'Action required', message: 'Review this server alert.', visibility: 'server',
      actions: [{ id: 'acknowledge', label: 'Acknowledge', style: 'primary', acknowledges: true }],
      destination: { key: 'settings.system', label: 'Open System settings' },
    }))

    expect((await store.list(alice))).toMatchObject({ unread_count: 1, clearable_count: 0, can_clear: false })
    expect((await store.clear(alice)).notifications.map((row) => row.id)).toContain(created.id)
    now = new Date('2026-09-26T12:01:00Z')
    expect((await store.read(alice, created.id))).toMatchObject({ read_at: now.toISOString(), acknowledged_at: null })
    const acknowledged = (await store.action(alice, created.id, 'acknowledge'))!
    expect(acknowledged).toMatchObject({ read_at: now.toISOString(), acknowledged_at: now.toISOString(), acknowledged_action_id: 'acknowledge' })
    now = new Date('2026-09-26T12:02:00Z')
    expect((await store.action(alice, created.id, 'acknowledge'))?.updated_at).toBe(acknowledged.updated_at)
    expect((await store.clear(alice))).toMatchObject({ notifications: [], unread_count: 0, clearable_count: 0, can_clear: false })
    expect((await store.clear(alice)).notifications).toEqual([])
  })

  it('shares server notifications across one owner profiles without leaking owners or profile notifications', async () => {
    const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(temp()))))
    const server = (await store.begin(alice, 'webui'))
    const automatic = (await store.begin({ owner: '*', profile: 'default' }, 'webui'))
    const profile = (await store.create(alice, { kind: 'profile_notice', phase: 'notice', title: 'Profile notice', message: 'Only work.', visibility: 'profile' }))
    const personal = (await store.list(alice))
    const otherProfile = (await store.list({ owner: alice.owner, profile: 'personal', serverOwner: true }))
    const otherOwner = (await store.list({ owner: 'oidc:bob', profile: 'work', serverOwner: true }))
    const nonOwner = (await store.list({ owner: 'oidc:bob', profile: 'work' }))

    expect(personal.notifications.map((row) => row.id)).toEqual(expect.arrayContaining([server.id, profile.id]))
    expect(otherProfile.notifications.map((row) => row.id)).toEqual(expect.arrayContaining([server.id, automatic.id]))
    expect(otherOwner.notifications.map((row) => row.id)).toEqual([automatic.id])
    expect(nonOwner.notifications).toEqual([])
    expect((await store.dismiss({ owner: alice.owner, profile: 'work' }, server.id))).toBe('not_found')
    expect(store.activeUpdate({ owner: alice.owner, profile: 'work' }, 'webui')).toBeNull()
    expect(otherProfile.scope_id).not.toBe(personal.scope_id)
    expect(store.activeUpdate({ owner: alice.owner, profile: 'personal', serverOwner: true }, 'webui')?.id).toBe(automatic.id)
  })

  it('keeps each tab on its latest update operation across a restart without leaking it to another owner', async () => {
    const root = temp()
    let now = new Date('2026-09-27T12:00:00Z')
    const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root), () => now)))
    const tab = { ...alice, tab: 'tab-aaaaaaaa' }
    const agent = (await store.begin(tab, 'agent'))
    now = new Date('2026-09-27T12:01:00Z')
    const web = (await store.begin(tab, 'webui'))
    await store.transition(agent.id, 'failed')
    expect((await store.list(tab)).tab_update?.id).toBe(web.id)
    expect((await store.list(alice)).tab_update).toBeNull()
    expect((await store.list({ owner: 'oidc:bob', profile: 'work', serverOwner: true, tab: 'tab-aaaaaaaa' })).tab_update).toBeNull()
    await store.transition(web.id, 'restarting', 'a'.repeat(40))
    const restarted = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root), () => now)))
    await restarted.reconcileInterruptedUpdates('a'.repeat(40))
    expect((await restarted.list(tab)).tab_update).toMatchObject({ id: web.id, phase: 'succeeded' })
    expect((await restarted.list(tab)).tab_update).not.toHaveProperty('watchers')
  })

  it('keeps a failed, blocked, or attention-needing success\'s own explanation, line breaks included, and drops it on the next phase', async () => {
    const root = temp()
    const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root))))
    const web = (await store.begin(alice, 'webui'))
    expect(web.detail).toBeNull()
    expect((await store.transition(web.id, 'failed', null, undefined, '  npm run build failed.\r\nRun `npm ci`\u0007 again.  '))?.detail).toBe('npm run build failed.\nRun `npm ci`  again.')
    expect((await (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root)))).list(alice)).notifications[0]?.detail).toBe('npm run build failed.\nRun `npm ci`  again.')
    expect((await store.transition(web.id, 'blocked', null, undefined, 'x'.repeat(3_000)))?.detail).toHaveLength(2_000)
    expect((await store.transition(web.id, 'succeeded'))?.detail).toBeNull()
    expect((await store.transition(web.id, 'succeeded', null, undefined, 'Local edits were set aside in the git stash.'))?.detail).toBe('Local edits were set aside in the git stash.')
    expect((await store.transition(web.id, 'restarting', null, undefined, 'ignored'))?.detail).toBeNull()
  })

  it('TAL-1429: an applying Agent update shows what it waits for, keeps the step and phase, and drops it on the outcome', async () => {
    const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(temp()))))
    const agent = (await store.begin(alice, 'agent'))
    const detail = gatewayDrainDetail(['ai.hermes.gateway'], 1875)
    expect(detail).toBe('Waiting for ai.hermes.gateway to finish in-flight work before installing (up to 32 min).')
    const waiting = (await store.transition(agent.id, 'applying', null, undefined, detail))
    expect(waiting).toMatchObject({ phase: 'applying', detail, title: agent.title, message: agent.message, steps: agent.steps })
    expect((await store.transition(agent.id, 'verifying'))?.detail).toBeNull()
  })

  it('follows the operation a tab rejoined most recently, not the newest one', async () => {
    let now = new Date('2026-09-27T12:00:00Z')
    const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(temp()), () => now)))
    const other = { ...alice, tab: 'tab-bbbbbbbb' }
    const tab = { ...alice, tab: 'tab-aaaaaaaa' }
    const web = (await store.begin(other, 'webui'))
    now = new Date('2026-09-27T12:01:00Z')
    const agent = (await store.begin(tab, 'agent'))
    expect((await store.list(tab)).tab_update?.id).toBe(agent.id)
    now = new Date('2026-09-27T12:02:00Z')
    await store.watch(tab, web.id)
    expect((await store.list(tab))).toMatchObject({ tab_update: { id: web.id, updated_at: '2026-09-27T12:00:00.000Z' }, tab_joined_at: '2026-09-27T12:02:00.000Z' })
    expect((await store.list(other)).tab_update?.id).toBe(web.id)
  })

  it('keeps every tab that joined an operation attached to it, however many join', async () => {
    const root = temp()
    const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root))))
    const tabs = Array.from({ length: 12 }, (_, index) => ({ ...alice, tab: `tab-${String(index).padStart(8, '0')}` }))
    const web = (await store.begin(tabs[0]!, 'webui'))
    for (const tab of tabs.slice(1)) (await store.watch(tab, web.id))
    const restarted = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root))))
    for (const tab of tabs) expect((await restarted.list(tab)).tab_update?.id).toBe(web.id)
  })

  it('reconciles interrupted applying and restarting records against the running identity', async () => {
    const root = temp()
    const first = (await (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root)))).begin(alice, 'webui'))
    let restarted = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root))))
    await restarted.reconcileInterruptedUpdates('a'.repeat(40))
    expect((await restarted.list(alice)).notifications.find((row) => row.id === first.id)?.phase).toBe('unknown')

    const restarting = (await restarted.begin(alice, 'webui'))
    await restarted.transition(restarting.id, 'restarting', 'b'.repeat(40))
    restarted = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root))))
    await restarted.reconcileInterruptedUpdates('b'.repeat(40), 'web-v2.0.0')
    expect((await restarted.list(alice)).notifications.find((row) => row.id === restarting.id)).toMatchObject({
      phase: 'succeeded', verified_revision: 'b'.repeat(40), verified_version: 'web-v2.0.0',
    })

    const unverified = (await restarted.begin(alice, 'webui'))
    await restarted.transition(unverified.id, 'restarting', 'c'.repeat(40))
    restarted = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root))))
    await restarted.reconcileInterruptedUpdates('d'.repeat(40))
    expect((await restarted.list(alice)).notifications.find((row) => row.id === unverified.id)).toMatchObject({ phase: 'unknown', verified_revision: null, verified_version: null })

    const interruptedAgent = (await restarted.begin(alice, 'agent'))
    restarted = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root))))
    await restarted.reconcileInterruptedUpdates('d'.repeat(40))
    expect((await restarted.list(alice)).notifications.find((row) => row.id === interruptedAgent.id)).toMatchObject({ phase: 'unknown', verified_revision: null, verified_version: null })

    const clearedAgent = (await restarted.begin(alice, 'agent'))
    await restarted.clear(alice)
    restarted = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root))))
    await restarted.reconcileInterruptedUpdates('d'.repeat(40))
    expect(restarted.activeUpdate(alice, 'agent')).toBeNull()
    expect((await restarted.list(alice)).notifications.some((row) => row.id === clearedAgent.id)).toBe(false)
    expect((await restarted.begin(alice, 'agent')).id).not.toBe(clearedAgent.id)
  })

  it('cancels an awaiting confirmation idempotently', async () => {
    const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(temp()))))
    const notification = (await store.begin(alice, 'agent'))
    await store.transition(notification.id, 'awaiting_confirmation')
    const cancelled = (await store.cancelUpdate(alice, notification.id))!
    expect(cancelled).toMatchObject({ phase: 'blocked', message: 'The update was cancelled before installation.', unread: false })
    expect((await store.cancelUpdate(alice, notification.id))).toEqual(cancelled)
  })

  it('makes a new lifecycle phase unread after the earlier phase was read', async () => {
    const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(temp()))))
    const notification = (await store.begin(alice, 'webui'))
    expect((await store.read(alice, notification.id))?.unread).toBe(false)
    expect((await store.transition(notification.id, 'succeeded'))?.unread).toBe(true)
  })

  it('ignores external writes while running and bounds owner history', async () => {
    const root = temp()
    const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root))))
    for (let index = 0; index < 60; index += 1) {
      await store.create(alice, { kind: 'system', phase: 'notice', title: `Notice ${String(index)}`, message: 'Safe', visibility: 'server' })
    }
    expect((await store.list(alice)).notifications).toHaveLength(50)

    const file = join(root, 'update-notifications.json')
    writeFileSync(file, '[]')
    expect((await store.list(alice)).notifications).toHaveLength(50)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([])
  })

  it('retains an older unresolved required alert ahead of newer ordinary history', async () => {
    const root = temp()
    let tick = 0
    const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root), () => new Date(Date.UTC(2026, 8, 26, 12, 0, tick++)))))
    const required = (await store.create(alice, {
      kind: 'system', phase: 'attention', title: 'Required', message: 'Acknowledge me.', visibility: 'server',
      requiresAcknowledgement: true, actions: [{ id: 'acknowledge', label: 'Acknowledge', style: 'primary', acknowledges: true }],
    }))
    for (let index = 0; index < 55; index += 1) {
      await store.create(alice, { kind: 'system', phase: 'notice', title: `Notice ${String(index)}`, message: 'Ordinary', visibility: 'server' })
    }
    const listed = (await store.list(alice))
    expect(listed.notifications).toHaveLength(50)
    expect(listed.notifications.some((row) => row.id === required.id && row.requires_interaction)).toBe(true)
  })

  it('rejects new history instead of returning a record that protected capacity cannot store', async () => {
    const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(temp()))))
    let firstID = ''
    for (let index = 0; index < 50; index += 1) {
      const row = (await store.create(alice, {
        kind: 'system', phase: 'attention', title: `Required ${String(index)}`, message: 'Acknowledge me.', visibility: 'server',
        requiresAcknowledgement: true, actions: [{ id: 'acknowledge', label: 'Acknowledge', style: 'primary', acknowledges: true }],
      }))
      firstID ||= row.id
    }
    await expect(store.create(alice, { kind: 'system', phase: 'notice', title: 'Phantom', message: 'Must not be returned.', visibility: 'server' }))
      .rejects.toThrow('protected capacity reached')
    await store.action(alice, firstID, 'acknowledge')
    expect((await store.create(alice, { kind: 'system', phase: 'notice', title: 'Stored', message: 'There is room now.', visibility: 'server' })).title).toBe('Stored')
  })

  describe('stale Web tab refresh notices', () => {
    const oldBuild = 'a'.repeat(64)
    const newBuild = 'b'.repeat(64)
    const newerBuild = 'c'.repeat(64)
    const tabA = { ...alice, tab: 'tab-aaaaaaaa' }
    const tabB = { ...alice, tab: 'tab-bbbbbbbb' }

    it('compares exact builds and never raises a notice for a matching or unknown build', async () => {
      const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(temp()))))
      expect((await store.syncTabBuild(tabA, newBuild, newBuild))).toEqual({ current_build: newBuild, loaded_build: newBuild, refresh_required: false, notification_id: null })
      expect((await store.syncTabBuild(tabA, oldBuild, null))).toMatchObject({ refresh_required: false, notification_id: null })
      expect((await store.syncTabBuild(tabA, null, newBuild))).toMatchObject({ refresh_required: false, notification_id: null })
      expect((await store.syncTabBuild(tabA, 'web-v1.2.3', newBuild))).toMatchObject({ loaded_build: null, refresh_required: false })
      expect((await store.syncTabBuild({ ...alice, tab: null }, oldBuild, newBuild))).toMatchObject({ refresh_required: false, notification_id: null })
      expect((await store.list(tabA)).notifications).toEqual([])
    })

    it('keeps one persistent tab-scoped notice per stale tab, invisible to other tabs and non-tab clients', async () => {
      const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(temp()))))
      const first = (await store.syncTabBuild(tabA, oldBuild, newBuild))
      expect(first).toMatchObject({ current_build: newBuild, loaded_build: oldBuild, refresh_required: true })
      const again = (await store.syncTabBuild(tabA, oldBuild, newBuild))
      expect(again.notification_id).toBe(first.notification_id)
      const listed = (await store.list(tabA)).notifications
      expect(listed).toHaveLength(1)
      expect(listed[0]).toMatchObject({
        id: first.notification_id, kind: 'web_refresh', persistent: true, requires_interaction: true, can_dismiss: false,
        actions: [{ id: 'reload', label: 'Refresh now', style: 'primary', acknowledges: false }],
      })

      expect((await store.list(alice)).notifications).toEqual([])
      expect((await store.list(tabB)).notifications).toEqual([])
      expect((await store.list({ ...tabA, owner: 'oidc:bob' })).notifications).toEqual([])
      expect((await store.syncTabBuild(tabB, newerBuild, newBuild)).notification_id).not.toBe(first.notification_id)
      expect((await store.list(tabA)).notifications.map((row) => row.id)).toEqual([first.notification_id])
      expect((await store.read(alice, first.notification_id!))).toBeNull()
      expect((await store.dismiss(tabB, first.notification_id!))).toBe('not_found')
    })

    it('treats read, clear, dismissal, and the refresh action as non-resolving until the tab reports the current build', async () => {
      const root = temp()
      let now = new Date('2026-09-26T12:00:00Z')
      const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root), () => now)))
      const id = (await store.syncTabBuild(tabA, oldBuild, newBuild)).notification_id!
      const created = (await store.list(tabA)).notifications[0]!
      now = new Date('2026-09-26T12:01:00Z')
      expect((await store.read(tabA, id))).toMatchObject({ unread: false, requires_interaction: true })
      expect((await store.dismiss(tabA, id))).toBe('acknowledgement_required')
      expect((await store.clear(tabA)).notifications.map((row) => row.id)).toEqual([id])
      expect((await store.action(tabA, id, 'reload'))).toMatchObject({ requires_interaction: true, acknowledged_at: null, can_dismiss: false })
      expect((await store.action(tabA, id, 'reload'))).toMatchObject({ requires_interaction: true })

      now = new Date('2026-09-26T12:02:00Z')
      expect((await store.syncTabBuild(tabA, oldBuild, newBuild)).notification_id).toBe(id)
      expect((await (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root), () => now))).syncTabBuild(tabA, oldBuild, newBuild)).notification_id).toBe(id)
      expect((await store.list(tabA)).notifications[0]?.updated_at).not.toBe(created.updated_at)

      const verified = (await store.syncTabBuild(tabA, newBuild, newBuild))
      expect(verified).toMatchObject({ refresh_required: false, notification_id: null })
      expect((await store.list(tabA)).notifications).toEqual([])
      expect((await (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root)))).list(tabA)).notifications).toEqual([])
    })

    it('retargets one record to a newer deployment and drops notices of tabs that stopped checking in', async () => {
      let now = new Date('2026-09-26T12:00:00Z')
      const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(temp()), () => now)))
      const id = (await store.syncTabBuild(tabA, oldBuild, newBuild)).notification_id!
      await store.read(tabA, id)
      const before = (await store.list(tabA)).notifications[0]!
      now = new Date('2026-09-26T12:10:00Z')
      expect((await store.syncTabBuild(tabA, oldBuild, newBuild)).notification_id).toBe(id)
      expect((await store.list(tabA)).notifications[0]).toEqual(before)
      expect((await store.syncTabBuild(tabA, oldBuild, newerBuild)).notification_id).toBe(id)
      expect((await store.list(tabA)).notifications).toMatchObject([{ id, unread: true, updated_at: now.toISOString() }])

      now = new Date('2026-09-26T13:20:00Z')
      expect((await store.list(tabA)).notifications).toEqual([])
    })

    it('bounds tab notices separately so stale tabs never block or evict other notifications', async () => {
      const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(temp()))))
      const tabs = Array.from({ length: 51 }, (_, index) => ({ ...alice, tab: `tab-${String(index).padStart(8, '0')}` }))
      const created = await Promise.all(tabs.map(async (scope) => (await store.syncTabBuild(scope, oldBuild, newBuild))))
      expect(created.slice(0, 50).every((state) => state.notification_id !== null)).toBe(true)
      expect(created[50]).toMatchObject({ refresh_required: true, notification_id: null })

      const required = (await store.create(alice, {
        kind: 'system', phase: 'attention', requiresAcknowledgement: true, title: 'Still delivered', message: 'Tabs do not use this capacity.',
        actions: [{ id: 'acknowledge', label: 'Acknowledge', style: 'primary', acknowledges: true }],
      }))
      for (let index = 0; index < 50; index += 1) (await store.create(alice, { kind: 'profile_notice', phase: 'notice', title: `Notice ${String(index)}`, message: 'History.' }))
      expect((await store.list(alice)).notifications.map((row) => row.id)).toContain(required.id)
      expect((await store.list(tabs[0]!)).notifications.map((row) => row.id)).toContain(created[0]!.notification_id)
    })
  })

  /** TAL-1138: the Updating dialog renders the server's steps, presentation flag, and close mode. */
  describe('Updating dialog steps', () => {
    const oldBuild = 'a'.repeat(64)
    const newBuild = 'b'.repeat(64)
    const revision = 'd'.repeat(40)
    const tabA = { ...alice, tab: 'tab-aaaaaaaa' }
    const tabB = { ...alice, tab: 'tab-bbbbbbbb' }
    const states = (row: { steps: { label: string; state: string }[] } | null | undefined) => row?.steps.map((step) => `${step.label}:${step.state}`)

    it('runs a Web update to Ready with Reload in the starting tab, and the refresh notice only in other tabs', async () => {
      const root = temp()
      const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root))))
      const row = (await store.begin(tabA, 'webui'))
      expect((await store.list(tabA)).tab_update).toMatchObject({ presents_dialog: true, dialog_close: 'none' })
      expect(states((await store.list(tabA)).tab_update)).toEqual(['Installing:active', 'Restarting Talaria Web:pending', 'Ready:pending'])
      // Another tab of the owner sees the same operation's dialog while it runs.
      expect((await store.list(tabB)).notifications.find((entry) => entry.id === row.id)).toMatchObject({ presents_dialog: true })
      await store.transition(row.id, 'restarting', revision)
      expect(states((await store.list(tabA)).tab_update)).toEqual(['Installing:done', 'Restarting Talaria Web:active', 'Ready:pending'])

      const restarted = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root))))
      await restarted.reconcileInterruptedUpdates(revision, 'web-v1.4.0')
      expect((await restarted.syncTabBuild(tabA, oldBuild, newBuild))).toMatchObject({ refresh_required: true, notification_id: null })
      const starting = (await restarted.list(tabA, true))
      expect(starting.notifications.map((entry) => entry.kind)).toEqual(['update'])
      expect(starting.tab_update).toMatchObject({ phase: 'succeeded', presents_dialog: true, dialog_close: 'none', actions: [{ id: 'reload', label: 'Reload', style: 'primary' }] })
      expect(states(starting.tab_update)).toEqual(['Installing:done', 'Restarting Talaria Web:done', 'Talaria Web 1.4.0 is ready:done'])

      const other = (await restarted.syncTabBuild(tabB, oldBuild, newBuild))
      expect(other.notification_id).not.toBeNull()
      const otherList = (await restarted.list(tabB, true))
      expect(otherList.tab_update).toBeNull()
      expect(otherList.notifications.find((entry) => entry.id === row.id)).toMatchObject({ presents_dialog: false, actions: [] })
      expect(otherList.notifications.find((entry) => entry.kind === 'web_refresh')?.actions[0]?.id).toBe('reload')

      expect((await restarted.action(tabA, row.id, 'reload'))?.id).toBe(row.id)
      expect((await restarted.action(tabB, row.id, 'reload'))).toBeNull()
      await restarted.syncTabBuild(tabA, newBuild, newBuild)
      expect((await restarted.list(tabA, false)).tab_update).toMatchObject({ presents_dialog: false, dialog_close: 'auto', actions: [] })
    })

    it('hands Reload back to the refresh notice once a later Web update replaces the one the tab started', async () => {
      const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(temp()))))
      const started = (await store.begin(tabA, 'webui'))
      await store.transition(started.id, 'succeeded')
      expect((await store.syncTabBuild(tabA, oldBuild, newBuild)).notification_id).toBeNull()
      const automatic = (await store.begin({ owner: '*', profile: 'default', serverOwner: true }, 'webui'))
      await store.transition(automatic.id, 'succeeded')
      expect((await store.syncTabBuild(tabA, oldBuild, newBuild)).notification_id).not.toBeNull()
      expect((await store.list(tabA, true)).tab_update).toMatchObject({ id: started.id, presents_dialog: false })
    })

    /** TAL-1622: a build change mid-update must not stack the refresh notice on an open Updating dialog. */
    it('keeps the refresh notice out of a tab while its Web Updating dialog shows, then restores it when the dialog stops', async () => {
      const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(temp()))))
      const member = { owner: 'oidc:member', profile: 'work', serverOwner: false, tab: 'tab-mmmmmmmm' }
      const refreshRows = async (scope: UpdateNotificationScope) => (await store.list(scope, true)).notifications.filter((entry) => entry.kind === 'web_refresh')
      // The tab was already stale when the update began; its dialog takes over that notice too.
      expect((await store.syncTabBuild(tabA, oldBuild, newBuild)).notification_id).not.toBeNull()
      const row = (await store.begin(tabA, 'webui'))
      for (const phase of ['applying', 'restarting'] as const) {
        if (phase !== 'applying') await store.transition(row.id, phase, revision)
        for (const tab of [tabA, tabB]) {
          expect((await store.syncTabBuild(tab, oldBuild, newBuild))).toMatchObject({ refresh_required: true, notification_id: null })
          expect((await store.list(tab, true)).notifications.find((entry) => entry.id === row.id)).toMatchObject({ phase, presents_dialog: true })
          expect(await refreshRows(tab)).toEqual([])
        }
      }
      // A tab that cannot see the update has no dialog and still gets its notice.
      expect((await store.syncTabBuild(member, oldBuild, newBuild)).notification_id).not.toBeNull()

      await store.transition(row.id, 'failed', null, undefined, 'Build failed.')
      for (const tab of [tabA, tabB]) {
        const synced = (await store.syncTabBuild(tab, oldBuild, newBuild))
        expect(synced.notification_id).not.toBeNull()
        expect(await refreshRows(tab)).toMatchObject([{ id: synced.notification_id, requires_interaction: true }])
      }
    })

    it('runs a native Agent update through the Web restart to Agent responding, then closes itself', async () => {
      const root = temp()
      const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root))))
      const row = (await store.begin(tabA, 'agent'))
      await store.recordGatewayBaseline(row.id, [])
      await store.transition(row.id, 'verifying', null, { revision: null, version: 'v0.22.1' })
      await store.markWebRestart(row.id)
      expect((await store.list(tabA)).tab_update).toMatchObject({ phase: 'verifying', active: true, presents_dialog: true, dialog_close: 'none' })
      expect(states((await store.list(tabA)).tab_update)).toEqual(['Installing:done', 'Restarting Talaria Web:active', 'Restarting gateway:pending', 'Agent responding:pending'])
      const restarted = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root))))
      await restarted.reconcileInterruptedUpdates(revision)
      expect(states((await restarted.list(tabA)).tab_update)).toEqual(['Installing:done', 'Restarting Talaria Web:done', 'Restarting gateway:done', 'Agent responding:active'])
      expect((await restarted.list(tabB)).notifications.find((entry) => entry.id === row.id)).toMatchObject({ presents_dialog: true })
      await restarted.transition(row.id, 'succeeded')
      expect((await restarted.list(tabA)).tab_update).toMatchObject({ presents_dialog: false, dialog_close: 'auto', can_dismiss: true })
      expect(states((await restarted.list(tabA)).tab_update)).toEqual(['Installing:done', 'Restarting Talaria Web:done', 'Restarting gateway:done', 'Hermes Agent v0.22.1 is running:done'])
    })

    it('lists the gateway restart but no Web restart for a native Agent update that did not restart Web', async () => {
      const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(temp()))))
      const row = (await store.begin(tabA, 'agent'))
      await store.recordGatewayBaseline(row.id, [{ dir: '/home', pid: 41, start_time: 7 }])
      await store.transition(row.id, 'verifying', null, { revision: null, version: 'v0.22.1' })
      expect(states((await store.list(tabA)).tab_update)).toEqual(['Installing:done', 'Restarting gateway:done', 'Agent responding:active'])
      await store.transition(row.id, 'succeeded')
      expect(states((await store.list(tabA)).tab_update)).toEqual(['Installing:done', 'Restarting gateway:done', 'Hermes Agent v0.22.1 is running:done'])
    })

    it('waits for gateway tasks with Restart now and Restart later, reopens for the deferred restart, and marks its failed step', async () => {
      const root = temp()
      const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root))))
      const row = (await store.begin(tabA, 'agent'))
      await store.transition(row.id, 'waiting_for_idle')
      await store.markWebRestart(row.id)
      // Until Web restarts, the wait has not started: no Restart now, and the dialog stays up.
      expect((await store.list(tabA)).tab_update).toMatchObject({ presents_dialog: true, dialog_close: 'none', actions: [] })
      expect((await store.action(tabA, row.id, 'restart_gateway_now'))).toBeNull()
      const restarted = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root))))
      await restarted.gatewayWaiting(row.id, 2)
      const waiting = (await restarted.list(tabA)).tab_update
      expect(waiting).toMatchObject({ presents_dialog: false, dialog_close: 'restart_later', actions: [{ id: 'restart_gateway_now' }] })
      expect(states(waiting)).toEqual(['Installing:done', 'Restarting Talaria Web:done', 'Waiting for 2 gateway tasks:active', 'Restarting gateway:pending', 'Agent responding:pending'])
      await restarted.gatewayWaiting(row.id, 1)
      expect(states((await restarted.list(tabA)).tab_update)?.[2]).toBe('Waiting for 1 gateway task:active')
      await restarted.transition(row.id, 'restarting')
      await restarted.recordGatewayBaseline(row.id, [])
      expect((await restarted.list(tabB)).notifications.find((entry) => entry.id === row.id)).toMatchObject({ presents_dialog: true, dialog_close: 'none' })
      expect(states((await restarted.list(tabA)).tab_update)).toEqual(['Installing:done', 'Restarting Talaria Web:done', 'Waiting for 1 gateway task:done', 'Restarting gateway:active', 'Agent responding:pending'])
      await restarted.transition(row.id, 'verifying')
      await restarted.transition(row.id, 'failed', null, undefined, 'Hermes Agent was updated, but the gateway did not come back. Run `hermes gateway restart` manually.')
      const failed = (await (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root)))).list(tabA)).tab_update
      expect(failed).toMatchObject({ presents_dialog: false, dialog_close: 'close', detail: expect.stringContaining('did not come back') as string })
      expect(states(failed)).toEqual(['Installing:done', 'Restarting Talaria Web:done', 'Waiting for 1 gateway task:done', 'Restarting gateway:done', 'Agent responding:failed'])
    })

    it('lists only the steps an update ran, and fails the step an interrupted update stopped at', async () => {
      const root = temp()
      const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root))))
      const current = (await store.begin(tabA, 'agent'))
      await store.transition(current.id, 'succeeded')
      expect(states((await store.list(tabA)).tab_update)).toEqual(['Installing:done', 'Hermes Agent is running:done'])
      const web = (await store.begin(tabA, 'webui'))
      await store.transition(web.id, 'failed', null, undefined, 'Build failed.')
      expect(states((await store.list(tabA)).tab_update)).toEqual(['Installing:failed', 'Ready:pending'])
      const restart = (await store.begin(tabB, 'agent'))
      await store.transition(restart.id, 'restarting')
      await (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root)))).reconcileInterruptedUpdates(revision)
      const interrupted = (await (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root)))).list(tabB)).tab_update
      expect(interrupted).toMatchObject({ phase: 'unknown', dialog_close: 'close', presents_dialog: false })
      expect(states(interrupted)).toEqual(['Installing:done', 'Restarting gateway:failed', 'Agent responding:pending'])
      // Records without steps (system notices, recovery) close normally and never present a dialog.
      const notice = (await (await initializeStore(new UpdateNotificationStore(new JsonDocuments(temp())))).create(alice, { kind: 'system', phase: 'notice', title: 'Notice', message: 'Hello.' }))
      expect(notice).toMatchObject({ steps: [], presents_dialog: false, dialog_close: 'close' })
    })
    it('stores the check as a restarting record Stable knows, and a restarted server resumes it as verifying', async () => {
      const root = temp()
      const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root))))
      const row = (await store.begin(tabA, 'agent'))
      await store.recordGatewayBaseline(row.id, [{ dir: '/home', pid: 41, start_time: 7 }])
      await store.transition(row.id, 'verifying')
      const raw = (JSON.parse(readFileSync(join(root, 'update-notifications.json'), 'utf8')) as { id: string; phase: string; verifying?: boolean }[]).find((entry) => entry.id === row.id)
      expect(raw).toMatchObject({ phase: 'restarting', verifying: true })
      const restarted = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root))))
      await restarted.reconcileInterruptedUpdates(revision)
      expect((await restarted.list(tabA)).tab_update).toMatchObject({ phase: 'verifying', active: true })
      expect(restarted.pendingGatewayRestarts()).toEqual([{ id: row.id, profile: 'work', detail: null, phase: 'verifying', baseline: [{ dir: '/home', pid: 41, start_time: 7 }] }])
      // A Stable save drops the flag; the plain restarting record then reconciles as an unverified outcome.
      writeFileSync(join(root, 'update-notifications.json'), JSON.stringify([{ ...raw, verifying: undefined }]))
      const stable = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(root))))
      await stable.reconcileInterruptedUpdates(revision)
      expect((await stable.list(tabA)).tab_update).toMatchObject({ phase: 'unknown' })
      expect(stable.pendingGatewayRestarts()).toEqual([])
    })
  })
})
