import { homedir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { toolOutcome, toolResultView, withToolCallOutcomes } from './merge.js'
import { diffHunks } from '../text/diff.js'
import { decidedEditDiff, EDIT_DIFF_MAX_LINES, tokenToolKind, toolArgs, toolDisplay, toolEditDiff, toolKind, toolName, toolProgress } from './tool-display.js'
import { fullToolResult } from './anchor.js'
import { publicToolFrame } from '../redact.js'
import { TALARIA_TOOL_NAMES, TOOL_PRESENTATIONS, type ToolResultView } from '@maudecode/talaria-web-contracts'

// TAL-1537: a `~/` path expands against a stubbed home.
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>()
  return { ...os, homedir: vi.fn(os.homedir) }
})

describe('toolKind', () => {
  it.each([
    ['delegate_task', 'delegate'], ['subagent_progress', 'delegate'],
    ['skill_view', 'skill'], ['skills_list', 'skill'],
    ['memory', 'memory'],
    ['terminal', 'shell'], ['bash', 'shell'], ['exec_command', 'shell'], ['process', 'shell'], ['execute_code', 'shell'],
    ['read_file', 'read'], ['read_url', 'read'], ['vision_analyze', 'read'],
    ['list_directory', 'list'], ['todo', 'list'], ['todo_list', 'list'],
    ['web_search', 'web'], ['web_extract', 'web'], ['browser_navigate', 'web'],
    ['search_files', 'search'], ['grep', 'search'], ['rg', 'search'], ['ripgrep', 'search'], ['glob', 'search'],
    ['write_file', 'write'], ['patch', 'write'], ['mcp_filesystem_edit_file', 'write'],
    ['HTTPFetch', 'web'], ['URLRead', 'read'], ['readFile', 'read'], ['webSearch', 'web'], ['shellCommand', 'shell'], ['mergePullRequest', 'unknown'],
    ['merge_pull_request', 'unknown'], ['image_generate', 'unknown'], ['', 'unknown'], [undefined, 'unknown'],
  ])('%s is %s', (name, kind) => {
    expect(toolKind(name)).toBe(kind)
  })

  it('classifies every Talaria tool as talaria, and a third-party tool by its tokens (TAL-2317)', () => {
    for (const name of TALARIA_TOOL_NAMES) expect(toolKind(name)).toBe('talaria')
    expect(toolKind('foo_list')).toBe('list')
    expect(toolKind('mcp_x_session_list')).toBe('list')
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
    expect(toolDisplay('terminal', { command: '  ls   -la\n  rm x', path: 'p' })).toEqual({ kind: 'shell', target: 'ls -la', focus_path: null })
    expect(toolDisplay('read_file', { command: 'c', path: 'src/a.ts' })).toEqual({ kind: 'read', target: 'src/a.ts', focus_path: 'src/a.ts' })
    expect(toolDisplay('web_search', { query: 'q', url: 'https://x' })).toEqual({ kind: 'web', target: 'q', focus_path: null })
    expect(toolDisplay('skill_view', { name: 'pdf' })).toEqual({ kind: 'skill', target: 'pdf', focus_path: null })
    expect(toolDisplay('delegate_task', { task: 'Summarize' })).toEqual({ kind: 'delegate', target: 'Summarize', focus_path: null })
    expect(toolDisplay('terminal', { command: 'x'.repeat(300) }).target).toHaveLength(200)
    expect(toolDisplay('terminal', null)).toEqual({ kind: 'shell', target: '', focus_path: null })
    expect(toolDisplay('terminal', { command: 42 })).toEqual({ kind: 'shell', target: '42', focus_path: null })
  })

  it('shows a browser_exec step as a web call labeled by its session, else its code\'s first non-empty line (TAL-1805)', () => {
    expect(toolDisplay('browser_exec', { code: 'goto("https://x")', session: 'checkout' })).toEqual({ kind: 'web', target: 'checkout', focus_path: null })
    expect(toolDisplay('browser_exec', { code: '\n\n  goto("https://x")\n  print(title())', session: ' ' })).toEqual({ kind: 'web', target: 'goto("https://x")', focus_path: null })
  })

  it.each([
    ['one goal', { goal: 'Audit auth' }, 'Audit auth'],
    ['a spawn action with a goal', { action: 'spawn', goal: 'Audit auth' }, 'Audit auth'],
    ['a batch', { tasks: [{ goal: 'a' }, { goal: 'b' }, { goal: 'c' }] }, 'a · b · c'],
    ['a one-item batch', { tasks: [{ goal: 'Audit auth', context: 'background' }] }, 'Audit auth'],
    ['a listing', { action: 'list' }, 'list'],
    ['a message to a subagent', { action: 'message', subagent_id: 'sa_1' }, 'message sa_1'],
    ['a control action ignoring its goal', { action: 'stop', subagent_id: 'sa_1', goal: 'ignored' }, 'stop sa_1'],
    ['a multi-line goal', { goal: 'First line\nSecond line' }, 'First line'],
    ['multi-line goals in a batch', { tasks: [{ goal: 'One\nmore' }, { goal: 'Two\nmore' }] }, 'One · Two'],
    ['goals that repr with quotes and escapes', { tasks: [{ goal: "it's" }, { goal: `say "it's"` }] }, `it's · say "it's"`],
    ['a value that only reads like a goal key', { tasks: [{ context: "'goal': 'decoy'", goal: 'real' }] }, 'real'],
    ['a non-string goal', { tasks: [{ goal: 42 }, { goal: 'real' }] }, 'real'],
    ['an empty batch', { tasks: [] }, ''],
    ['its batch over a goal, as the Agent runs it', { goal: 'ignored', tasks: [{ goal: 'real' }] }, 'real'],
    ['its goal beside an empty batch', { tasks: [], goal: 'real' }, 'real'],
    ['a tasks value sent as JSON text', { tasks: '[{"goal": "a"}, {"goal": "b"}]' }, 'a · b'],
    ['JSON text with Unicode escapes', { tasks: String.raw`[{"goal": "caf\u00e9 \ud83d\ude00"}]` }, 'café 😀'],
    ['JSON text cut inside a surrogate pair', { tasks: String.raw`[{"goal": "a\ud83d...` }, 'a�...'],
    ['a literal backslash-u in a goal', { tasks: [{ goal: String.raw`C:\users` }] }, String.raw`C:\users`],
    ['an action in any case', { action: ' LIST ' }, 'list'],
  ])('names a delegate_task row by %s (TAL-1758)', (_, args, target) => {
    expect(toolDisplay('delegate_task', args)).toEqual({ kind: 'delegate', target, focus_path: null })
  })

  it('reads goals from a snapshot-capped tasks value within the target cap (TAL-1758)', () => {
    const g = 'g'.repeat(50)
    const h = 'h'.repeat(50)
    const tasks = [{ goal: g }, { goal: h }, { goal: 'i'.repeat(50) }]
    // The 120-point snapshot cap falls inside the second goal, whether the call is raw or already a stored snapshot.
    const expected = `${g} · ${'h'.repeat(45)}...`
    expect(toolDisplay('delegate_task', { tasks }).target).toBe(expected)
    expect(toolDisplay('delegate_task', { tasks: `[{'goal': '${g}'}, {'goal': '${'h'.repeat(45)}...` }).target).toBe(expected)
    // One capped goal keeps its text; a cut before any goal names nothing.
    expect(toolDisplay('delegate_task', { tasks: [{ goal: 'x'.repeat(300) }] }).target).toBe(`${'x'.repeat(109)}...`)
    expect(toolDisplay('delegate_task', { tasks: [{ context: 'c'.repeat(300), goal: 'late' }] }).target).toBe('')
    // The snapshot cap holds every delegate target below TOOL_TARGET_MAX, by code point.
    expect(toolDisplay('delegate_task', { goal: '😀'.repeat(300) }).target).toBe(`${'😀'.repeat(120)}...`)
  })

  it('names a Talaria tool row by the tool, live and after reload (TAL-2317)', () => {
    expect(toolDisplay('profile_list', {})).toEqual({ kind: 'talaria', target: 'profile_list', focus_path: null })
    // Its own arguments never stand in for the tool's name.
    expect(toolDisplay('session_list', { query: 'auth' })).toEqual({ kind: 'talaria', target: 'session_list', focus_path: null })
    expect(toolDisplay('workspace_add', { path: 'src/app', name: 'App' })).toEqual({ kind: 'talaria', target: 'workspace_add', focus_path: null })
    // Tools with a specific target keep it.
    expect(toolDisplay('deliver', { path: 'report.pdf', title: 'Report' }).target).toBe('report.pdf')
    expect(toolDisplay('terminal_open', { command: 'npm test' }).target).toBe('npm test')
    expect(toolDisplay('show', { kind: 'table' })).toMatchObject({ kind: 'talaria', target: 'show', shows_card: true })
    // A reloaded call the Agent ran through its tool_call bridge classifies as the live one did.
    const bridged = { function: { name: 'tool_call', arguments: JSON.stringify({ calls: [{ name: 'pending_list', arguments: {} }] }) } }
    expect(publicToolFrame({ id: 'c', name: 'pending_list', args: {} }, true)).toMatchObject({ kind: 'talaria', target: 'pending_list' })
    expect(toolDisplay(toolName(bridged), toolArgs(bridged))).toEqual({ kind: 'talaria', target: 'pending_list', focus_path: null })
  })

  it('leaves subagent progress on its own target (TAL-1758)', () => {
    expect(toolDisplay('subagent_progress', { goal: 'Audit auth', tasks: [{ goal: 'a' }], action: 'list' }).target).toBe('')
    expect(toolDisplay('subagent_progress', { task: 'Summarize' }).target).toBe('Summarize')
  })

  it('marks a call whose transcript card the user must see, and no other (TAL-1968)', () => {
    for (const name of ['show', 'propose', 'draft_card']) expect(toolDisplay(name, {}).shows_card).toBe(true)
    for (const name of ['read_file', 'proposal_read', 'decision_review_put', 'showcase']) expect(toolDisplay(name, {})).not.toHaveProperty('shows_card')
    // The live frame carries it from its start.
    expect(publicToolFrame({ id: 'c', name: 'show', args: { kind: 'table' } }, true)).toMatchObject({ shows_card: true })
  })

  it('names a read or write call\'s workspace-relative file as its focus path (TAL-1458)', () => {
    expect(toolDisplay('read_file', { path: 'src/a.ts' }).focus_path).toBe('src/a.ts')
    expect(toolDisplay('write_file', { file_path: './web/b.ts', content: 'x' }).focus_path).toBe('web/b.ts')
    expect(toolDisplay('patch', { file: 'docs/My Notes.md' }).focus_path).toBe('docs/My Notes.md')
    expect(toolDisplay('mcp_filesystem_edit_file', { target: 'c.swift' }).focus_path).toBe('c.swift')
    for (const [name, args] of [
      ['terminal', { command: 'cat src/a.ts', path: 'src/a.ts' }],
      ['search_files', { pattern: 'x', path: 'src' }],
      ['skill_view', { name: 'pdf' }],
      ['read_file', { name: 'notes' }],
      ['read_file', { path: '/etc/hosts' }],
      ['read_file', { path: '~/.ssh/config' }],
      ['read_file', { path: 'C:\\x\\y.ts' }],
      ['read_url', { path: 'https://example.com/a' }],
      ['write_file', { path: '../outside.ts' }],
      ['write_file', { path: 'src/../../outside.ts' }],
      ['write_file', { path: 'two\nlines' }],
      ['write_file', { file: `${'p'.repeat(130)}.ts` }],
      ['write_file', { path: '  ' }],
    ] as const) expect(toolDisplay(name, args).focus_path, `${name} ${JSON.stringify(args)}`).toBeNull()
  })
})

