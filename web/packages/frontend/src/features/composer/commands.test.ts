import { describe, expect, it } from 'vitest'
import type { Command } from '../../contracts'
import * as commands from './commands'

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
