import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { withKanbanPolicy, withTaskPolicy } from './kanban.js'

const task = (board: string, id: string, status = 'todo', extra = {}) => ({ key: `${board}/${id}`, board, task: { id, title: id, status, priority: 0, claim_live: false, has_completion_evidence: false, agent_move_targets: null, ...extra } })
const edge = (source: string, target: string) => ({ source, target })
const inspect = (nodes: ReturnType<typeof task>[], edges = [] as ReturnType<typeof edge>[], extra = {}) => withKanbanPolicy({ nodes, edges, truncated: false, generated_at: 200, ...extra }) as unknown as { nodes: { key: string; ancestors: string[]; descendants: string[]; cycle: boolean; running_lineage: boolean; timing: { start: number | null; end: number | null; duration_seconds: number | null }; task: { available_actions: unknown } }[]; edges: ReturnType<typeof edge>[]; truncated: boolean }

describe('Kanban inspection projection', () => {
  it('qualifies identities across authorized boards and resolves transitive running lineage and cycles', () => {
    const view = inspect([task('a', '1'), task('a', '2', 'running'), task('a', '3'), task('b', '1')], [edge('a/1', 'a/2'), edge('a/2', 'a/3'), edge('a/3', 'a/2')])
    expect(view.nodes.find(n => n.key === 'a/1')).toMatchObject({ ancestors: [], descendants: ['a/2', 'a/3'], cycle: false, running_lineage: true })
    expect(view.nodes.find(n => n.key === 'a/2')).toMatchObject({ cycle: true, running_lineage: true })
    expect(view.nodes.find(n => n.key === 'b/1')).toMatchObject({ ancestors: [], descendants: [], running_lineage: false })
    expect(view.nodes[0]?.task.available_actions).toBeDefined()
  })

  it('drops removed and hidden nodes before traversal without fabricating connections', () => {
    const view = inspect([task('a', '1'), task('a', 'hidden', 'archived'), task('a', '2')], [edge('a/1', 'a/hidden'), edge('a/hidden', 'a/2'), edge('a/1', 'missing')])
    expect(view.nodes.map(n => n.key)).toEqual(['a/1', 'a/2'])
    expect(view.edges).toEqual([])
    expect(view.nodes[0]?.descendants).toEqual([])
  })

  it('uses actual run timestamps, keeps unknowns null, and never uses creation as an effort date', () => {
    const view = inspect([task('a', 'unknown', 'ready', { created_at: 10 }), task('a', 'retry', 'running', { started_at: 10, current_run_started_at: 150 }), task('a', 'done', 'done', { started_at: 20, completed_at: 80 })])
    expect(view.nodes.find(n => n.key === 'a/unknown')?.timing).toMatchObject({ start: null, end: null, duration_seconds: null })
    expect(view.nodes.find(n => n.key === 'a/retry')?.timing).toMatchObject({ start: 150, end: null, duration_seconds: 50 })
    expect(view.nodes.find(n => n.key === 'a/done')?.timing).toMatchObject({ start: 20, end: 80, duration_seconds: 60 })
  })

  it('matches a per-node walk on a full-budget graph with cycles', () => {
    let seed = 1713
    const rand = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n }
    const nodes = Array.from({ length: 500 }, (_, i) => task('a', String(i)))
    const edges = Array.from({ length: 2000 }, () => edge(`a/${rand(500)}`, `a/${rand(500)}`))
    const adjacency = (dir: 'up' | 'down') => {
      const map = new Map<string, string[]>()
      for (const e of edges) { const [from, to] = dir === 'down' ? [e.source, e.target] : [e.target, e.source]; map.set(from, [...(map.get(from) ?? []), to]) }
      return map
    }
    const walk = (id: string, map: Map<string, string[]>) => {
      const seen = new Set<string>(), stack = [...(map.get(id) ?? [])]
      while (stack.length) { const next = stack.pop()!; if (!seen.has(next)) { seen.add(next); stack.push(...(map.get(next) ?? [])) } }
      return seen
    }
    const up = adjacency('up'), down = adjacency('down')
    const golden = nodes.map(({ key }) => {
      const ancestors = walk(key, up), descendants = walk(key, down)
      const cycle = ancestors.has(key) || descendants.has(key)
      ancestors.delete(key); descendants.delete(key)
      return { key, ancestors: [...ancestors].sort(), descendants: [...descendants].sort(), cycle }
    }).sort((a, b) => a.key.localeCompare(b.key))
    const view = inspect(nodes, edges)
    expect(view.nodes.map(({ key, ancestors, descendants, cycle }) => ({ key, ancestors, descendants, cycle }))).toEqual(golden)
    expect(golden.some(n => n.cycle) && golden.some(n => !n.cycle && n.descendants.length > 0)).toBe(true)
  })

  it('caps a hostile graph at 500 nodes and 2000 edges and marks it truncated', () => {
    // 3000 distinct edges, all between the first 500 nodes, so every one survives the node cap.
    const edges = Array.from({ length: 3000 }, (_, i) => edge(`a/${String(i % 500)}`, `a/${String((i % 500 + 1 + Math.floor(i / 500)) % 500)}`))
    const view = inspect(Array.from({ length: 700 }, (_, i) => task('a', String(i))), edges)
    expect(view.nodes).toHaveLength(500)
    expect(view.edges.length).toBeLessThanOrEqual(2000)
    expect(view.truncated).toBe(true)
  })
})