describe('deferred tool bridges (TAL-2316)', () => {
  const bridged = (calls: unknown) => ({ id: 'c', type: 'function', function: { name: 'tool_call', arguments: JSON.stringify({ calls }) } })

  it('names a single-entry tool_call by the call it carries, and leaves a batch or empty bridge wrapped', () => {
    const one = bridged([{ name: 'session_list', arguments: { query: 'deploy' } }])
    expect([toolName(one), toolArgs(one)]).toEqual(['session_list', { query: 'deploy' }])
    expect(toolName(bridged([{ name: 'a', arguments: {} }, { name: 'b', arguments: {} }]))).toBe('tool_call')
    expect(toolName(bridged([]))).toBe('tool_call')
    expect(toolName({ function: { name: 'tool_call', arguments: 'not json' } })).toBe('tool_call')
  })

  it('labels tool_describe by the names it reads and tool_search by its first query, live and persisted alike', () => {
    const names = ['profile_list', 'session_list']
    expect(toolDisplay('tool_describe', { names })).toMatchObject({ kind: 'read', target: 'profile_list, session_list' })
    expect(toolDisplay('tool_describe', { names: 'profile_list' })).toMatchObject({ kind: 'read', target: 'profile_list' })
    expect(toolDisplay('tool_search', { queries: ['', 'session tools'] })).toMatchObject({ kind: 'search', target: 'session tools' })
    expect(publicToolFrame({ name: 'tool_describe', tid: 'd', args: { names: "['profile_list', 'session_list']" } }, true)).toMatchObject({ kind: 'read', target: 'profile_list, session_list' })
  })
})

