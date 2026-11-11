import { describe, expect, it } from 'vitest'
import { withKanbanPolicy } from './kanban.js'

const task = (board: string, id: string, status = 'todo', extra = {}) => ({ key: `${board}/${id}`, board, task: { id, title: id, status, priority: 0, claim_live: false, has_completion_evidence: false, agent_move_targets: null, ...extra } })
const edge = (source: string, target: string) => ({ source, target })
const inspect = (nodes: ReturnType<typeof task>[], edges = [] as ReturnType<typeof edge>[], extra = {}) => withKanbanPolicy({ nodes, edges, truncated: false, generated_at: 200, ...extra }) as unknown as { nodes: { key: string; ancestors: string[]; descendants: string[]; cycle: boolean; running_lineage: boolean; timing: { start: number | null; end: number | null; duration_seconds: number | null }; task: { available_actions: unknown } }[]; edges: ReturnType<typeof edge>[] }

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

  it('bounds hostile large graphs and never retains another profile between reads', () => {
    const view = inspect(Array.from({ length: 700 }, (_, i) => task('a', String(i))), Array.from({ length: 3000 }, () => edge('a/0', 'a/1')))
    expect(view.nodes.length).toBeLessThanOrEqual(500)
    expect(view.edges.length).toBeLessThanOrEqual(2000)
    const switched = inspect([task('other-profile', '1')])
    expect(switched.nodes).toHaveLength(1)
    expect(switched.nodes[0]?.ancestors).toEqual([])
  })
})
