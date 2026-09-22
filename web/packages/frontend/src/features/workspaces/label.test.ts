import { describe, expect, it } from 'vitest'
import { workspaceLabel } from './label'

describe('workspaceLabel', () => {
  const list = [{ path: '/Users/kilian/workspace', name: 'Home' }, { path: '/srv/app' }]
  it('prefers the registered name', () => { expect(workspaceLabel(list, '/Users/kilian/workspace')).toBe('Home') })
  it('falls back to the last path segment', () => {
    expect(workspaceLabel(list, '/srv/app')).toBe('app')
    expect(workspaceLabel(undefined, '/tmp/x/')).toBe('x')
    expect(workspaceLabel(list, null)).toBe('')
  })
})
