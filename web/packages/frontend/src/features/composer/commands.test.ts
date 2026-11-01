import { describe, expect, it } from 'vitest'
import type { Command } from '../../contracts'
import * as commands from './commands'
import { commandCatalog } from '../../../../server/src/tools/commands.ts'

const { parseCommand, suggestCommands } = commands

describe('parseCommand', () => {
  it('parses name and args', () => {
    expect(parseCommand('/model gpt-5')).toEqual({ name: 'model', args: 'gpt-5', raw: '/model gpt-5' })
    expect(parseCommand('  /STOP')).toMatchObject({ name: 'stop', args: '' })
  })
  it('returns null for plain text or a lone slash', () => {
    expect(parseCommand('hello /x')).toBeNull()
    expect(parseCommand('/')).toBeNull()
    expect(parseCommand('/9')).toBeNull()
  })
})

// A synthetic `/api/commands` catalog in server display order (TAL-314).
const row = (name: string, extra: Partial<Command> = {}): Command => ({ name, description: name, aliases: [], handler: 'client', clients: ['web', 'ios'], ...extra })
const catalog: Command[] = [
  row('stop'),
  row('terminal', { clients: ['web'], unsupported_message: 'Terminal is not available in the mobile app.' }),
  row('compress', { aliases: ['compact'] }),
  row('branch', { aliases: ['fork'] }),
  row('background', { aliases: ['bg'], args_hint: '<message>' }),
  row('mobile-only', { clients: ['ios'] }),
  row('summarize', { handler: 'agent', category: 'Session', args_hint: '<n>' }),
  row('sync', { handler: 'agent', clients: [], unsupported_message: '/sync runs only in the Hermes CLI.' }),
]

describe('suggestCommands', () => {
  it('lists only the server catalog, in server order, restricted to Web', () => {
    expect(suggestCommands('', catalog).map((c) => c.name)).toEqual(['stop', 'terminal', 'compress', 'branch', 'background', 'summarize'])
    expect(suggestCommands('he', [])).toEqual([])
    expect(suggestCommands('s', catalog)).toEqual([
      { name: 'stop', desc: 'stop', args: undefined, category: undefined },
      { name: 'summarize', desc: 'summarize', args: '<n>', category: 'Session' },
    ])
  })
  it('matches a name or alias prefix case-insensitively and lists each command once', () => {
    expect(suggestCommands('COMPA', catalog).map((c) => c.name)).toEqual(['compress'])
    expect(suggestCommands('fo', catalog).map((c) => c.name)).toEqual(['branch'])
    expect(suggestCommands('b', catalog).map((c) => c.name)).toEqual(['branch', 'background'])
  })
})

describe('resolveCommand', () => {
  it('resolves a typed alias to its catalog entry', () => {
    expect(commands.resolveCommand('compact', catalog)?.name).toBe('compress')
    expect(commands.resolveCommand('FORK', catalog)?.name).toBe('branch')
    expect(commands.resolveCommand('bg', catalog)?.name).toBe('background')
    expect(commands.resolveCommand('terminal', catalog)?.clients).toEqual(['web'])
    expect(commands.resolveCommand('nope', catalog)).toBeUndefined()
  })
})

describe('runsOnServer', () => {
  const agent = (name: string, extra: Partial<Command> = {}): Command => ({ name, aliases: [], handler: 'agent', clients: ['web', 'ios'], ...extra })
  it('follows the server exec field', () => {
    expect(commands.runsOnServer(agent('reload-skills', { exec: true }))).toBe(true)
    expect(commands.runsOnServer(agent('reload-skills', { exec: false }))).toBe(false)
    expect(commands.runsOnServer(agent('save', { exec: false }))).toBe(false)
  })
  it('falls back to the legacy rule for a server that sends no exec field', () => {
    expect(commands.runsOnServer(agent('reload-skills'))).toBe(true)
    expect(commands.runsOnServer(agent('hello', { category: 'Plugin' }))).toBe(true)
    expect(commands.runsOnServer(agent('save', { category: 'Session' }))).toBe(false)
    expect(commands.runsOnServer({ name: 'stop', aliases: [], handler: 'client', clients: ['web', 'ios'] })).toBe(false)
  })
})

// TAL-1577: the real server catalog feeds the real Web matcher. `_` and `-` spell the same Agent command; the server
// publishes the other spelling in `aliases`, so the client matches it literally and holds no separator rule of its own.
describe('server catalog separator aliases', () => {
  type AgentRow = Parameters<typeof commandCatalog>[0][number]
  const agent = (name: string, extra: Partial<AgentRow> = {}): AgentRow => ({ name, description: name, category: 'Plugin', aliases: [], args_hint: '', subcommands: [], cli_only: false, gateway_only: false, exec: true, prompt: null, ...extra })
  const web = (rows: AgentRow[]) => commandCatalog(rows)

  it('finds and resolves the other separator spelling of a registered command', () => {
    const catalog = web([agent('knowledge-loop'), agent('plugin_review')])
    expect(suggestCommands('knowledge_loop', catalog).map((c) => c.name)).toEqual(['knowledge-loop'])
    expect(suggestCommands('knowledge_', catalog).map((c) => c.name)).toEqual(['knowledge-loop'])
    expect(commands.resolveCommand('knowledge_loop', catalog)?.name).toBe('knowledge-loop')
    expect(commands.resolveCommand('Knowledge_Loop', catalog)?.name).toBe('knowledge-loop')
    expect(commands.resolveCommand('plugin-review', catalog)?.name).toBe('plugin_review')
  })

  it('keeps each literal spelling its own command in either registration order', () => {
    for (const rows of [[agent('plugin-review'), agent('plugin_review')], [agent('plugin_review'), agent('plugin-review')]]) {
      const catalog = web(rows)
      expect(commands.resolveCommand('plugin_review', catalog)?.name).toBe('plugin_review')
      expect(commands.resolveCommand('plugin-review', catalog)?.name).toBe('plugin-review')
      expect(catalog.flatMap((c) => c.aliases)).not.toContain('plugin_review')
      expect(catalog.flatMap((c) => c.aliases)).not.toContain('plugin-review')
    }
  })

  it('folds only separators: no trailing-separator stripping or neighbouring slugs', () => {
    const catalog = web([agent('knowledge-loop'), agent('knowledgebase'), agent('knowledge')])
    expect(suggestCommands('knowledge_', catalog).map((c) => c.name)).toEqual(['knowledge-loop'])
    expect(commands.resolveCommand('knowledge_', catalog)).toBeUndefined()
    expect(commands.resolveCommand('knowledge_base', catalog)).toBeUndefined()
    expect(commands.resolveCommand('knowledge-loop-', catalog)).toBeUndefined()
  })
})
