import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { UpdateNotificationStore, type UpdateNotificationScope } from './update-notifications.js'

const roots: string[] = []
const temp = () => { const path = mkdtempSync(join(tmpdir(), 'talaria-notifications-')); roots.push(path); return path }
const alice: UpdateNotificationScope = { owner: 'oidc:alice', profile: 'work', serverOwner: true }

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('UpdateNotificationStore', () => {
  it('keeps acknowledgement distinct from read and clear, idempotently', () => {
    const root = temp()
    let now = new Date('2026-09-26T12:00:00Z')
    const store = new UpdateNotificationStore(root, () => now)
    const created = store.create(alice, {
      kind: 'system', phase: 'attention', severity: 'critical', persistent: true, requiresAcknowledgement: true,
      title: 'Action required', message: 'Review this server alert.', visibility: 'server',
      actions: [{ id: 'acknowledge', label: 'Acknowledge', style: 'primary', acknowledges: true }],
      destination: { key: 'settings.system', label: 'Open System settings' },
    })

    expect(store.list(alice)).toMatchObject({ unread_count: 1, clearable_count: 0, can_clear: false })
    expect(store.clear(alice).notifications.map((row) => row.id)).toContain(created.id)
    now = new Date('2026-09-26T12:01:00Z')
    expect(store.read(alice, created.id)).toMatchObject({ read_at: now.toISOString(), acknowledged_at: null })
    const acknowledged = store.action(alice, created.id, 'acknowledge')!
    expect(acknowledged).toMatchObject({ read_at: now.toISOString(), acknowledged_at: now.toISOString(), acknowledged_action_id: 'acknowledge' })
    now = new Date('2026-09-26T12:02:00Z')
    expect(store.action(alice, created.id, 'acknowledge')?.updated_at).toBe(acknowledged.updated_at)
    expect(store.clear(alice)).toMatchObject({ notifications: [], unread_count: 0, clearable_count: 0, can_clear: false })
    expect(store.clear(alice).notifications).toEqual([])
  })

  it('shares server notifications across one owner profiles without leaking owners or profile notifications', () => {
    const store = new UpdateNotificationStore(temp())
    const server = store.begin(alice, 'webui')
    const automatic = store.begin({ owner: '*', profile: 'default' }, 'webui')
    const profile = store.create(alice, { kind: 'profile_notice', phase: 'notice', title: 'Profile notice', message: 'Only work.', visibility: 'profile' })
    const personal = store.list(alice)
    const otherProfile = store.list({ owner: alice.owner, profile: 'personal', serverOwner: true })
    const otherOwner = store.list({ owner: 'oidc:bob', profile: 'work', serverOwner: true })
    const nonOwner = store.list({ owner: 'oidc:bob', profile: 'work' })

    expect(personal.notifications.map((row) => row.id)).toEqual(expect.arrayContaining([server.id, profile.id]))
    expect(otherProfile.notifications.map((row) => row.id)).toEqual(expect.arrayContaining([server.id, automatic.id]))
    expect(otherOwner.notifications.map((row) => row.id)).toEqual([automatic.id])
    expect(nonOwner.notifications).toEqual([])
    expect(store.dismiss({ owner: alice.owner, profile: 'work' }, server.id)).toBe('not_found')
    expect(store.activeUpdate({ owner: alice.owner, profile: 'work' }, 'webui')).toBeNull()
    expect(otherProfile.scope_id).not.toBe(personal.scope_id)
    expect(store.activeUpdate({ owner: alice.owner, profile: 'personal', serverOwner: true }, 'webui')?.id).toBe(automatic.id)
  })

  it('keeps each tab on its latest update operation across a restart without leaking it to another owner', () => {
    const root = temp()
    let now = new Date('2026-09-27T12:00:00Z')
    const store = new UpdateNotificationStore(root, () => now)
    const tab = { ...alice, tab: 'tab-aaaaaaaa' }
    const agent = store.begin(tab, 'agent')
    now = new Date('2026-09-27T12:01:00Z')
    const web = store.begin(tab, 'webui')
    store.transition(agent.id, 'failed')
    expect(store.list(tab).tab_update?.id).toBe(web.id)
    expect(store.list(alice).tab_update).toBeNull()
    expect(store.list({ owner: 'oidc:bob', profile: 'work', serverOwner: true, tab: 'tab-aaaaaaaa' }).tab_update).toBeNull()
    store.transition(web.id, 'restarting', 'a'.repeat(40))
    const restarted = new UpdateNotificationStore(root, () => now)
    restarted.reconcileInterruptedUpdates('a'.repeat(40))
    expect(restarted.list(tab).tab_update).toMatchObject({ id: web.id, phase: 'succeeded' })
    expect(restarted.list(tab).tab_update).not.toHaveProperty('watchers')
  })

  it('follows the operation a tab rejoined most recently, not the newest one', () => {
    let now = new Date('2026-09-27T12:00:00Z')
    const store = new UpdateNotificationStore(temp(), () => now)
    const other = { ...alice, tab: 'tab-bbbbbbbb' }
    const tab = { ...alice, tab: 'tab-aaaaaaaa' }
    const web = store.begin(other, 'webui')
    now = new Date('2026-09-27T12:01:00Z')
    const agent = store.begin(tab, 'agent')
    expect(store.list(tab).tab_update?.id).toBe(agent.id)
    now = new Date('2026-09-27T12:02:00Z')
    store.watch(tab, web.id)
    expect(store.list(tab).tab_update?.id).toBe(web.id)
    expect(store.list(other).tab_update?.id).toBe(web.id)
  })

  it('keeps every tab that joined an operation attached to it, however many join', () => {
    const root = temp()
    const store = new UpdateNotificationStore(root)
    const tabs = Array.from({ length: 12 }, (_, index) => ({ ...alice, tab: `tab-${String(index).padStart(8, '0')}` }))
    const web = store.begin(tabs[0]!, 'webui')
    for (const tab of tabs.slice(1)) store.watch(tab, web.id)
    const restarted = new UpdateNotificationStore(root)
    for (const tab of tabs) expect(restarted.list(tab).tab_update?.id).toBe(web.id)
  })

  it('reconciles interrupted applying and restarting records against the running identity', () => {
    const root = temp()
    const first = new UpdateNotificationStore(root).begin(alice, 'webui')
    let restarted = new UpdateNotificationStore(root)
    restarted.reconcileInterruptedUpdates('a'.repeat(40))
    expect(restarted.list(alice).notifications.find((row) => row.id === first.id)?.phase).toBe('unknown')

    const restarting = restarted.begin(alice, 'webui')
    restarted.transition(restarting.id, 'restarting', 'b'.repeat(40))
    restarted = new UpdateNotificationStore(root)
    restarted.reconcileInterruptedUpdates('b'.repeat(40), 'web-v2.0.0')
    expect(restarted.list(alice).notifications.find((row) => row.id === restarting.id)).toMatchObject({
      phase: 'succeeded', verified_revision: 'b'.repeat(40), verified_version: 'web-v2.0.0',
    })

    const unverified = restarted.begin(alice, 'webui')
    restarted.transition(unverified.id, 'restarting', 'c'.repeat(40))
    restarted = new UpdateNotificationStore(root)
    restarted.reconcileInterruptedUpdates('d'.repeat(40))
    expect(restarted.list(alice).notifications.find((row) => row.id === unverified.id)).toMatchObject({ phase: 'unknown', verified_revision: null, verified_version: null })

    const interruptedAgent = restarted.begin(alice, 'agent')
    restarted = new UpdateNotificationStore(root)
    restarted.reconcileInterruptedUpdates('d'.repeat(40))
    expect(restarted.list(alice).notifications.find((row) => row.id === interruptedAgent.id)).toMatchObject({ phase: 'unknown', verified_revision: null, verified_version: null })

    const clearedAgent = restarted.begin(alice, 'agent')
    restarted.clear(alice)
    restarted = new UpdateNotificationStore(root)
    restarted.reconcileInterruptedUpdates('d'.repeat(40))
    expect(restarted.activeUpdate(alice, 'agent')).toBeNull()
    expect(restarted.list(alice).notifications.some((row) => row.id === clearedAgent.id)).toBe(false)
    expect(restarted.begin(alice, 'agent').id).not.toBe(clearedAgent.id)
  })

  it('cancels an awaiting confirmation idempotently', () => {
    const store = new UpdateNotificationStore(temp())
    const notification = store.begin(alice, 'agent')
    store.transition(notification.id, 'awaiting_confirmation')
    const cancelled = store.cancelUpdate(alice, notification.id)!
    expect(cancelled).toMatchObject({ phase: 'blocked', message: 'The update was cancelled before installation.', unread: false })
    expect(store.cancelUpdate(alice, notification.id)).toEqual(cancelled)
  })

  it('makes a new lifecycle phase unread after the earlier phase was read', () => {
    const store = new UpdateNotificationStore(temp())
    const notification = store.begin(alice, 'webui')
    expect(store.read(alice, notification.id)?.unread).toBe(false)
    expect(store.transition(notification.id, 'succeeded')?.unread).toBe(true)
  })

  it('ignores external writes while running and bounds owner history', () => {
    const root = temp()
    const store = new UpdateNotificationStore(root)
    for (let index = 0; index < 60; index += 1) {
      store.create(alice, { kind: 'system', phase: 'notice', title: `Notice ${String(index)}`, message: 'Safe', visibility: 'server' })
    }
    expect(store.list(alice).notifications).toHaveLength(50)

    const file = join(root, 'update-notifications.json')
    writeFileSync(file, '[]')
    expect(store.list(alice).notifications).toHaveLength(50)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([])
  })

  it('retains an older unresolved required alert ahead of newer ordinary history', () => {
    const root = temp()
    let tick = 0
    const store = new UpdateNotificationStore(root, () => new Date(Date.UTC(2026, 8, 26, 12, 0, tick++)))
    const required = store.create(alice, {
      kind: 'system', phase: 'attention', title: 'Required', message: 'Acknowledge me.', visibility: 'server',
      requiresAcknowledgement: true, actions: [{ id: 'acknowledge', label: 'Acknowledge', style: 'primary', acknowledges: true }],
    })
    for (let index = 0; index < 55; index += 1) {
      store.create(alice, { kind: 'system', phase: 'notice', title: `Notice ${String(index)}`, message: 'Ordinary', visibility: 'server' })
    }
    const listed = store.list(alice)
    expect(listed.notifications).toHaveLength(50)
    expect(listed.notifications.some((row) => row.id === required.id && row.requires_interaction)).toBe(true)
  })

  it('rejects new history instead of returning a record that protected capacity cannot store', () => {
    const store = new UpdateNotificationStore(temp())
    let firstID = ''
    for (let index = 0; index < 50; index += 1) {
      const row = store.create(alice, {
        kind: 'system', phase: 'attention', title: `Required ${String(index)}`, message: 'Acknowledge me.', visibility: 'server',
        requiresAcknowledgement: true, actions: [{ id: 'acknowledge', label: 'Acknowledge', style: 'primary', acknowledges: true }],
      })
      firstID ||= row.id
    }
    expect(() => store.create(alice, { kind: 'system', phase: 'notice', title: 'Phantom', message: 'Must not be returned.', visibility: 'server' }))
      .toThrow('protected capacity reached')
    store.action(alice, firstID, 'acknowledge')
    expect(store.create(alice, { kind: 'system', phase: 'notice', title: 'Stored', message: 'There is room now.', visibility: 'server' }).title).toBe('Stored')
  })

  describe('stale Web tab refresh notices', () => {
    const oldBuild = 'a'.repeat(64)
    const newBuild = 'b'.repeat(64)
    const newerBuild = 'c'.repeat(64)
    const tabA = { ...alice, tab: 'tab-aaaaaaaa' }
    const tabB = { ...alice, tab: 'tab-bbbbbbbb' }

    it('compares exact builds and never raises a notice for a matching or unknown build', () => {
      const store = new UpdateNotificationStore(temp())
      expect(store.syncTabBuild(tabA, newBuild, newBuild)).toEqual({ current_build: newBuild, loaded_build: newBuild, refresh_required: false, notification_id: null })
      expect(store.syncTabBuild(tabA, oldBuild, null)).toMatchObject({ refresh_required: false, notification_id: null })
      expect(store.syncTabBuild(tabA, null, newBuild)).toMatchObject({ refresh_required: false, notification_id: null })
      expect(store.syncTabBuild(tabA, 'web-v1.2.3', newBuild)).toMatchObject({ loaded_build: null, refresh_required: false })
      expect(store.syncTabBuild({ ...alice, tab: null }, oldBuild, newBuild)).toMatchObject({ refresh_required: false, notification_id: null })
      expect(store.list(tabA).notifications).toEqual([])
    })

    it('keeps one persistent tab-scoped notice per stale tab, invisible to other tabs and non-tab clients', () => {
      const store = new UpdateNotificationStore(temp())
      const first = store.syncTabBuild(tabA, oldBuild, newBuild)
      expect(first).toMatchObject({ current_build: newBuild, loaded_build: oldBuild, refresh_required: true })
      const again = store.syncTabBuild(tabA, oldBuild, newBuild)
      expect(again.notification_id).toBe(first.notification_id)
      const listed = store.list(tabA).notifications
      expect(listed).toHaveLength(1)
      expect(listed[0]).toMatchObject({
        id: first.notification_id, kind: 'web_refresh', persistent: true, requires_interaction: true, can_dismiss: false,
        actions: [{ id: 'reload', label: 'Refresh now', style: 'primary', acknowledges: false }],
      })

      expect(store.list(alice).notifications).toEqual([])
      expect(store.list(tabB).notifications).toEqual([])
      expect(store.list({ ...tabA, owner: 'oidc:bob' }).notifications).toEqual([])
      expect(store.syncTabBuild(tabB, newerBuild, newBuild).notification_id).not.toBe(first.notification_id)
      expect(store.list(tabA).notifications.map((row) => row.id)).toEqual([first.notification_id])
      expect(store.read(alice, first.notification_id!)).toBeNull()
      expect(store.dismiss(tabB, first.notification_id!)).toBe('not_found')
    })

    it('treats read, clear, dismissal, and the refresh action as non-resolving until the tab reports the current build', () => {
      const root = temp()
      let now = new Date('2026-09-26T12:00:00Z')
      const store = new UpdateNotificationStore(root, () => now)
      const id = store.syncTabBuild(tabA, oldBuild, newBuild).notification_id!
      const created = store.list(tabA).notifications[0]!
      now = new Date('2026-09-26T12:01:00Z')
      expect(store.read(tabA, id)).toMatchObject({ unread: false, requires_interaction: true })
      expect(store.dismiss(tabA, id)).toBe('acknowledgement_required')
      expect(store.clear(tabA).notifications.map((row) => row.id)).toEqual([id])
      expect(store.action(tabA, id, 'reload')).toMatchObject({ requires_interaction: true, acknowledged_at: null, can_dismiss: false })
      expect(store.action(tabA, id, 'reload')).toMatchObject({ requires_interaction: true })

      now = new Date('2026-09-26T12:02:00Z')
      expect(store.syncTabBuild(tabA, oldBuild, newBuild).notification_id).toBe(id)
      expect(new UpdateNotificationStore(root, () => now).syncTabBuild(tabA, oldBuild, newBuild).notification_id).toBe(id)
      expect(store.list(tabA).notifications[0]?.updated_at).not.toBe(created.updated_at)

      const verified = store.syncTabBuild(tabA, newBuild, newBuild)
      expect(verified).toMatchObject({ refresh_required: false, notification_id: null })
      expect(store.list(tabA).notifications).toEqual([])
      expect(new UpdateNotificationStore(root).list(tabA).notifications).toEqual([])
    })

    it('retargets one record to a newer deployment and drops notices of tabs that stopped checking in', () => {
      let now = new Date('2026-09-26T12:00:00Z')
      const store = new UpdateNotificationStore(temp(), () => now)
      const id = store.syncTabBuild(tabA, oldBuild, newBuild).notification_id!
      store.read(tabA, id)
      const before = store.list(tabA).notifications[0]!
      now = new Date('2026-09-26T12:10:00Z')
      expect(store.syncTabBuild(tabA, oldBuild, newBuild).notification_id).toBe(id)
      expect(store.list(tabA).notifications[0]).toEqual(before)
      expect(store.syncTabBuild(tabA, oldBuild, newerBuild).notification_id).toBe(id)
      expect(store.list(tabA).notifications).toMatchObject([{ id, unread: true, updated_at: now.toISOString() }])

      now = new Date('2026-09-26T13:20:00Z')
      expect(store.list(tabA).notifications).toEqual([])
    })

    it('bounds tab notices separately so stale tabs never block or evict other notifications', () => {
      const store = new UpdateNotificationStore(temp())
      const tabs = Array.from({ length: 51 }, (_, index) => ({ ...alice, tab: `tab-${String(index).padStart(8, '0')}` }))
      const created = tabs.map((scope) => store.syncTabBuild(scope, oldBuild, newBuild))
      expect(created.slice(0, 50).every((state) => state.notification_id !== null)).toBe(true)
      expect(created[50]).toMatchObject({ refresh_required: true, notification_id: null })

      const required = store.create(alice, {
        kind: 'system', phase: 'attention', requiresAcknowledgement: true, title: 'Still delivered', message: 'Tabs do not use this capacity.',
        actions: [{ id: 'acknowledge', label: 'Acknowledge', style: 'primary', acknowledges: true }],
      })
      for (let index = 0; index < 50; index += 1) store.create(alice, { kind: 'profile_notice', phase: 'notice', title: `Notice ${String(index)}`, message: 'History.' })
      expect(store.list(alice).notifications.map((row) => row.id)).toContain(required.id)
      expect(store.list(tabs[0]!).notifications.map((row) => row.id)).toContain(created[0]!.notification_id)
    })
  })
})
