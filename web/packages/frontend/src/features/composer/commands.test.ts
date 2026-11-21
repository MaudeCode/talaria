import { describe, expect, it } from 'vitest'
import type { Command } from '../../contracts'
import { suggestCommands } from './commands'

// A synthetic `/api/commands` catalog in server display order (TAL-314).
const row = (name: string, extra: Partial<Command> = {}): Command => ({ name, description: name, aliases: [], handler: 'client', clients: ['web', 'ios'], exec: false, ...extra })
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