describe('focus path of an absolute path inside the workspace (TAL-1537)', () => {
  const ws = '/w/repo'

  it('names an absolute or home path inside the workspace by its workspace-relative remainder', () => {
    expect(toolDisplay('read_file', { path: '/w/repo/README.md' }, ws).focus_path).toBe('README.md')
    expect(toolDisplay('write_file', { path: '/w/repo/src/a.ts', content: 'x' }, ws).focus_path).toBe('src/a.ts')
    expect(toolDisplay('read_file', { path: '/w/repo/./src/../README.md' }, ws).focus_path).toBe('README.md')
    expect(toolDisplay('read_file', { path: '/w/repo/README.md' }, `${ws}/`).focus_path).toBe('README.md')
    vi.mocked(homedir).mockReturnValueOnce('/w')
    expect(toolDisplay('read_file', { path: '~/repo/x.md' }, ws).focus_path).toBe('x.md')
    expect(toolDisplay('read_file', { path: 'src/a.ts' }, ws).focus_path).toBe('src/a.ts')
  })

  it('is null for the root, a path outside it, a name-prefix sibling, a call without a workspace, and non-file calls', () => {
    for (const path of ['/w/repo', '/w/repo/', '/w/repo2/a.md', '/etc/passwd', '/w/repo/../x', '/w/repo/two\nlines']) {
      expect(toolDisplay('read_file', { path }, ws).focus_path, path).toBeNull()
    }
    expect(toolDisplay('write_file', { file: `/w/repo/${'p'.repeat(130)}.ts` }, ws).focus_path).toBeNull()
    expect(toolDisplay('read_file', { path: '/w/repo/README.md' }).focus_path).toBeNull()
    expect(toolDisplay('read_file', { path: '/w/repo/README.md' }, null).focus_path).toBeNull()
    expect(toolDisplay('terminal', { command: 'cat /w/repo/a.ts', path: '/w/repo/a.ts' }, ws).focus_path).toBeNull()
    expect(toolDisplay('search_files', { pattern: 'x', path: '/w/repo/src' }, ws).focus_path).toBeNull()
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
    expect(toolEditDiff('patch', JSON.stringify({ success: true, diff: small }))).toEqual({ added: 2, removed: 1, diff: small.trimEnd(), truncated: false, hunks: diffHunks(small) })
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
    // TAL-604: its hunks are the shown diff's.
    expect(toolEditDiff('edit_file', { diff: `@@ -1 +1 @@\n-a\n+${'x'.repeat(100_000)}` })).toEqual({ added: 1, removed: 1, diff: '@@ -1 +1 @@\n-a', truncated: true, hunks: diffHunks('@@ -1 +1 @@\n-a') })
    expect(edit.hunks.map((hunk) => hunk.lines.length)).toEqual([4, EDIT_DIFF_MAX_LINES - 10])
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
    // TAL-604: a change decided before hunks shipped gets them from its diff.
    expect(decidedEditDiff({ ...decided, hunks: undefined })).toEqual(decided)
  })

  it('reads a write_file or skill edit from the diff the Agent persisted in its row\'s display_metadata (TAL-909)', () => {
    const write = '--- a/notes.txt\n+++ b/notes.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n'
    const skill = '--- a/skills/demo/SKILL.md\n+++ b/skills/demo/SKILL.md\n@@ -0,0 +1,2 @@\n+# Demo\n+Use it.\n'
    const [assistant] = withToolCallOutcomes([
      { role: 'assistant', content: '', tool_calls: [{ id: 'w', type: 'function', function: { name: 'write_file', arguments: '{}' } }, { id: 's', type: 'function', function: { name: 'skill_manage', arguments: '{}' } }, { id: 'p', type: 'function', function: { name: 'patch', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'w', content: '{"bytes_written": 10}', display_metadata: { diff: write } },
      { role: 'tool', tool_call_id: 's', content: '{"success": true}', display_metadata: { diff: skill } },
      // A result's own diff wins over the metadata.
      { role: 'tool', tool_call_id: 'p', content: patch, display_metadata: { diff: write } },
    ], [], null) as unknown as [{ tool_calls: Record<string, unknown>[] }]
    expect(assistant.tool_calls.map((call) => call.edit_diff)).toEqual([
      { added: 1, removed: 1, diff: write.trimEnd(), truncated: false, hunks: diffHunks(write) },
      { added: 2, removed: 0, diff: skill.trimEnd(), truncated: false, hunks: diffHunks(skill) },
      toolEditDiff('patch', patch),
    ])
    expect(toolEditDiff('write_file', '{}', { diff: '' })).toBeUndefined()
    expect(toolEditDiff('write_file', '{}', { diff: 3 })).toBeUndefined()
  })
})

describe('MCP tool progress', () => {
  it.each([
    [{ progress: 21, total: 50 }, 42], [{ percent: 80, progress: 1, total: 2 }, 80],
    [{ percent: -5 }, 0], [{ percent: 200 }, 100], [{ progress: 10, total: 0 }, null],
    [{ percent: NaN, progress: 1, total: 4 }, 25], [{ percent: Infinity }, null],
    [{ progress: Infinity, total: 3 }, null], [{ progress: 0, total: 100 }, 0],
    [{ progress: 1, total: 3 }, 33], [{ percent: '42' }, null],
  ])('normalizes %j to %s', (raw, percent) => {
    expect(toolProgress({ ...raw, message: ' indexing files ' })).toEqual({ percent, message: 'indexing files' })
  })
  it('bounds messages and supports message-only or percentage-only updates', () => {
    expect(toolProgress({ message: 'x'.repeat(2000) }).message).toHaveLength(1000)
    expect(toolProgress({ message: 42 })).toEqual({ percent: null, message: null })
    expect(toolProgress({ percent: 0, message: '  ' })).toEqual({ percent: 0, message: null })
  })
})

describe('Agent tool presentation table (TAL-2322)', () => {
  // A terminal result that also carries a readable text key: the text key wins under the generic parser.
  const ran = { output: '', result: 'partial', error: 'Command timed out', exit_code: 124 }
  const edit = { success: true, diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n' }

  it('shows a terminal tool result as its terminal sections, and an unlisted tool by the generic parser', () => {
    expect(toolOutcome(JSON.stringify(ran), 'process_manage').result_view).toEqual({ error: 'Command timed out', exit_code: 124 })
    expect(toolResultView(JSON.stringify(ran), Infinity, 'terminal')).toEqual({ error: 'Command timed out', exit_code: 124 })
    expect(toolOutcome(JSON.stringify(ran), 'mcp_ops_run').result_view).toEqual({ text: 'partial' })
    // The whole-result read names the call from its assistant row, so it shows as the capped view did.
    const messages = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'terminal', input: {} }] }, { role: 'tool', tool_call_id: 'c1', content: JSON.stringify(ran) }]
    expect(fullToolResult(messages, 'c1')?.result_view).toEqual({ error: 'Command timed out', exit_code: 124 })
  })

  it('gives every listed tool the kind its name tokens gave before the table', () => {
    for (const [name, { kind }] of Object.entries(TOOL_PRESENTATIONS)) expect([name, kind]).toEqual([name, tokenToolKind(name)])
  })

  it('takes a file edit only from a diff tool, and from an unlisted write tool by its name tokens', () => {
    expect(toolEditDiff('write_file', edit)).toMatchObject({ added: 1, removed: 1 })
    expect(toolEditDiff('xai_video_edit', edit)).toBeUndefined()
    expect(toolEditDiff('mcp_fs_edit_file', edit)).toMatchObject({ added: 1, removed: 1 })
  })
})

