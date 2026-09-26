import { describe, expect, it } from 'vitest'
import { toolDisplay, toolKind } from './tool-display.js'

describe('toolKind', () => {
  it.each([
    ['delegate_task', 'delegate'], ['subagent_progress', 'delegate'],
    ['skill_view', 'skill'], ['skills_list', 'skill'],
    ['memory', 'memory'],
    ['terminal', 'shell'], ['bash', 'shell'], ['exec_command', 'shell'], ['process', 'shell'], ['execute_code', 'shell'],
    ['read_file', 'read'], ['read_url', 'read'], ['vision_analyze', 'read'],
    ['list_directory', 'list'], ['todo', 'list'],
    ['web_search', 'web'], ['web_extract', 'web'], ['browser_navigate', 'web'],
    ['search_files', 'search'], ['grep', 'search'], ['rg', 'search'], ['ripgrep', 'search'], ['glob', 'search'],
    ['write_file', 'write'], ['patch', 'write'], ['mcp_filesystem_edit_file', 'write'],
    ['HTTPFetch', 'web'], ['URLRead', 'read'], ['readFile', 'read'], ['webSearch', 'web'], ['shellCommand', 'shell'], ['mergePullRequest', 'unknown'],
    ['merge_pull_request', 'unknown'], ['image_generate', 'unknown'], ['', 'unknown'], [undefined, 'unknown'],
  ])('%s is %s', (name, kind) => {
    expect(toolKind(name)).toBe(kind)
  })
})

describe('toolDisplay', () => {
  it('derives the target from the sidecar snapshot rule, so a live and a persisted call agree', () => {
    const long = 'q'.repeat(250)
    const live = { query: `${'q'.repeat(120)}...` }
    expect(toolDisplay('web_search', { query: long }).target).toBe(`${'q'.repeat(120)}...`)
    expect(toolDisplay('web_search', live).target).toBe(toolDisplay('web_search', { query: long }).target)
    // Only the first four arguments reach the live frame.
    expect(toolDisplay('delegate_task', { a: 1, b: 2, c: 3, d: 4, task: 'x' }).target).toBe('')
  })

  it('takes the first line of the kind\'s argument, whitespace-collapsed and capped', () => {
    expect(toolDisplay('terminal', { command: '  ls   -la\n  rm x', path: 'p' })).toEqual({ kind: 'shell', target: 'ls -la' })
    expect(toolDisplay('read_file', { command: 'c', path: 'src/a.ts' })).toEqual({ kind: 'read', target: 'src/a.ts' })
    expect(toolDisplay('web_search', { query: 'q', url: 'https://x' })).toEqual({ kind: 'web', target: 'q' })
    expect(toolDisplay('skill_view', { name: 'pdf' })).toEqual({ kind: 'skill', target: 'pdf' })
    expect(toolDisplay('delegate_task', { task: 'Summarize' })).toEqual({ kind: 'delegate', target: 'Summarize' })
    expect(toolDisplay('terminal', { command: 'x'.repeat(300) }).target).toHaveLength(200)
    expect(toolDisplay('terminal', null)).toEqual({ kind: 'shell', target: '' })
    expect(toolDisplay('terminal', { command: 42 })).toEqual({ kind: 'shell', target: '' })
  })
})
