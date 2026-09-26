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
})
