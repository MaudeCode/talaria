import { describe, expect, it } from 'vitest'
import { toolArgs, toolDisplay, toolKind } from './tool-display.js'

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
    // A non-string argument is shown as the sidecar's Python str() of it.
    expect(toolDisplay('delegate_task', { task: ['one', "it's", 2, true, null, { a: 1.5 }] }).target).toBe(`['one', "it's", 2, True, None, {'a': 1.5}]`)
    expect(toolDisplay('delegate_task', { task: 42 }).target).toBe('42')
    // The sidecar renders a live non-string argument by this same rule for the parsed JSON (test_chat_turn.py pins the
    // same cases), so a persisted `1.0` and the live frame both show `1`.
    const cases: [string, string][] = [
      ['1.0', '1'], ['3', '3'], ['1.5', '1.5'], ['-0.0', '0'], ['1e21', '1e+21'], ['1e20', '100000000000000000000'], ['1e-7', '1e-7'],
      ['0.000001', '0.000001'], ['1152921504606846976', '1152921504606847000'], ['1.5e-10', '1.5e-10'], ['true', 'True'], ['null', 'None'],
      [`[1.0, "it's", null, {"a": 1.5, "b": true}]`, `[1, "it's", None, {'a': 1.5, 'b': True}]`],
      [String.raw`["tab\there", "q\"uote"]`, String.raw`['tab\there', 'q"uote']`],
    ]
    for (const [json, shown] of cases) expect(toolDisplay('delegate_task', toolArgs({ function: { arguments: `{"task": ${json}}` } })).target).toBe(shown)
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
    expect(toolDisplay('terminal', { command: 42 })).toEqual({ kind: 'shell', target: '42' })
  })
})
