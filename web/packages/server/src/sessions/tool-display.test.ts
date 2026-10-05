import { describe, expect, it } from 'vitest'
import { withToolCallOutcomes } from './merge.js'
import { EDIT_DIFF_MAX_LINES, toolArgs, toolDisplay, toolEditDiff, toolKind } from './tool-display.js'

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

describe('toolEditDiff (TAL-448)', () => {
  // Two files; the second file's removed `-- dashes` line reads `--- dashes` and is no header, and its hunk runs past the cap.
  const added = Array.from({ length: 450 }, (_, i) => `+line ${String(i)}`)
  const diff = ['--- a/app.env', '+++ b/app.env', '@@ -1,3 +1,3 @@', ' KEEP=1', '-OLD=1', '+NEW=1', ' TAIL=1',
    '--- a/notes.md', '+++ b/notes.md', '@@ -1,2 +1,451 @@', ' # Notes', '--- dashes', ...added].join('\n') + '\n'
  const patch = JSON.stringify({ success: true, diff, files_modified: ['app.env', 'notes.md'] })

  it('counts added and removed lines over the whole diff, excluding file headers', () => {
    const small = '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+more\n'
    expect(toolEditDiff('patch', JSON.stringify({ success: true, diff: small }))).toEqual({ added: 2, removed: 1, diff: small.trimEnd(), truncated: false })
    // A hunk header without counts covers one line; a dict result reads the same as its JSON text.
    expect(toolEditDiff('patch', { diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b' })).toMatchObject({ added: 1, removed: 1, truncated: false })
    // A final line without a newline runs into the next file's header; the header pair still ends that hunk.
    expect(toolEditDiff('patch', { diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a+b\n--- a/y\n+++ b/y\n@@ -0,0 +1 @@\n+c\n' })).toMatchObject({ added: 1, removed: 1 })
  })

  it('caps the shown diff at 400 lines and flags it, with counts that still cover all of it', () => {
    const edit = toolEditDiff('patch', patch)!
    expect(edit).toMatchObject({ added: 451, removed: 2, truncated: true })
    expect(edit.diff.split('\n')).toHaveLength(EDIT_DIFF_MAX_LINES)
    expect(edit.diff.split('\n').at(-1)).toBe(`+line ${String(EDIT_DIFF_MAX_LINES - 13)}`)
    // A few enormous lines are capped too, at a line boundary.
    expect(toolEditDiff('edit_file', { diff: `@@ -1 +1 @@\n-a\n+${'x'.repeat(100_000)}` })).toEqual({ added: 1, removed: 1, diff: '@@ -1 +1 @@\n-a', truncated: true })
  })

  it('is absent for a result without a diff, a non-JSON result, and a call that is not a file edit', () => {
    expect(toolEditDiff('write_file', JSON.stringify({ bytes_written: 12, dirs_created: false }))).toBeUndefined()
    expect(toolEditDiff('patch', 'Error: old_string not found')).toBeUndefined()
    expect(toolEditDiff('patch', JSON.stringify({ success: false, error: 'no match', diff: '' }))).toBeUndefined()
    expect(toolEditDiff('terminal', patch)).toBeUndefined()
    expect(toolEditDiff('patch', null)).toBeUndefined()
  })

  it('reaches a persisted call from its reply, and a reply-less live record from the change it decided', () => {
    const decided = toolEditDiff('patch', patch)!
    const [assistant] = withToolCallOutcomes([
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'patch', arguments: '{}' } }, { id: 'c2', type: 'function', function: { name: 'write_file', arguments: '{}' } }],
        _partial_tool_calls: [{ tid: 'c3', name: 'patch', args: {}, done: true, edit_diff: decided }] },
      { role: 'tool', tool_call_id: 'c1', content: patch },
      { role: 'tool', tool_call_id: 'c2', content: '{"bytes_written": 3}' },
    ], [], null) as unknown as [{ tool_calls: Record<string, unknown>[] }]
    expect(assistant.tool_calls.map((call) => call.edit_diff)).toEqual([decided, undefined, decided])
  })
})
