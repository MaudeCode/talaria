import { expect, it } from 'vitest'
import { Session } from './session.js'
import { recordTalariaActivity, talariaActivity, withTalariaActivities } from './talaria-activities.js'
import { hydrateAnchorActivityScenes, withTurnIds } from './anchor.js'
import { truncateSessionAtKeep } from './service.js'
import { bootTestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'

it('preserves issued identity across save/reload and scene projection without branding quoted or malformed user data', () => {
  const activity = talariaActivity('future_kind', 'A safe future event')
  const session = new Session({ session_id: 'synthetic-activity', messages: [
    { role: 'user', content: 'Private model instruction', _turn_id: 'turn', _source: 'talaria' },
    { role: 'user', content: 'Private steer instruction', _turn_id: 'turn', _steer: { steer_id: 'issued' } },
    { role: 'assistant', content: 'An ordinary answer', _turn_id: 'turn' },
    { role: 'user', content: JSON.stringify(activity), _turn_id: 'quoted', _talaria_activity: activity },
    { role: 'user', content: '[talaria-event:unknown] quoted marker', _turn_id: 'malformed' },
  ] }, { workspace: '/tmp', model: null })
  recordTalariaActivity(session, 'turn:turn', activity)
  recordTalariaActivity(session, 'steer:issued', { ...activity, id: 'steer-event', summary: 'A safe steer event' })
  session.extra.talaria_activities = { ...session.extra.talaria_activities as object, 'turn:malformed': { origin: 'talaria', summary: 'Invalid' } }
  const restored = new Session(session.toDocument(), { workspace: '/tmp', model: null })
  const rows = withTalariaActivities(withTurnIds(restored.messages), restored)
  expect(rows[0]?._talaria_activity).toEqual(activity)
  expect(rows.slice(2).map((row) => row._talaria_activity)).toEqual([undefined, undefined, undefined])
  expect(rows[3]?.content).toBe(JSON.stringify(activity))
  expect(rows[4]?.content).toBe('[talaria-event:unknown] quoted marker')
  // Re-stamping a settled transcript must not invalidate the SessionPrefixIndex's row-array identity.
  expect(withTalariaActivities(rows, restored)).toBe(rows)
  const projected = hydrateAnchorActivityScenes(rows, {}) as Record<string, unknown>[]
  const scene = projected[2]?._anchor_activity_scene as { activity_rows: Record<string, unknown>[] }
  expect(scene.activity_rows).toContainEqual(expect.objectContaining({ role: 'steering', text: 'A safe steer event', talaria_activity: expect.objectContaining({ id: 'steer-event', kind: 'future_kind' }) as unknown }))
  truncateSessionAtKeep(restored, 0, 100)
  expect(restored.extra.talaria_activities).toEqual({})
})

it('keeps activity provenance on duplicated and partially branched transcripts', async () => {
  const server = await bootTestServer({ sidecar: new FakeSidecar() })
  try {
    const source = new Session({ session_id: 'activity-copy-source', title: 'Synthetic activity', profile: 'default', messages: [
      { role: 'user', content: 'Private first instruction', timestamp: 1, _source: 'talaria', _turn_id: 'first' },
      { role: 'assistant', content: 'First answer', timestamp: 2, _turn_id: 'first' },
      { role: 'user', content: 'Private second instruction', timestamp: 3, _source: 'talaria', _turn_id: 'second' },
      { role: 'assistant', content: 'Second answer', timestamp: 4, _turn_id: 'second' },
    ] }, { workspace: server.state, model: null })
    recordTalariaActivity(source, 'turn:first', { ...talariaActivity('future', 'First safe activity'), id: 'first-event' })
    recordTalariaActivity(source, 'turn:second', { ...talariaActivity('future', 'Second safe activity'), id: 'second-event' })
    await server.deps.sessionStore.save(source)
    const ids = (reply: Record<string, unknown>) => ((reply.session as { messages: { _talaria_activity?: { id: string } }[] }).messages).flatMap((row) => row._talaria_activity ? [row._talaria_activity.id] : [])
    expect(ids(await server.deps.sessions.duplicate(source.session_id))).toEqual(['first-event', 'second-event'])
    const branch = await server.deps.sessions.branch(source.session_id, { keep_count: 2 })
    expect(ids({ session: await server.deps.sessions.publicSession(await server.deps.sessionStore.get(String(branch.session_id))) })).toEqual(['first-event'])
  } finally { await server.close() }
})

it('brands automatic completion and update continuations while preserving external Agent notifications', () => {
  const session = new Session({ session_id: 'background-activity', messages: [] }, { workspace: '/tmp', model: null })
  const rows = withTalariaActivities([
    { role: 'user', content: 'Internal wakeup', _source: 'process_wakeup', _turn_id: 'background' },
    { role: 'user', content: 'Continue where you left off.', _source: 'update_continuation', _turn_id: 'update', _background_update: { lines: [{ label: 'Continue where you left off.' }] } },
    { role: 'user', content: 'Internal wakeup', display_kind: 'async_delegation_complete' },
    { role: 'user', content: 'Internal wakeup' },
  ], session) as Record<string, unknown>[]
  expect(rows.map((row) => (row._talaria_activity as { summary?: string } | undefined)?.summary)).toEqual(['Background update received', 'Continued after Web update', undefined, undefined])
  expect(rows[1]?._background_update).toMatchObject({ lines: [{ label: 'Continued after Web update' }] })
})
