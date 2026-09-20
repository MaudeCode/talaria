import { describe, expect, it } from 'vitest'
import { parseCommand, suggestCommands } from './commands'

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

describe('suggestCommands', () => {
  it('prefers local commands, dedupes and hides CLI-only server commands', () => {
    const out = suggestCommands('s', [
      { name: 'stop', description: 'server stop' },
      { name: 'sync', description: 'sync', cli_only: true },
      { name: 'summarize', description: 'sum', args_hint: '<n>' },
    ])
    const names = out.map((c) => c.name)
    expect(names).toContain('stop')
    expect(names.filter((n) => n === 'stop')).toHaveLength(1)
    expect(names).not.toContain('sync')
    expect(out.find((c) => c.name === 'summarize')).toMatchObject({ source: 'server', args: '<n>' })
    expect(out.find((c) => c.name === 'stop')?.source).toBe('local')
  })
  it('matches aliases', () => {
    expect(suggestCommands('compa', []).map((c) => c.name)).toContain('compress')
  })
})