describe('read_file and search_files sections (TAL-2323)', () => {
  const read = (result: Record<string, unknown>, args: unknown = { path: 'src/app.ts' }) => toolOutcome(JSON.stringify(result), 'read_file', false, args).result_view
  const search = (result: Record<string, unknown>) => toolOutcome(JSON.stringify(result), 'search_files').result_view

  it('shows a read as the numbered lines of the file its call named, and where a cut-short read stopped', () => {
    const view = read({ content: '12|const a = 1\n13|\n14|  return a', total_lines: 40, file_size: 300, truncated: true, hint: 'Use offset=15 to continue' })
    expect(view.file_excerpt).toEqual({ path: 'src/app.ts', language: 'ts', start_line: 12, lines: [{ n: 12, text: 'const a = 1' }, { n: 13, text: '' }, { n: 14, text: '  return a' }], total_lines: 40, truncated: true, next_offset: 15 })
    // Older clients keep the Agent's text; the key/value rows give way to the section.
    expect(view.text).toBe('12|const a = 1\n13|\n14|  return a')
    expect(view.fields).toBeUndefined()
    // A byte-budget stop names its own continuation; an extracted document reads like any file.
    expect(read({ content: '1|a', total_lines: 9, truncated: true, truncated_by: 'bytes', next_offset: 2 }).file_excerpt?.next_offset).toBe(2)
    expect(read({ content: '1|Title\n2|Body', total_lines: 2, truncated: false, extracted_document: true }, { path: 'doc.docx' }).file_excerpt).toEqual({ path: 'doc.docx', language: null, start_line: 1, lines: [{ n: 1, text: 'Title' }, { n: 2, text: 'Body' }], total_lines: 2, truncated: false })
  })

  it('shows a repeat read, a missing file and a blocked read as one line, never JSON', () => {
    expect(read({ status: 'unchanged', message: 'File unchanged since last read…', path: 'src/app.ts', dedup: true, content_returned: false })).toEqual({ text: 'Unchanged since the last read' })
    expect(read({ error: 'File not found: src/ap.ts', not_found: true, similar_files: ['src/app.ts', 'src/api.ts'] })).toEqual({ error: 'File not found: src/ap.ts\nSimilar files: src/app.ts, src/api.ts' })
    expect(read({ error: 'BLOCKED: You have read this exact file region 4 times in a row.', path: 'src/app.ts', already_read: 4, guardrail_refusal: true })).toEqual({ error: 'BLOCKED: You have read this exact file region 4 times in a row.' })
  })

  it('groups matches by file from both match encodings, a files-only list and a count search', () => {
    const grouped = { total: 6, truncated: true, files: [{ path: 'src/a.ts', matches: [{ line: 3, text: 'foo()' }, { line: 9, text: '  foo(1)' }] }, { path: 'src/b.ts', matches: [{ line: 1, text: 'foo' }] }] }
    expect(search({ total_count: 6, matches: [{ path: 'src/a.ts', line: 3, content: 'foo()' }, { path: 'src/a.ts', line: 9, content: '  foo(1)' }, { path: 'src/b.ts', line: 1, content: 'foo' }], truncated: true }).matches).toEqual(grouped)
    expect(search({ total_count: 6, matches_format: 'path-grouped', matches_text: 'src/a.ts\n  3: foo()\n  9:   foo(1)\nsrc/b.ts\n  1: foo', truncated: true, total_count_is_lower_bound: true }).matches).toEqual(grouped)
    expect(search({ total_count: 2, files: ['src/a.ts', 'src/b.ts'] }).matches).toEqual({ total: 2, truncated: false, files: [{ path: 'src/a.ts', matches: [] }, { path: 'src/b.ts', matches: [] }] })
    expect(search({ total_count: 5, counts: { 'src/a.ts': 3, 'src/b.ts': 2 } }).matches).toEqual({ total: 5, truncated: false, files: [{ path: 'src/a.ts', count: 3, matches: [] }, { path: 'src/b.ts', count: 2, matches: [] }] })
    expect(search({ total_count: 0, error: 'Path not found: nope' })).toEqual({ error: 'Path not found: nope' })
    expect(search({ error: 'BLOCKED: You have run this exact search 4 times in a row.', guardrail_refusal: true })).toEqual({ error: 'BLOCKED: You have run this exact search 4 times in a row.' })
  })

  it('caps a long excerpt to whole lines and offers the whole result, which the whole-result read returns', () => {
    const content = Array.from({ length: 200 }, (_, i) => `${String(i + 1)}|${'x'.repeat(40)}`).join('\n')
    const outcome = toolOutcome(JSON.stringify({ content, total_lines: 200, truncated: false }), 'read_file', false, { path: 'big.txt' })
    expect(outcome.capped).toBe(true)
    expect(outcome.result_view.file_excerpt?.lines.length).toBeLessThan(200)
    const messages = [{ role: 'assistant', tool_calls: [{ id: 'r1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'big.txt' }) } }] }, { role: 'tool', tool_call_id: 'r1', content: JSON.stringify({ content, total_lines: 200, truncated: false }) }]
    expect(fullToolResult(messages, 'r1')?.result_view.file_excerpt).toMatchObject({ path: 'big.txt', lines: expect.arrayContaining([{ n: 200, text: 'x'.repeat(40) }]) as unknown })
    // A persisted call's excerpt names the file from its own arguments.
    const [assistant] = withToolCallOutcomes(messages, [], null) as { tool_calls: { result_view: ToolResultView }[] }[]
    expect(assistant!.tool_calls[0]!.result_view.file_excerpt?.path).toBe('big.txt')
  })

  it('ships paths redacted, each file inside the workspace with its focus path, and an excerpt redacted as the text it came from', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabc\nqwertyuiopasdf\n-----END RSA PRIVATE KEY-----'
    const content = ['4|key:', ...pem.split('\n').map((line, i) => `${String(i + 5)}|${line}`), '9|done'].join('\n')
    const excerpt = toolOutcome(JSON.stringify({ content, total_lines: 9, truncated: false }), 'read_file', false, { path: '/repo/src/key.ts' }).result_view
    const frame = publicToolFrame({ name: 'read_file', args: { path: '/repo/src/key.ts' }, result_view: excerpt }, true, '/repo')
    const shown = (frame.result_view as { file_excerpt: { focus_path?: string; lines: { n: number; text: string }[] } }).file_excerpt
    expect(shown.focus_path).toBe('src/key.ts')
    expect(JSON.stringify(shown.lines)).not.toMatch(/MIIEow|qwertyuiop/)
    expect(shown.lines.at(0)).toEqual({ n: 4, text: 'key:' })
    expect(shown.lines.at(-1)).toEqual({ n: 9, text: 'done' })
    // A search's matches over a key are masked together, in both match encodings.
    const keyLines = pem.split('\n').map((text, i) => ({ path: 'src/key.ts', line: i + 5, content: text }))
    const dense = `src/key.ts\n${keyLines.map((m) => `  ${String(m.line)}: ${m.content}`).join('\n')}`
    for (const result of [{ total_count: 4, matches: keyLines }, { total_count: 4, matches_format: 'path-grouped', matches_text: dense }]) {
      const found = publicToolFrame({ name: 'search_files', args: { pattern: 'KEY' }, result_view: search(result) }, true, '/repo').result_view as { matches: { files: { matches: { line: number; text: string }[] }[] } }
      expect(JSON.stringify(found.matches)).not.toMatch(/MIIEow|qwertyuiop/)
      expect(found.matches.files[0]!.matches[0]!.line).toBe(5)
    }
    const matches = search({ total_count: 2, matches: [{ path: '/repo/src/a.ts', line: 3, content: 'foo' }, { path: '/elsewhere/b.ts', line: 1, content: 'foo' }] })
    const located = publicToolFrame({ name: 'search_files', args: { pattern: 'foo' }, result_view: matches }, true, '/repo').result_view as { matches: { files: { path: string; focus_path?: string }[] } }
    expect(located.matches.files).toEqual([expect.objectContaining({ path: '/repo/src/a.ts', focus_path: 'src/a.ts' }), expect.not.objectContaining({ focus_path: expect.anything() as unknown })])
  })
})

describe('web_search, x_search and web_extract sections (TAL-2324)', () => {
  const view = (name: string, result: Record<string, unknown>) => toolOutcome(JSON.stringify(result), name).result_view

  it('lists a search\'s results as title, domain and snippet, ignoring a backend\'s extra keys', () => {
    const shown = view('web_search', { success: true, data: { web: [
      { title: 'Hermes Agent', url: 'https://www.example.com/hermes', description: 'The agent.', position: 1 },
      // A Firecrawl-style row: extra keys, no description.
      { url: 'https://docs.example.org/a?b=1', title: '', markdown: '# A', metadata: { sourceURL: 'x' }, position: 2 },
      { title: 'No URL', description: 'dropped', position: 3 },
      { title: 'Script', url: 'javascript:alert(1)', description: 'dropped', position: 4 },
    ], served_by: 'brave' } })
    expect(shown.links).toEqual({ items: [
      { title: 'Hermes Agent', url: 'https://www.example.com/hermes', domain: 'example.com', snippet: 'The agent.' },
      { title: 'https://docs.example.org/a?b=1', url: 'https://docs.example.org/a?b=1', domain: 'docs.example.org' },
    ] })
    expect(shown.fields).toBeUndefined()
    expect(shown.text).toContain('Hermes Agent')
    expect(view('web_search', { success: true, data: { web: [] } }).links).toEqual({ items: [] })
    expect(view('web_search', { success: false, error: 'No web search provider configured.' }).links).toBeUndefined()
  })

  it('shows an X search\'s answer above its titled inline citations, then the bare citations they did not name', () => {
    const answer = { success: true, query: 'q', answer: '**Yes.** See the thread.', degraded: false, degraded_reason: null }
    expect(view('x_search', { ...answer, citations: ['https://x.com/a/status/1', 'https://x.com/b/status/2'], inline_citations: [
      { url: 'https://x.com/b/status/2', title: 'Post by b', start_index: 0, end_index: 4 }, { url: 'https://x.com/b/status/2', title: 'again', start_index: 5, end_index: 8 },
    ] }).links).toEqual({ answer: '**Yes.** See the thread.', items: [
      { title: 'Post by b', url: 'https://x.com/b/status/2', domain: 'x.com' },
      { title: 'https://x.com/a/status/1', url: 'https://x.com/a/status/1', domain: 'x.com' },
    ] })
    expect(view('x_search', { ...answer, citations: ['https://x.com/a/status/1', 'data:text/html,x'], inline_citations: [] }).links?.items.map((item) => item.url)).toEqual(['https://x.com/a/status/1'])
  })

  it('shows each extracted page as title, domain and an excerpt without the Agent\'s cut, and a failed page as its error', () => {
    const long = `# Title\n\n${'word '.repeat(300)}`
    const footer = '\n\n[... middle omitted — see footer ...]\n\ntail\n\n──────── [TRUNCATED] ────────\nShowing 9 chars (head) + 4 chars (tail) of 999 total clean characters.\nFull text saved to: /cache/page.md'
    const pages = view('web_extract', { results: [
      { url: 'https://example.com/long', title: 'Long', content: long, error: null },
      { url: 'https://example.com/cut', title: 'Cut', content: `Head text.${footer}`, error: null },
      { url: 'https://blocked.example/', title: '', content: '', error: 'Blocked by website policy: blocked.example', blocked_by_policy: { host: 'blocked.example', rule: 'blocked.example', source: 'config' } },
      { url: 'https://example.com/bin', title: 'Bin', content: '', error: 'URL returned binary content (sqlite), not a page.' },
    ] }).pages
    expect(pages?.[0]).toMatchObject({ url: 'https://example.com/long', domain: 'example.com', title: 'Long' })
    expect(pages?.[0]?.excerpt.length).toBeLessThanOrEqual(601)
    expect(pages?.[0]?.excerpt).toMatch(/^# Title\n\nword word .* word…$/s)
    expect(pages?.[1]).toEqual({ url: 'https://example.com/cut', domain: 'example.com', title: 'Cut', excerpt: 'Head text.' })
    expect(pages?.[2]).toEqual({ url: 'https://blocked.example/', domain: 'blocked.example', title: 'https://blocked.example/', excerpt: '', error: 'Blocked by website policy: blocked.example' })
    expect(pages?.[3]?.error).toBe('URL returned binary content (sqlite), not a page.')
    // A URL the Agent refused as invalid names its row as text, with no link.
    expect(view('web_extract', { results: [{ url: 'file:///etc/passwd', title: '', content: '', error: 'Invalid URL' }] }).pages).toEqual([{ url: '', domain: '', title: 'file:///etc/passwd', excerpt: '', error: 'Invalid URL' }])
    expect(view('web_extract', { success: false, error: 'Content was inaccessible or not found' })).toEqual({ error: 'Content was inaccessible or not found' })
  })

  it('ships links and pages redacted, their domains too', () => {
    const token = `ghp_${'abcdef0123'.repeat(3)}abcdef`
    const url = `https://${token}.example.com/page?access_token=${token}`
    const search = view('web_search', { success: true, data: { web: [{ title: `Key ${token}`, url, description: `uses ${token}` }] } })
    const extract = view('web_extract', { results: [{ url, title: 'Page', content: `token=${token}`, error: null }] })
    for (const [name, resultView] of [['web_search', search], ['web_extract', extract]] as const) {
      const shown = JSON.stringify(publicToolFrame({ name, args: {}, result_view: resultView }, true, '/repo').result_view)
      expect(shown).toContain('example.com')
      expect(shown).not.toContain(token)
    }
  })
})