it('offers no card mutations for a read-only Kanban task', () => {
  const result = withKanbanPolicy({ task: { status: 'ready', read_only: true, agent_move_targets: null } })
  expect(result.task).toMatchObject({ available_actions: { block: false, unblock: false, complete: false, archive: false, move_to: [] } })
})

describe('Kanban task age and staleness (TAL-2648)', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../../contracts/fixtures/kanban-task-age.json', import.meta.url), 'utf8')) as { sidecar_task: Record<string, unknown>; board_task: Record<string, unknown> }
  const agentAge = (created: number | null, started: number | null) => ({ created_age_seconds: created, started_age_seconds: started, time_to_complete_seconds: null })
  const policy = (status: string, age: unknown) => withTaskPolicy({ status, agent_move_targets: null, age_seconds: age, age }) as { selected_age_seconds: number | null; staleness: string }

  it('selects the Agent age object\'s created age for a Ready task and marks it stale', () => {
    expect(withTaskPolicy(fixture.sidecar_task)).toEqual(fixture.board_task)
  })

  it.each([
    ['running', 599, 'none'], ['running', 600, 'warning'], ['running', 3599, 'warning'], ['running', 3600, 'critical'],
    ['ready', 3599, 'none'], ['ready', 3600, 'warning'], ['ready', 86400, 'warning'],
    ['blocked', 3599, 'none'], ['blocked', 3600, 'warning'], ['blocked', 86399, 'warning'], ['blocked', 86400, 'critical'],
    ['todo', 86400, 'none'], ['done', 86400, 'none'],
  ])('classifies a %s task aged %i s as %s, from an Agent age object or a legacy scalar', (status, seconds, staleness) => {
    const object = status === 'running' ? agentAge(1e9, seconds) : agentAge(seconds, 1e9)
    expect(policy(status, object)).toMatchObject({ selected_age_seconds: seconds, staleness })
    expect(policy(status, seconds)).toMatchObject({ selected_age_seconds: seconds, staleness })
  })

  it.each([
    ['a missing age', 'ready', undefined], ['a null age', 'blocked', null], ['a running task never started', 'running', agentAge(7200, null)],
    ['a ready task without a creation time', 'ready', agentAge(null, 7200)], ['a non-numeric age', 'ready', 'old'],
  ])('reports no age and no staleness for %s', (_, status, age) => {
    expect(policy(status, age)).toMatchObject({ selected_age_seconds: null, staleness: 'none' })
  })

  it('projects the same fields on board rows, task details, mutation replies and inspection nodes', () => {
    const fields = { selected_age_seconds: 7200, staleness: 'warning' }
    const board = withKanbanPolicy({ columns: [{ name: 'ready', label: 'Ready', tasks: [fixture.sidecar_task] }] }) as { columns: { tasks: unknown[] }[] }
    expect(board.columns[0]!.tasks[0]).toMatchObject(fields)
    expect((withKanbanPolicy({ task: fixture.sidecar_task, events: [], read_only: false }) as { task: unknown }).task).toMatchObject(fields)
    expect((withKanbanPolicy({ task: fixture.sidecar_task, read_only: false }) as { task: unknown }).task).toMatchObject(fields)
    expect(inspect([{ key: 'b/synthetic-ready', board: 'b', board_name: 'B', task: fixture.sidecar_task }] as never).nodes[0]!.task).toMatchObject(fields)
  })
})
