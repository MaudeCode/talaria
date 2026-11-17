/** TAL-2332: the server groups a turn's reasoning and tool rows, counts each group and merges repeated calls. */
import { afterEach, describe, expect, it } from 'vitest'
import { LiveActivityGroups } from './activity-groups.js'
import { anchorActivitySceneTransportPreview, buildTurnScene } from './anchor.js'
import { readToolLookupsShown } from './tool-display.js'

type Json = Record<string, unknown>
const call = (id: string, name: string, args: Json = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const reply = (id: string, content: string, isError = false) => ({ role: 'tool', tool_call_id: id, content, ...(isError ? { is_error: true } : {}) })
/** A settled turn's scene as it leaves the server. */
const sceneOf = (rows: Json[]) => anchorActivitySceneTransportPreview(buildTurnScene(rows.map((m, i) => [m, i]))!) as { activity_rows: Json[]; activity_groups: Json[]; final_phase_activity: Json }
const shape = (rows: Json[]) => rows.map((row) => [row.row_id, row.group_id ?? null, row.merged_count ?? row.merged_into ?? null])

afterEach(() => { readToolLookupsShown(() => false) })

describe('activity groups', () => {
  it('runs reasoning and tools into one group until prose, and counts each group by kind', () => {
    const scene = sceneOf([
      { role: 'assistant', id: 'a1', reasoning: 'plan', content: '', tool_calls: [call('r1', 'read_file', { path: 'a' }), call('w1', 'web_search', { query: 'q' })] },
      reply('r1', 'a'), reply('w1', '{"data":{"web":[]}}'),
      { role: 'assistant', id: 'a2', content: 'Looked around.', tool_calls: [call('t1', 'terminal', { command: 'ls' })] },
      reply('t1', '{"output":"x","exit_code":0}'),
      { role: 'assistant', id: 'a3', content: 'Done.' },
    ])
    expect(shape(scene.activity_rows)).toEqual([
      ['a1:reasoning', 'group:0', null], ['tool:r1', 'group:0', null], ['tool:w1', 'group:0', null],
      ['a2:prose', null, null], ['tool:t1', 'group:1', null],
    ])
    expect(scene.activity_groups).toEqual([
      { group_id: 'group:0', parts: [{ kind: 'read', count: 1, failed: 0 }, { kind: 'web', count: 1, failed: 0 }], failed: 0, running: false },
      { group_id: 'group:1', parts: [{ kind: 'shell', count: 1, failed: 0 }], failed: 0, running: false },
    ])
  })

  it('merges two or more consecutive successful calls of one kind into the first, and a failed call breaks the run', () => {
    const scene = sceneOf([
      { role: 'assistant', id: 'a1', content: '', tool_calls: [call('r1', 'read_file', { path: 'a' }), call('r2', 'read_file', { path: 'b' }), call('r3', 'read_file', { path: 'c' }), call('r4', 'read_file', { path: 'd' }), call('r5', 'read_file', { path: 'e' }), call('r6', 'read_file', { path: 'f' })] },
      reply('r1', 'a'), reply('r2', 'b'), reply('r3', 'c'), reply('r4', 'missing', true), reply('r5', 'e'), reply('r6', 'f'),
      { role: 'assistant', id: 'a2', content: 'Read them.' },
    ])
    expect(shape(scene.activity_rows)).toEqual([
      ['tool:r1', 'group:0', 3], ['tool:r2', 'group:0', 'tool:r1'], ['tool:r3', 'group:0', 'tool:r1'],
      ['tool:r4', 'group:0', null],
      ['tool:r5', 'group:0', 2], ['tool:r6', 'group:0', 'tool:r5'],
    ])
    expect(scene.activity_groups).toEqual([{ group_id: 'group:0', parts: [{ kind: 'read', count: 6, failed: 1 }], failed: 1, running: false }])
  })

  it('never merges calls of different presentations, across reasoning, or a call still running', () => {
    const scene = sceneOf([
      { role: 'assistant', id: 'a1', content: '', tool_calls: [call('w1', 'web_search', { query: 'a' }), call('x1', 'web_extract', { urls: ['https://a.test'] })] },
      reply('w1', '{"data":{"web":[]}}'), reply('x1', '{"results":[]}'),
      { role: 'assistant', id: 'a2', reasoning: 'next', content: '', tool_calls: [call('w2', 'web_search', { query: 'b' })] },
      reply('w2', '{"data":{"web":[]}}'),
      { role: 'assistant', id: 'a3', content: '', tool_calls: [{ ...call('w3', 'web_search', { query: 'c' }), done: false }] },
      { role: 'assistant', id: 'a4', content: 'Searched.' },
    ])
    expect(scene.activity_rows.filter((row) => row.merged_count ?? row.merged_into)).toEqual([])
    expect(scene.activity_groups).toEqual([{ group_id: 'group:0', parts: [{ kind: 'web', count: 4, failed: 0 }], failed: 0, running: true }])
  })

  it('keeps calls with different verbs or apps, and a call showing media, out of a merged run', () => {
    const scene = sceneOf([
      { role: 'assistant', id: 'a1', content: '', tool_calls: [
        call('v1', 'browser_vault', { action: 'list' }), call('v2', 'browser_vault', { action: 'fill' }),
        call('m1', 'mcp__github__list_issues', {}), call('m2', 'mcp__linear__list_issues', {}),
        call('k1', 'kanban_show', { task_id: 't1' }), call('k2', 'kanban_show', { task_id: 't2' }),
      ] },
      reply('v1', '{"entries":[]}'), reply('v2', '{"filled_fields":[]}'), reply('m1', '[]'), reply('m2', '[]'), reply('k1', '{}'), reply('k2', '{}'),
      { role: 'assistant', id: 'a2', content: 'Done.' },
    ])
    expect(scene.activity_rows.map((row) => row.merged_count ?? row.merged_into ?? null)).toEqual([null, null, null, null, 2, 'tool:k1'])
  })

  it('leaves a hidden lookup out of the counts and merges across it, and a card call stands in a group of its own', () => {
    const scene = sceneOf([
      { role: 'assistant', id: 'a1', content: '', tool_calls: [call('r1', 'read_file', { path: 'a' }), call('l1', 'tool_search', { queries: ['x'] }), call('r2', 'read_file', { path: 'b' }), call('s1', 'show', {}), call('r3', 'read_file', { path: 'c' })] },
      reply('r1', 'a'), reply('l1', '[]'), reply('r2', 'b'), reply('s1', '{"block_id":"sb_0a1b2c3d4e5f","url":"/s","kind":"table","title":"T","note":null}'), reply('r3', 'c'),
      { role: 'assistant', id: 'a2', content: 'Shown.' },
    ])
    expect(shape(scene.activity_rows)).toEqual([
      ['tool:r1', 'group:0', 2], ['tool:l1', 'group:0', null], ['tool:r2', 'group:0', 'tool:r1'],
      ['tool:s1', 'group:1', null], ['tool:r3', 'group:2', null],
    ])
    expect(scene.activity_groups.map((group) => group.parts)).toEqual([[{ kind: 'read', count: 2, failed: 0 }], [{ kind: 'talaria', count: 1, failed: 0 }], [{ kind: 'read', count: 1, failed: 0 }]])
    // Shown lookups count like any call.
    readToolLookupsShown(() => true)
    const shown = sceneOf([
      { role: 'assistant', id: 'a1', content: '', tool_calls: [call('l1', 'tool_search', { queries: ['x'] }), call('l2', 'tool_search', { queries: ['y'] })] },
      reply('l1', '[]'), reply('l2', '[]'),
      { role: 'assistant', id: 'a2', content: 'Found.' },
    ])
    expect(shown.activity_groups).toEqual([{ group_id: 'group:0', parts: [{ kind: 'search', count: 2, failed: 0 }], failed: 0, running: false }])
  })

  it('words each work phase a consumed steer ends from that phase\'s calls', () => {
    const scene = sceneOf([
      { role: 'assistant', id: 'a1', content: '', tool_calls: [call('r1', 'read_file', { path: 'a' })] },
      reply('r1', 'a'),
      { role: 'user', content: 'also check the web', _steer: { steer_id: 'st1', consumed_at: 2 } },
      { role: 'assistant', id: 'a2', content: '', tool_calls: [call('w1', 'web_search', { query: 'q' }), call('w2', 'terminal', { command: 'x' })] },
      reply('w1', '{"data":{"web":[]}}'), reply('w2', 'bad', true),
      { role: 'assistant', id: 'a3', content: 'Checked.' },
    ])
    expect(scene.activity_rows.find((row) => row.role === 'steering')?.phase_activity).toEqual({ group_id: 'phase:0', parts: [{ kind: 'read', count: 1, failed: 0 }], failed: 0, running: false })
    expect(scene.final_phase_activity).toEqual({ group_id: 'phase:1', parts: [{ kind: 'web', count: 1, failed: 0 }, { kind: 'shell', count: 1, failed: 1 }], failed: 1, running: false })
    expect(scene.activity_rows.map((row) => row.group_id ?? null)).toEqual(['group:0', null, 'group:1', 'group:1'])
  })

  it('counts a lookup that started hidden and then failed in the group it shows in, live as settled', () => {
    const settled = sceneOf([
      { role: 'assistant', id: 'a1', content: '', tool_calls: [call('l1', 'tool_search', { queries: ['x'] }), call('r1', 'read_file', { path: 'a' })] },
      reply('l1', 'no index', true), reply('r1', 'a'),
      { role: 'assistant', id: 'a2', content: 'Done.' },
    ])
    const live = new LiveActivityGroups()
    expect(live.start('l1', 'tool_search')).toEqual({})
    live.start('r1', 'read_file')
    expect(live.complete('l1', 'tool_search', true)).toEqual({ group_id: 'group:0', group: { ...settled.activity_groups[0], running: true } })
    expect(live.complete('r1', 'read_file', false)).toEqual({ group_id: 'group:0', group: settled.activity_groups[0] })
    expect(settled.activity_groups[0]).toEqual({ group_id: 'group:0', parts: [{ kind: 'search', count: 1, failed: 1 }, { kind: 'read', count: 1, failed: 0 }], failed: 1, running: false })
  })

  it('ships the whole group\'s record with a preview that pages part of it out', () => {
    const calls = Array.from({ length: 100 }, (_, i) => `r${String(i)}`)
    const scene = sceneOf([
      { role: 'assistant', id: 'a1', content: '', tool_calls: calls.map((id) => call(id, i(id) % 2 ? 'read_file' : 'terminal', { path: id, command: id })) },
      ...calls.map((id) => reply(id, i(id) % 2 ? 'x' : '{"output":"x","exit_code":0}')),
      { role: 'assistant', id: 'a2', content: 'Done.' },
    ])
    expect(scene.activity_rows.length).toBeLessThan(100)
    expect(scene.activity_groups).toEqual([{ group_id: 'group:0', parts: [{ kind: 'shell', count: 50, failed: 0 }, { kind: 'read', count: 50, failed: 0 }], failed: 0, running: false }])
  })
})

const i = (id: string) => Number(id.slice(1))
