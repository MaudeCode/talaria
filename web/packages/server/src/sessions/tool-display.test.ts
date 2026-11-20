import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { decidedResultView, toolOutcome, toolResultSnippet, toolResultView, withToolCallOutcomes } from './merge.js'
import { diffHunks } from '../text/diff.js'
import { appTitle, decidedEditDiff, EDIT_DIFF_MAX_LINES, rememberConnectorLogos, tokenToolKind, toolArgs, toolDisplay, toolEditDiff, toolKind, toolName, toolProgress } from './tool-display.js'
import { stubDisplaySettings } from './display-settings.js'
import { fullToolResult } from './anchor.js'
import { approvalTool, publicToolFrame } from '../redact.js'
import { vouchedRemoteImage } from '../http/remote-image.js'
import { LOGO_DATA_URL, logoFetch } from '../test/logo-host.js'
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
    ['read_file', 'read'], ['read_url', 'read'], ['vision_analyze', 'image_analysis'], ['video_analyze', 'video_analysis'],
    ['list_directory', 'list'], ['todo', 'list'], ['todo_list', 'list'],
    ['web_search', 'web'], ['web_extract', 'web'], ['browser_navigate', 'web'],
    ['search_files', 'search'], ['grep', 'search'], ['rg', 'search'], ['ripgrep', 'search'], ['glob', 'search'],
    ['write_file', 'write'], ['patch', 'write'], ['mcp_filesystem_edit_file', 'write'],
    ['HTTPFetch', 'web'], ['URLRead', 'read'], ['readFile', 'read'], ['webSearch', 'web'], ['shellCommand', 'shell'], ['mergePullRequest', 'unknown'],
    ['merge_pull_request', 'unknown'], ['image_generate', 'image'], ['text_to_speech', 'audio'], ['video_generate', 'video'], ['', 'unknown'], [undefined, 'unknown'],
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

  it('shows a browser_exec step as browser code (TAL-2328) labeled by its session, else its code\'s first non-empty line (TAL-1805)', () => {
    expect(toolDisplay('browser_exec', { code: 'goto("https://x")', session: 'checkout' })).toEqual({ kind: 'browser', target: 'checkout', focus_path: null, verb: 'run' })
    expect(toolDisplay('browser_exec', { code: '\n\n  goto("https://x")\n  print(title())', session: ' ' })).toEqual({ kind: 'browser', target: 'goto("https://x")', focus_path: null, verb: 'run' })
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

describe('hidden tool lookups (TAL-2331)', () => {
  const lookup = { name: 'tool_describe', id: 'd', args: { names: ['profile_list'] } }

  // Session detail (calls and scene rows) and the setting's round trip: sessions.test.ts, on the shared fixture.
  it('hides a lookup live and persisted while the setting is off, never a failed lookup or another call', () => {
    stubDisplaySettings({})
    expect(publicToolFrame(lookup, true).hidden).toBe(true)
    expect(publicToolFrame({ ...lookup, is_error: true }, true)).not.toHaveProperty('hidden')
    expect(publicToolFrame({ name: 'read_file', id: 'r', args: { path: 'a' } }, true)).not.toHaveProperty('hidden')
    stubDisplaySettings({ show_tool_lookups: true })
    expect(publicToolFrame(lookup, true)).not.toHaveProperty('hidden')
    stubDisplaySettings({})
  })

  // Every other switch, live and after reload: sessions.test.ts, sse-routes.test.ts, chat.test.ts and relay.test.ts.
  it('marks the call an approval holds unnamed while the Live Activity switch is off (TAL-2341)', () => {
    const held = { name: 'terminal', id: 't', args: { command: 'npm test' } }
    expect(approvalTool(held, true, null)).not.toHaveProperty('activity_unnamed')
    stubDisplaySettings({ live_activity_current_tool: false })
    expect(approvalTool(held, true, null)).toMatchObject({ kind: 'shell', target: 'npm test', activity_unnamed: true })
    stubDisplaySettings({})
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
    expect(toolOutcome(JSON.stringify(ran), 'process_manage').result_view).toEqual({ error: 'Command timed out', exit_code: 124, outcome: { key: 'exit', tone: 'error', count: 124 } })
    expect(toolResultView(JSON.stringify(ran), Infinity, 'terminal')).toEqual({ error: 'Command timed out', exit_code: 124 })
    expect(toolOutcome(JSON.stringify(ran), 'mcp_ops_run').result_view).toEqual({ text: 'partial', outcome: { key: 'failed', tone: 'error', value: 'Command timed out' } })
    // The whole-result read names the call from its assistant row, so it shows as the capped view did.
    const messages = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'terminal', input: {} }] }, { role: 'tool', tool_call_id: 'c1', content: JSON.stringify(ran) }]
    expect(fullToolResult(messages, 'c1')?.result_view).toEqual({ error: 'Command timed out', exit_code: 124 })
  })

  it('gives every listed tool the kind its name tokens gave before the table, but a media tool (TAL-2325), a session, schedule, connection or question tool (TAL-2326) a Kanban tool (TAL-2327) or a browser or computer tool (TAL-2328) its own', () => {
    const own = new Set(['session', 'schedule', 'connection', 'question', 'kanban', 'browser', 'computer'])
    for (const [name, { kind, presentation }] of Object.entries(TOOL_PRESENTATIONS)) if (presentation !== 'media' && presentation !== 'analysis' && !own.has(kind)) expect([name, kind]).toEqual([name, tokenToolKind(name)])
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
    expect(read({ error: 'File not found: src/ap.ts', not_found: true, similar_files: ['src/app.ts', 'src/api.ts'] })).toEqual({ error: 'File not found: src/ap.ts\nSimilar files: src/app.ts, src/api.ts', outcome: { key: 'failed', tone: 'error', value: 'File not found: src/ap.ts' } })
    expect(read({ error: 'BLOCKED: You have read this exact file region 4 times in a row.', path: 'src/app.ts', already_read: 4, guardrail_refusal: true })).toEqual({ error: 'BLOCKED: You have read this exact file region 4 times in a row.', outcome: { key: 'failed', tone: 'error', value: 'BLOCKED: You have read this exact file region 4 times in a row.' } })
  })

  it('groups matches by file from both match encodings, a files-only list and a count search', () => {
    const grouped = { total: 6, truncated: true, files: [{ path: 'src/a.ts', matches: [{ line: 3, text: 'foo()' }, { line: 9, text: '  foo(1)' }] }, { path: 'src/b.ts', matches: [{ line: 1, text: 'foo' }] }] }
    expect(search({ total_count: 6, matches: [{ path: 'src/a.ts', line: 3, content: 'foo()' }, { path: 'src/a.ts', line: 9, content: '  foo(1)' }, { path: 'src/b.ts', line: 1, content: 'foo' }], truncated: true }).matches).toEqual(grouped)
    expect(search({ total_count: 6, matches_format: 'path-grouped', matches_text: 'src/a.ts\n  3: foo()\n  9:   foo(1)\nsrc/b.ts\n  1: foo', truncated: true, total_count_is_lower_bound: true }).matches).toEqual(grouped)
    expect(search({ total_count: 2, files: ['src/a.ts', 'src/b.ts'] }).matches).toEqual({ total: 2, truncated: false, files: [{ path: 'src/a.ts', matches: [] }, { path: 'src/b.ts', matches: [] }] })
    expect(search({ total_count: 5, counts: { 'src/a.ts': 3, 'src/b.ts': 2 } }).matches).toEqual({ total: 5, truncated: false, files: [{ path: 'src/a.ts', count: 3, matches: [] }, { path: 'src/b.ts', count: 2, matches: [] }] })
    expect(search({ total_count: 0, error: 'Path not found: nope' })).toEqual({ error: 'Path not found: nope', outcome: { key: 'failed', tone: 'error', value: 'Path not found: nope' } })
    expect(search({ error: 'BLOCKED: You have run this exact search 4 times in a row.', guardrail_refusal: true })).toEqual({ error: 'BLOCKED: You have run this exact search 4 times in a row.', outcome: { key: 'failed', tone: 'error', value: 'BLOCKED: You have run this exact search 4 times in a row.' } })
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
    expect(view('web_extract', { success: false, error: 'Content was inaccessible or not found' })).toEqual({ error: 'Content was inaccessible or not found', outcome: { key: 'failed', tone: 'error', value: 'Content was inaccessible or not found' } })
  })

  it('offers a cut page whole, which the whole-result read returns', () => {
    const content = `# Title\n\n${'word '.repeat(300)}`
    const result = JSON.stringify({ results: [{ url: 'https://example.com/long', title: 'Long', content, error: null }] })
    const outcome = toolOutcome(result, 'web_extract')
    expect(outcome.capped).toBe(true)
    expect(outcome.result_view.pages?.[0]?.excerpt.length).toBeLessThanOrEqual(600)
    const messages = [{ role: 'assistant', tool_calls: [{ id: 'e1', type: 'function', function: { name: 'web_extract', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'e1', content: result }]
    expect(fullToolResult(messages, 'e1')?.result_view.pages?.[0]?.excerpt).toBe(content)
    // A short page shows whole, with nothing more to offer.
    expect(toolOutcome(JSON.stringify({ results: [{ url: 'https://example.com/', title: 'Short', content: 'All of it.', error: null }] }), 'web_extract').capped).toBe(false)
  })

  it('cuts an oversized row\'s text to the budget and keeps its URL whole', () => {
    const url = 'https://example.com/a?b=1'
    const outcome = toolOutcome(JSON.stringify({ success: true, data: { web: [{ title: 't'.repeat(1_000_000), url, description: 'd'.repeat(10_000) }, { title: 'Next', url: 'https://example.com/next', description: '' }] } }), 'web_search')
    const items = outcome.result_view.links!.items
    expect(outcome.capped).toBe(true)
    expect(items).toHaveLength(1)
    expect(items[0]!.url).toBe(url)
    expect(JSON.stringify(items).length).toBeLessThan(4200)
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

describe('media and analysis sections (TAL-2325)', () => {
  const view = (name: string, result: unknown) => toolOutcome(typeof result === 'string' ? result : JSON.stringify(result), name).result_view
  const local = (path: string) => `./api/media?${new URLSearchParams({ path }).toString()}`

  it('maps each media tool to its kind', () => {
    expect(Object.fromEntries(['image_generate', 'text_to_speech', 'video_generate', 'xai_video_edit', 'xai_video_extend', 'vision_analyze', 'video_analyze'].map((name) => [name, toolKind(name)]))).toEqual({
      image_generate: 'image', text_to_speech: 'audio', video_generate: 'video', xai_video_edit: 'video', xai_video_extend: 'video', vision_analyze: 'image_analysis', video_analyze: 'video_analysis',
    })
    // A media call reads as its kind's phrase, and its media stays out of a folded run.
    expect(toolDisplay('image_generate', { prompt: 'a cat', aspect_ratio: 'square' })).toEqual({ kind: 'image', target: '', focus_path: null, shows_card: true })
    expect(toolDisplay('vision_analyze', { image_url: '/tmp/a.png', question: 'what?' })).toEqual({ kind: 'image_analysis', target: '', focus_path: null })
  })

  it('shows a remote image, a local one and its additional images, in order and once each', () => {
    expect(view('image_generate', { success: true, image: 'https://cdn.example/out/cat.png', model: 'm', prompt: 'a cat', provider: 'fal' }).media).toEqual([
      { url: 'https://cdn.example/out/cat.png', name: 'cat.png', mime: 'image/png', kind: 'image' },
    ])
    const shown = view('image_generate', { success: true, image: '/srv/hermes/cache/generated/images/a.png', additional_images: ['/srv/hermes/cache/generated/images/b.webp', { url: 'https://cdn.example/c.jpg' }, '/srv/hermes/cache/generated/images/a.png', 'data:image/png;base64,AAAA'] })
    expect(shown.media).toEqual([
      { url: local('/srv/hermes/cache/generated/images/a.png'), name: 'a.png', mime: 'image/png', kind: 'image' },
      { url: local('/srv/hermes/cache/generated/images/b.webp'), name: 'b.webp', mime: 'image/webp', kind: 'image' },
      { url: 'https://cdn.example/c.jpg', name: 'c.jpg', mime: 'image/jpeg', kind: 'image' },
    ])
    // The call's details keep its rows (prompt, model), under the media shown above them.
    expect(shown.fields?.map((field) => field.key)).toEqual(['success', 'image', 'additional_images'])
  })

  it('shows speech files and a video, its local file before its public URL', () => {
    expect(view('text_to_speech', { success: true, file_path: '/srv/out/tts_1.mp3', file_paths: ['/srv/out/tts_1.mp3', '/srv/out/tts_2.ogg'], media_tag: 'MEDIA:/srv/out/tts_1.mp3', provider: 'edge', voice_compatible: false }).media).toEqual([
      { url: local('/srv/out/tts_1.mp3'), name: 'tts_1.mp3', mime: 'audio/mpeg', kind: 'audio' },
      { url: local('/srv/out/tts_2.ogg'), name: 'tts_2.ogg', mime: 'audio/ogg', kind: 'audio' },
    ])
    expect(view('video_generate', { success: true, video: 'https://cdn.example/v/clip.mp4', model: 'm', prompt: 'p', duration: 5, aspect_ratio: '16:9', provider: 'xai' }).media).toEqual([{ url: 'https://cdn.example/v/clip.mp4', name: 'clip.mp4', mime: 'video/mp4', kind: 'video' }])
    expect(view('xai_video_edit', { success: true, video: '/srv/out/edit.mp4', public_url: 'https://cdn.example/edit.mp4' }).media?.map((item) => item.url)).toEqual([local('/srv/out/edit.mp4')])
    expect(view('xai_video_extend', { success: true, video: '', public_url: 'https://cdn.example/ext.mp4' }).media?.map((item) => item.url)).toEqual(['https://cdn.example/ext.mp4'])
  })

  it('shows a failed media call as its error on one line', () => {
    const outcome = toolOutcome(JSON.stringify({ success: false, image: null, error: 'FAL_KEY is not set', error_type: 'auth_required' }), 'image_generate')
    expect(outcome.is_error).toBe(true)
    expect(outcome.result_view).toEqual({ error: 'FAL_KEY is not set', outcome: { key: 'failed', tone: 'error', value: 'FAL_KEY is not set' } })
    expect(view('text_to_speech', { success: false, error: 'No TTS provider' })).toEqual({ error: 'No TTS provider', outcome: { key: 'failed', tone: 'error', value: 'No TTS provider' } })
  })

  it('shows an analysis as Markdown, and a multimodal result as its summary without image data', () => {
    expect(view('vision_analyze', { success: true, analysis: '**A cat** on a sofa.' }).analysis).toBe('**A cat** on a sofa.')
    expect(view('video_analyze', { success: false, error: 'Error analyzing video: x', analysis: 'The video could not be analyzed.' })).toMatchObject({ analysis: 'The video could not be analyzed.', error: 'Error analyzing video: x' })
    const base64 = `data:image/png;base64,${'iVBORw0KGgo'.repeat(400)}`
    const multimodal = { _multimodal: true, content: [{ type: 'text', text: 'Image loaded into your context.' }, { type: 'image_url', image_url: { url: base64 } }], text_summary: 'Image attached natively for the main model (3.2 KB).', meta: { image_url: '/tmp/a.png', size_bytes: 3300, native_vision: true } }
    // Live, the sidecar bounds the envelope (its content becomes capped JSON text); persisted, it may be the dict itself.
    for (const raw of [multimodal, { ...multimodal, content: JSON.stringify(multimodal.content).slice(0, 4000) }, JSON.stringify(multimodal)]) {
      const outcome = toolOutcome(raw, 'vision_analyze')
      expect(outcome.result_view).toEqual({ text: 'Image attached natively for the main model (3.2 KB).', analysis: 'Image attached natively for the main model (3.2 KB).' })
      expect(JSON.stringify(outcome)).not.toContain('base64')
    }
    expect(view('vision_analyze', { success: true, analysis: `See ${base64} here.` }).analysis).toBe('See  here.')
  })

  it('keeps media and analysis in a stored view, and joins the session id to a local media URL only', () => {
    const media = [{ url: local('/srv/out/a.png'), name: 'a.png', mime: 'image/png', kind: 'image' as const }, { url: 'https://cdn.example/b.png', name: 'b.png', mime: 'image/png', kind: 'image' as const }]
    expect(decidedResultView({ media, analysis: 'x'.repeat(5000) })).toEqual({ media, analysis: toolResultSnippet('x'.repeat(5000)) })
    const frame = publicToolFrame({ name: 'image_generate', args: {}, result_view: { media } }, true, null, 'sid-1')
    // TAL-2199: a remote image loads through the server's relay, which serves only what it vouched for.
    const relayed = (frame.result_view as ToolResultView).media?.map((item) => item.url)
    expect(relayed?.[0]).toBe(`./api/media?${new URLSearchParams({ path: '/srv/out/a.png', session_id: 'sid-1' }).toString()}`)
    expect(vouchedRemoteImage(new URLSearchParams(relayed?.[1]?.split('?')[1]).get('id') ?? '')).toBe('https://cdn.example/b.png')
    // Without a session a local URL stays as built; restamping replaces, never repeats, the id.
    expect((publicToolFrame({ name: 'image_generate', result_view: { media } }, true).result_view as ToolResultView).media?.map((item) => item.url)).toEqual([local('/srv/out/a.png'), relayed?.[1]])
    // One the server would not fetch is a link.
    expect((publicToolFrame({ name: 'image_generate', result_view: { media: [{ ...media[1]!, url: 'http://cdn.example/b.png' }] } }, true).result_view as ToolResultView).media).toEqual([{ url: 'http://cdn.example/b.png', name: 'b.png', mime: 'image/png', kind: 'file' }])
    expect((publicToolFrame({ name: 'image_generate', result_view: frame.result_view }, true, null, 'sid-1').result_view as ToolResultView).media?.[0]?.url.match(/session_id/g)).toHaveLength(1)
  })
})

describe('memory, skills, session search, scheduled job, connection and clarify rows (TAL-2326)', () => {
  const view = (name: string, result: Record<string, unknown>, args?: Record<string, unknown>) => toolOutcome(JSON.stringify(result), name, false, args).result_view

  it('gives each tool its kind', () => {
    expect(['memory', 'skills_list', 'skill_view', 'skill_manage', 'session_search', 'cronjob_manage', 'manage_connections', 'clarify'].map((name) => [name, toolKind(name)])).toEqual([
      ['memory', 'memory'], ['skills_list', 'skill'], ['skill_view', 'skill'], ['skill_manage', 'skill'],
      ['session_search', 'session'], ['cronjob_manage', 'schedule'], ['manage_connections', 'connection'], ['clarify', 'question'],
    ])
    expect(toolDisplay('session_search', { query: 'release notes' })).toMatchObject({ kind: 'session', target: 'release notes' })
    expect(toolDisplay('cronjob_manage', { action: 'pause', job_id: 'j1' })).toMatchObject({ kind: 'schedule', target: 'j1' })
    expect(toolDisplay('clarify', { questions: [{ question: 'Which?' }] })).toMatchObject({ kind: 'question', target: '' })
  })

  it('shows each memory change under its store, an update with its old text and a staged write waiting for approval', () => {
    const shown = view('memory', { success: true, done: true, target: 'memory', usage: '12% — 264/2,200 chars', entry_count: 3, message: 'Applied 3 operation(s).',
      patched_entries: { 2: 'Prefers tabs' }, patched_entries_after: { 2: 'Prefers spaces' }, removed_entries: { 3: 'Lives in Oslo' } },
    { target: 'memory', operations: [{ action: 'add', content: 'Uses vim' }, { action: 'patch', old_text: 'tabs', content: 'spaces' }, { action: 'remove', old_text: 'Oslo' }] })
    expect(shown.rows).toEqual({ title: 'Memory · 12% — 264/2,200 chars', rows: [
      { label: 'Added: Uses vim' }, { label: 'Updated: Prefers spaces', detail: 'Was: Prefers tabs' }, { label: 'Removed: Lives in Oslo' },
    ] })
    expect(shown.fields).toBeUndefined()
    expect(view('memory', { success: true, target: 'user', usage: '1%', patched_entry_before: 'Kim', patched_entry_after: 'Kim (they/them)' }, { action: 'patch', target: 'user', old_text: 'Kim', new_text: 'Kim (they/them)' }).rows)
      .toEqual({ title: 'User profile · 1%', rows: [{ label: 'Updated: Kim (they/them)', detail: 'Was: Kim' }] })
    expect(view('memory', { success: true, staged: true, pending_id: 'p1', message: 'Queued for review.' }, { target: 'memory', operations: [{ action: 'remove', old_text: 'Oslo' }] }).rows)
      .toEqual({ title: 'Memory', rows: [{ label: 'Waiting for approval', detail: 'Queued for review.', status: 'pending' }, { label: 'Removed: Oslo', status: 'pending' }] })
  })

  it('lists skills, shows a viewed skill as its formatted text and each skill write with its lint findings', () => {
    expect(view('skills_list', { success: true, skills: [{ name: 'pdf', description: 'Read PDFs', category: 'docs' }], categories: ['docs'], count: 1 }).rows)
      .toEqual({ title: 'Skills', rows: [{ label: 'pdf', detail: 'Read PDFs', link: { kind: 'skill', id: 'pdf' } }] })
    expect(view('skill_view', { success: true, name: 'pdf', description: 'Read PDFs', content: '# PDF\n\nUse **pdftotext**.', setup_needed: true, setup_note: 'Set $PDF_KEY.', readiness_status: 'setup_needed' }).rows).toEqual({
      title: 'pdf', rows: [{ label: 'Read PDFs', link: { kind: 'skill', id: 'pdf' } }, { label: 'Setup needed', detail: 'Set $PDF_KEY.', status: 'warn' }], markdown: '# PDF\n\nUse **pdftotext**.',
    })
    expect(view('skill_view', { status: 'unchanged', name: 'pdf' }).rows).toEqual({ title: 'pdf', rows: [{ label: 'Already loaded in this chat', status: 'ok', link: { kind: 'skill', id: 'pdf' } }] })
    expect(view('skill_manage', { success: true, operations_applied: 2, results: [
      { name: 'pdf', action: 'patch', file_path: 'SKILL.md', success: true, lint_warnings: [{ severity: 'warning', rule: 'heading', message: 'Missing title' }] },
      { name: 'old', action: 'delete', file_path: null, success: true },
    ] }).rows).toEqual({ rows: [
      { label: 'Patched pdf', detail: 'SKILL.md', link: { kind: 'skill', id: 'pdf' } }, { label: 'Missing title', detail: 'heading', status: 'warn' }, { label: 'Deleted old' },
    ] })
    expect(view('skill_manage', { success: true, message: 'Skill created.', path: '/skills/pdf' }, { action: 'create', name: 'pdf' }).rows).toEqual({ rows: [{ label: 'Created pdf', detail: '/skills/pdf', link: { kind: 'skill', id: 'pdf' } }] })
    expect(view('skill_manage', { success: true, staged: true, pending_id: 'p2', gist: 'New pdf skill', message: 'Staged.' }, { action: 'create', name: 'pdf' }).rows)
      .toEqual({ rows: [{ label: 'Waiting for approval', detail: 'New pdf skill', status: 'pending' }, { label: 'Created pdf', status: 'pending', link: { kind: 'skill', id: 'pdf' } }] })
  })

  it('shows a failed call as its error on one line, never rows', () => {
    for (const name of ['memory', 'skill_view', 'session_search', 'cronjob_manage', 'manage_connections']) {
      const shown = view(name, { success: false, error: `${name} broke` })
      expect(shown.rows).toBeUndefined()
      expect(shown.error).toBe(`${name} broke`)
    }
  })

  it('shows each session search mode as chats that open in Talaria', () => {
    const link = (id: string) => ({ kind: 'session', id })
    expect(view('session_search', { success: true, mode: 'discover', query: 'deploy', results: [
      { session_id: 's1', when: 'November 16, 2026 at 09:00 AM', title: 'Deploy fix', matched_role: 'user', snippet: 'the deploy failed\nsecond line', link: '@session:s1' },
      { session_id: 's2', when: 'November 15, 2026 at 10:00 AM', title: null, snippet: '' },
    ], count: 2 }).rows).toEqual({ title: 'deploy', rows: [
      { label: 'Deploy fix', detail: 'November 16, 2026 at 09:00 AM · the deploy failed', link: link('s1') }, { label: 'Untitled chat', detail: 'November 15, 2026 at 10:00 AM', link: link('s2') },
    ] })
    expect(view('session_search', { success: true, mode: 'browse', results: [{ session_id: 's3', title: 'Groceries', last_active: 1, message_count: 4, preview: 'milk' }] }).rows)
      .toEqual({ title: 'Recent chats', rows: [{ label: 'Groceries', detail: 'milk', link: link('s3') }] })
    for (const mode of ['read', 'scroll']) {
      expect(view('session_search', { success: true, mode, session_id: 's1', session_meta: { title: 'Deploy fix', when: 'November 16, 2026 at 09:00 AM' }, messages: [
        { id: 1, role: 'user', content: 'Why did it fail?\nDetails' }, { id: 2, role: 'assistant', content: '' },
      ] }).rows).toEqual({ title: 'Deploy fix · November 16, 2026 at 09:00 AM', rows: [
        { label: 'Why did it fail?', detail: 'user', link: link('s1') }, { label: '…', detail: 'assistant', link: link('s1') },
      ] })
    }
  })

  it('shows scheduled jobs under what the action did, each opening the scheduled jobs page', () => {
    const job = { job_id: 'j1', name: 'Digest', schedule: 'every day at 09:00', next_run_at: '2026-11-18T09:00:00-05:00', last_run_at: null, last_status: 'ok', enabled: true, state: 'scheduled' }
    expect(view('cronjob_manage', { success: true, count: 2, jobs: [job, { ...job, job_id: 'j2', name: 'Backup', last_status: 'error', enabled: false, next_run_at: null }] }, { action: 'list' }).rows).toEqual({ title: 'Scheduled jobs', rows: [
      { label: 'Digest', detail: 'every day at 09:00 · next 2026-11-18 09:00 · last ok', status: 'ok', link: { kind: 'crons', id: 'j1' } },
      { label: 'Backup', detail: 'every day at 09:00 · paused · last error', status: 'error', link: { kind: 'crons', id: 'j2' } },
    ] })
    for (const [action, title] of [['create', 'Created'], ['update', 'Updated'], ['pause', 'Paused'], ['resume', 'Resumed'], ['run', 'Started'], ['cancel', 'Cancelled']]) {
      expect(view('cronjob_manage', { success: true, job: { ...job, last_status: null } }, { action }).rows).toEqual({ title, rows: [{ label: 'Digest', detail: 'every day at 09:00 · next 2026-11-18 09:00', link: { kind: 'crons', id: 'j1' } }] })
    }
    expect(view('cronjob_manage', { success: true, message: "Cron job 'Digest' removed.", removed_job: { id: 'j1', name: 'Digest', schedule: 'every day at 09:00' } }, { action: 'remove' }).rows)
      .toEqual({ title: 'Removed', rows: [{ label: 'Digest', detail: 'every day at 09:00', link: { kind: 'crons' } }] })
  })

  it('shows connected apps and a connect operation without its connect URL, each opening connections', () => {
    const connectors = { kind: 'connectors' }
    expect(view('manage_connections', { connectors: [
      { connector: 'github', connected: true, accounts: [{ alias: 'work', label: 'kim@work', status: 'active' }, { alias: null, label: 'kim@home', status: 'active' }] },
      { connector: 'notion', connected: false, accounts: [] },
    ], hint: 'h' }).rows).toEqual({ rows: [{ label: 'github', detail: 'work, kim@home', status: 'ok', link: connectors }, { label: 'notion', detail: 'Not connected', link: connectors }] })
    const connect = toolOutcome(JSON.stringify({ targets: [
      { name: 'github', kind: 'connector', action: 'connect', state: 'initiated', alias: 'work', connect_url: 'https://portal.example/authorize?code=SECRET' },
      { name: 'notion', kind: 'connector', action: 'connect', state: 'failed', error: 'denied' },
    ], status: 'initiated', note: 'Show each connect_url to the user.' }), 'manage_connections')
    expect(connect.result_view.rows).toEqual({ rows: [
      { label: 'github', detail: 'work · initiated', status: 'pending', link: connectors }, { label: 'notion', detail: 'failed · denied', status: 'error', link: connectors },
    ] })
    expect(JSON.stringify(connect.result_view)).not.toContain('portal.example')
    expect(view('manage_connections', { renamed: { connector: 'github', alias: 'personal', label: 'kim@home' }, notice: 'n' }).rows).toEqual({ rows: [{ label: 'github', detail: 'Renamed to personal', status: 'ok', link: connectors }] })
  })

  it('shows each clarify question with its answer, or that it was skipped or never answered', () => {
    expect(view('clarify', { responses: [
      { question: 'Which color?', choices_offered: ['red', 'blue'], status: 'answered', user_response: 'blue' },
      { question: 'Which sizes?', choices_offered: ['S', 'M'], status: 'answered', user_response: ['S', 'M'] },
      { question: 'Name?', choices_offered: null, status: 'skipped', user_response: null },
      { question: 'Why?', choices_offered: null, status: 'unanswered', user_response: null },
    ], outcome: 'answered' }).rows).toEqual({ rows: [
      { label: 'Which color?', detail: 'blue' }, { label: 'Which sizes?', detail: 'S, M' }, { label: 'Name?', detail: 'Skipped' }, { label: 'Why?', detail: 'No answer' },
    ] })
  })

  // TAL-2027: the Agent's batch shape (with or without a status), its legacy one-question shape and its timeout sentinel.
  it('reads a clarify result in each shape the Agent returns, with how its wait ended', () => {
    const batch = { responses: [{ question: 'Which checks?', user_response: ['Lint', ' ', 'Unit tests'] }, { question: 'Ship it?', user_response: '  ' }] }
    expect(view('clarify', batch).rows).toEqual({ rows: [{ label: 'Which checks?', detail: 'Lint, Unit tests' }, { label: 'Ship it?', detail: 'No answer' }] })
    expect(view('clarify', { question: 'Which branch?', choices_offered: ['main', 'dev'], user_response: 'dev' }).rows).toEqual({ rows: [{ label: 'Which branch?', detail: 'dev' }] })
    const sentinel = 'The user did not provide a response within the time limit. Use your best judgement to make the choice and proceed.'
    expect(view('clarify', { question: 'Which branch?', choices_offered: null, user_response: sentinel }).rows).toEqual({ title: 'Timed out waiting for an answer.', rows: [{ label: 'Which branch?', detail: 'No answer' }] })
    expect(view('clarify', { responses: [{ question: 'Which?', status: 'unanswered', user_response: null }], outcome: 'timed_out', notice: 'The clarification timed out.' }).rows)
      .toEqual({ title: 'The clarification timed out.', rows: [{ label: 'Which?', detail: 'No answer' }] })
    expect(view('clarify', { ...batch, timed_out: true }).rows?.title).toBe('Timed out waiting for an answer.')
    const failed = toolOutcome(JSON.stringify({ error: 'questions must be a non-empty array.' }), 'clarify', false).result_view
    expect(failed.rows).toBeUndefined()
    expect(failed.error).toBe('questions must be a non-empty array.')
  })

  it('ships the shared answered-question row: its rows in view, apart from the run of calls around it', () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../contracts/fixtures/answered-question.json'), 'utf8')) as { result: Record<string, unknown>; row: { tool: { args: unknown; kind: string; target: string; shows_card: true; result_view: ToolResultView } } }
    const { tool } = fixture.row
    expect(toolDisplay('clarify', tool.args)).toMatchObject({ kind: tool.kind, target: tool.target, shows_card: tool.shows_card })
    expect(toolOutcome(JSON.stringify(fixture.result), 'clarify', false, tool.args).result_view).toMatchObject(tool.result_view)
  })

  it('keeps rows within the result budget and a stored view as it was decided', () => {
    const skills = Array.from({ length: 200 }, (_, i) => ({ name: `skill-${String(i)}`, description: 'x'.repeat(40) }))
    const shown = toolOutcome(JSON.stringify({ success: true, skills }), 'skills_list')
    expect(shown.result_view.rows).toMatchObject({ title: 'Skills', rows: expect.any(Array) as unknown })
    expect(shown.capped).toBe(true)
    expect(shown.result_view.rows!.rows.length).toBeLessThan(200)
    expect(shown.result_view.rows!.rows.at(-1)!.link).toEqual({ kind: 'skill', id: expect.stringMatching(/^skill-\d+$/) as unknown })
    expect(decidedResultView({ rows: shown.result_view.rows })).toEqual({ rows: shown.result_view.rows })
    // A row whose detail spends the budget keeps its status, so the stored view still parses with its neighbours.
    const setup = toolOutcome(JSON.stringify({ success: true, name: 'pdf', description: 'Read PDFs', content: '# PDF', setup_needed: true, setup_note: 'x'.repeat(5000) }), 'skill_view').result_view.rows!
    expect(setup.rows.map((row) => row.status ?? null)).toEqual([null, 'warn'])
    expect(decidedResultView({ rows: setup }).rows).toEqual(setup)
  })
})

describe('Kanban rows (TAL-2327)', () => {
  const view = (name: string, result: Record<string, unknown>, args?: Record<string, unknown>) => toolOutcome(JSON.stringify(result), name, false, args).result_view
  const task = (id: string, board?: string) => ({ kind: 'kanban_task', id, ...(board ? { board } : {}) })

  it('gives every kanban tool the kanban kind and its verb, and names the task it acts on', () => {
    const verbs = {
      kanban_attach: 'update', kanban_attach_url: 'update', kanban_attachments: 'view', kanban_block: 'block', kanban_comment: 'comment', kanban_complete: 'complete',
      kanban_create: 'create', kanban_heartbeat: 'update', kanban_link: 'update', kanban_list: 'list', kanban_request_changes: 'update', kanban_request_review: 'update',
      kanban_schedule: 'update', kanban_show: 'view', kanban_unblock: 'update',
    }
    expect(Object.fromEntries(Object.keys(verbs).map((name) => [name, toolDisplay(name, {}).verb]))).toEqual(verbs)
    expect(new Set(Object.keys(verbs).map(toolKind))).toEqual(new Set(['kanban']))
    expect(toolDisplay('kanban_create', { title: 'Write release notes', assignee: 'scout' })).toMatchObject({ kind: 'kanban', verb: 'create', target: 'Write release notes' })
    expect(toolDisplay('kanban_complete', { task_id: 't_1', summary: 'done' })).toMatchObject({ kind: 'kanban', verb: 'complete', target: 't_1' })
    expect(toolDisplay('kanban_list', { status: 'ready' })).toMatchObject({ kind: 'kanban', verb: 'list', target: '' })
    expect(toolDisplay('read_file', { path: 'a.ts' })).not.toHaveProperty('verb')
  })

  it('shows a shown or listed task as its title, status and assignee, opening it on the call\'s board', () => {
    expect(view('kanban_show', { task: { id: 't_1', title: 'Fix login', status: 'running', assignee: 'scout', priority: 0 }, parents: [], children: ['t_2'], comments: [], events: [], runs: [] }, { task_id: 't_1', board: 'ops' }).rows)
      .toEqual({ rows: [{ label: 'Fix login', detail: 'running · scout', link: task('t_1', 'ops') }] })
    const shown = view('kanban_list', { tasks: [{ id: 't_1', title: 'Fix login', status: 'running', assignee: 'scout' }, { id: 't_2', title: null, status: 'todo', assignee: null }], count: 2, truncated: false }, {})
    expect(shown.rows).toEqual({ rows: [{ label: 'Fix login', detail: 'running · scout', link: task('t_1') }, { label: 't_2', detail: 'todo', link: task('t_2') }] })
    expect(shown.fields).toBeUndefined()
  })

  it('shows the task a write acted on: a new one by its title, a state change with where it landed, a comment, a file and a link', () => {
    expect(view('kanban_create', { ok: true, task_id: 't_9', status: 'todo', gated: true, gated_by: 't_1', subscribed: false }, { title: 'Write notes', assignee: 'scout', parents: ['t_1'] }).rows)
      .toEqual({ rows: [{ label: 'Write notes', detail: 'todo · waiting on parent', link: task('t_9') }] })
    expect(view('kanban_block', { ok: true, task_id: 't_1', run_id: 4, status: 'blocked', block_kind: 'needs_input' }, { task_id: 't_1', reason: 'Which API key?' }).rows)
      .toEqual({ rows: [{ label: 't_1', detail: 'blocked · needs input', link: task('t_1') }] })
    for (const [name, status] of [['kanban_complete', 'done'], ['kanban_request_review', 'review'], ['kanban_request_changes', 'ready'], ['kanban_schedule', 'scheduled'], ['kanban_unblock', 'ready']]) {
      expect(view(name!, { ok: true, task_id: 't_1', status }, { task_id: 't_1' }).rows, name).toEqual({ rows: [{ label: 't_1', detail: status, link: task('t_1') }] })
    }
    expect(view('kanban_heartbeat', { ok: true, task_id: 't_1' }, { task_id: 't_1', note: 'still going' }).rows).toEqual({ rows: [{ label: 't_1', link: task('t_1') }] })
    expect(view('kanban_comment', { ok: true, task_id: 't_1', comment_id: 7 }, { task_id: 't_1', body: 'Looks good\nsecond line', board: 'ops' }).rows)
      .toEqual({ rows: [{ label: 't_1', detail: 'Looks good', link: task('t_1', 'ops') }] })
    expect(view('kanban_attach', { ok: true, task_id: 't_1', attachment_id: 3, size: 12 }, { task_id: 't_1', filename: 'log.txt', content_base64: 'aGk=' }).rows)
      .toEqual({ rows: [{ label: 't_1', detail: 'log.txt', link: task('t_1') }] })
    expect(view('kanban_attach_url', { ok: true, task_id: 't_1', attachment_id: 4, size: 99 }, { task_id: 't_1', url: 'https://example.invalid/r.pdf' }).rows)
      .toEqual({ rows: [{ label: 't_1', detail: 'https://example.invalid/r.pdf', link: task('t_1') }] })
    expect(view('kanban_attachments', { ok: true, task_id: 't_1', attachments: [{ id: 3, filename: 'log.txt', content_type: 'text/plain', size: 12 }] }, { task_id: 't_1' }).rows)
      .toEqual({ rows: [{ label: 't_1', link: task('t_1') }, { label: 'log.txt', detail: 'text/plain' }] })
    expect(view('kanban_link', { ok: true, parent_id: 't_1', child_id: 't_2', gated: true, gated_by: 't_1' }, { parent_id: 't_1', child_id: 't_2' }).rows)
      .toEqual({ rows: [{ label: 't_1', detail: 'Parent', link: task('t_1') }, { label: 't_2', detail: 'Child · waiting on parent', link: task('t_2') }] })
  })

  it('shows a failed call as its error on one line, never rows', () => {
    for (const name of ['kanban_show', 'kanban_complete', 'kanban_list']) {
      const shown = view(name, { error: `${name}: task t_1 not found` }, { task_id: 't_1' })
      expect(shown.rows).toBeUndefined()
      expect(shown.error).toBe(`${name}: task t_1 not found`)
    }
  })
})

describe('browser and computer-use calls (TAL-2328)', () => {
  const view = (name: string, result: unknown, args?: Record<string, unknown>) => toolOutcome(typeof result === 'string' || Array.isArray(result) ? result : JSON.stringify(result), name, false, args).result_view
  const png = 'iVBORw0KGgoAAAANSUhEUgAA'.repeat(80)
  const shot = '/srv/hermes/cache/browser-use/shot.png'
  const shotMedia = (path: string) => [{ url: `./api/media?${new URLSearchParams({ path }).toString()}`, name: path.split('/').pop(), mime: 'image/png', kind: 'image' }]

  it('gives the browser tools the browser kind and computer_use the computer kind, each with its verb', () => {
    expect(toolDisplay('browser_exec', { code: '# Open the pricing page\ngoto("https://example.com")' })).toMatchObject({ kind: 'browser', verb: 'run', target: 'Open the pricing page' })
    expect(toolDisplay('browser_cdp', { method: 'Page.navigate', params: { url: 'https://example.com' } })).toMatchObject({ kind: 'browser', verb: 'send', target: 'Page.navigate' })
    expect(toolDisplay('browser_dialog', { action: 'accept' })).toMatchObject({ kind: 'browser', verb: 'answer', target: '' })
    expect(['list', 'fill', 'enter_code', 'save_login'].map((action) => toolDisplay('browser_vault', { action, handle: 'h1' }).verb)).toEqual(['list', 'fill', 'fill', undefined])
    expect(['capture', 'click', 'right_click', 'type', 'key', 'list_apps'].map((action) => toolDisplay('computer_use', { action, text: 'hunter2', app: 'Safari' }))).toEqual([
      { kind: 'computer', target: '', focus_path: null, verb: 'capture' }, { kind: 'computer', target: '', focus_path: null, verb: 'click' }, { kind: 'computer', target: '', focus_path: null, verb: 'click' },
      { kind: 'computer', target: '', focus_path: null, verb: 'type' }, { kind: 'computer', target: '', focus_path: null }, { kind: 'computer', target: '', focus_path: null },
    ])
  })

  it('shows the code browser_exec ran above its output, and the screenshot it saved, from a JSON or native-vision result', () => {
    const code = '# Open the pricing page\ngoto("https://example.com/pricing")\nprint(page_info())'
    const ran = { success: true, exit_code: 0, output: 'Pricing — $10', workspace: '/srv/ws', screenshot_path: shot }
    const expected = {
      file_excerpt: { path: '', language: 'python', start_line: 1, lines: [{ n: 1, text: '# Open the pricing page' }, { n: 2, text: 'goto("https://example.com/pricing")' }, { n: 3, text: 'print(page_info())' }], total_lines: 3, truncated: false },
      stdout: 'Pricing — $10', media: shotMedia(shot),
    }
    expect(view('browser_exec', ran, { code })).toEqual(expected)
    // The Agent's history keeps a native-vision result as the parts it handed the model; the live frame as its envelope.
    expect(view('browser_exec', [{ type: 'text', text: `${JSON.stringify(ran)}\n\nThe screenshot from this call is attached — inspect it with your native vision.` }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${png}` } }], { code })).toEqual(expected)
    expect(view('browser_exec', { _multimodal: true, text_summary: JSON.stringify(ran), meta: { screenshot_path: shot, native_vision: true }, content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${png}` } }] }, { code })).toEqual(expected)
    expect(view('browser_exec', { success: false, exit_code: 1, output: '', stderr: 'NameError: goto' }, { code: 'goto()' })).toEqual({ file_excerpt: { ...expected.file_excerpt, lines: [{ n: 1, text: 'goto()' }], total_lines: 1 }, stderr: 'NameError: goto', exit_code: 1, outcome: { key: 'failed', tone: 'error', value: 'NameError: goto' } })
    expect(view('browser_exec', { error: 'browser-use exec timed out after 60s.' }, { code: 'wait()' })).toMatchObject({ error: 'browser-use exec timed out after 60s.' })
    // Its code shows once: the completion's argument rows leave it out, replacing the start frame's that showed it.
    const started = publicToolFrame({ name: 'browser_exec', args: { code, session: 'checkout' } }, true)
    expect((started.args_fields as { key: string }[]).map((f) => f.key)).toEqual(['code', 'session'])
    expect(publicToolFrame({ name: 'browser_exec', args: { code }, result_view: expected }, true).args_fields).toEqual([])
    expect(publicToolFrame({ name: 'browser_exec', args: { code, session: 'checkout' }, result_view: expected }, true).args_fields).toEqual([{ key: 'session', value: 'checkout', multiline: false }])
  })

  it('shows a CDP command as its method and never its screenshot or other binary data', () => {
    const result = { success: true, method: 'Page.captureScreenshot', result: { data: png } }
    const outcome = toolOutcome(JSON.stringify(result), 'browser_cdp', false, { method: 'Page.captureScreenshot' })
    expect(outcome.result_view.rows).toEqual({ rows: [{ label: 'Page.captureScreenshot', status: 'ok' }] })
    expect(JSON.stringify(outcome)).not.toContain(png.slice(0, 64))
    expect(outcome.result_view.text).toContain('[binary data]')
    expect(outcome.result_view.fields).toBeUndefined()
  })

  it('reads a live completion, whose nested values the sidecar forwards as JSON text, as its stored result', () => {
    // The sidecar's `_raw_result`: a non-empty nested object or list becomes its JSON text.
    const live = (result: Record<string, unknown>) => Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value && typeof value === 'object' && Object.keys(value).length ? JSON.stringify(value) : value]))
    const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
      ['browser_vault', { success: true, items: [{ label: 'GitHub', kind: 'login', origin: 'https://github.com', available: true }], locked: [{ backend: 'op', display_name: '1Password' }] }, { action: 'list' }],
      ['browser_dialog', { success: true, action: 'accept', dialog: { type: 'alert', message: 'Saved', default_prompt: '' } }, { action: 'accept' }],
      ['computer_use', { ok: true, action: 'type', verdict: { decision: 'verify_fresh_state' } }, { action: 'type' }],
      ['computer_use', { apps: [{ name: 'Safari', pid: 1 }], count: 1 }, { action: 'list_apps' }],
    ]
    for (const [name, result, args] of cases) {
      const stored = toolOutcome(JSON.stringify(result), name, false, args).result_view.rows
      expect(stored, name).toBeDefined()
      expect(toolOutcome(live(result), name, false, args).result_view.rows, name).toEqual(stored)
    }
  })

  it('shows an answered dialog as its message, type and answer', () => {
    expect(view('browser_dialog', { success: true, action: 'dismiss', dialog: { type: 'confirm', message: 'Leave this page?\nChanges are lost.', default_prompt: '' } }, { action: 'dismiss' }).rows)
      .toEqual({ rows: [{ label: 'Leave this page?', detail: 'confirm · Dismissed', status: 'ok' }] })
  })

  it('shows the vault\'s saved logins and what a fill filled, never a credential, and a takeover as a warning', () => {
    const list = view('browser_vault', { success: true, items: [
      { handle: 'h1', backend: 'local', label: 'GitHub', kind: 'login', origin: 'https://github.com', available: true, identifier: 'octo@example.com', identifier_type: 'email' },
      { handle: 'h2', backend: 'local', label: 'Visa', kind: 'card', origin: '', available: false },
    ], locked: [{ backend: 'op', display_name: '1Password', unlock: 'browser_vault action=unlock' }] }, { action: 'list' })
    expect(list.rows).toEqual({ title: 'Saved logins', rows: [
      { label: 'GitHub', detail: 'https://github.com', status: 'ok' }, { label: 'Visa', detail: 'card · Unavailable', status: 'warn' }, { label: '1Password', detail: 'Locked', status: 'warn' },
    ] })
    expect(JSON.stringify(list.rows)).not.toContain('octo@example.com')
    expect(view('browser_vault', { success: true, filled_fields: 2, backend: 'local', kind: 'login', origin: 'https://github.com', next: 'Submit.' }, { action: 'fill', handle: 'h1' }).rows)
      .toEqual({ rows: [{ label: 'Filled 2 fields on https://github.com', status: 'ok' }] })
    const saved = view('browser_vault', { success: true, handle: 'h3', origin: 'https://example.com', identifier: 'me@example.com', identifier_type: 'email', fill: { success: true, filled_fields: 1, origin: 'https://example.com' } }, { action: 'save_login' })
    expect(saved.rows).toEqual({ rows: [{ label: 'Saved a login for https://example.com', status: 'ok' }, { label: 'Filled 1 field on https://example.com', status: 'ok' }] })
    expect(JSON.stringify(saved.rows)).not.toContain('me@example.com')
    expect(view('browser_vault', { success: false, error_type: 'human_has_control', error: 'The user has control of the browser.' }, { action: 'fill' }).rows).toEqual({ rows: [{ label: 'You have control of the browser', status: 'warn' }] })
  })

  it('shows a computer_use action, capture or list as rows under its app, its screenshot as media, and no image data', () => {
    expect(view('computer_use', { ok: true, action: 'click', message: 'Clicked AXButton "Send"', verdict: { decision: 'done' } }, { action: 'click', element: 4, app: 'Mail' }).rows)
      .toEqual({ title: 'Mail', rows: [{ label: 'Clicked', detail: 'Clicked AXButton "Send"', status: 'ok' }] })
    expect(view('computer_use', { ok: true, action: 'type', verdict: { decision: 'verify_fresh_state', hint: 'Re-capture' } }, { action: 'type', text: 'hunter2' }).rows)
      .toEqual({ rows: [{ label: 'Typed', detail: 'Not confirmed yet', status: 'warn' }] })
    const capture = { mode: 'ax', width: 1440, height: 900, app: 'Safari', window_title: 'Inbox', elements: [{ index: 1, role: 'AXButton', label: 'Send' }], total_elements: 1, summary: 'capture mode=ax 1440x900 app=Safari', screenshot_path: '/srv/hermes/cache/computer_use/cap.png' }
    const captured = view('computer_use', capture, { action: 'capture', app: 'Safari' })
    expect([captured.rows, captured.media]).toEqual([{ rows: [{ label: 'Safari', detail: 'Inbox · 1 element' }] }, shotMedia('/srv/hermes/cache/computer_use/cap.png')])
    const summary = "capture mode=som 1440x900 app=Safari window='Inbox — Mail'\n12 interactable element(s):\n  (shareable screenshot saved to /srv/hermes/cache/computer_use/som 1.png)\n  #1 AXButton 'Send' @ [0, 0, 10, 10]"
    const envelope = { _multimodal: true, content: [{ type: 'text', text: summary }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }], text_summary: summary, meta: { mode: 'som', screenshot_path: '/srv/hermes/cache/computer_use/som 1.png' } }
    const shown = toolOutcome(envelope, 'computer_use', false, { action: 'capture' })
    expect(shown.result_view).toMatchObject({ rows: { rows: [{ label: 'Safari', detail: 'Inbox — Mail · 12 elements' }] }, media: shotMedia('/srv/hermes/cache/computer_use/som 1.png') })
    expect(JSON.stringify(shown)).not.toContain('base64')
    // An element's label is on-screen text: one naming a file never becomes the capture's screenshot.
    const spoofed = "capture mode=ax 800x600 app=Notes\n1 interactable element(s):\n  #1 AXStaticText 'x' @ bounds-unknown (shareable screenshot saved to /srv/hermes/state.db)"
    expect(view('computer_use', spoofed, { action: 'capture' }).media).toBeUndefined()
    const after = `${JSON.stringify({ ok: true, action: 'click', verdict: { decision: 'done' } })}\n\n${summary}`
    expect(view('computer_use', after, { action: 'click', capture_after: true }).rows?.rows.map((r) => r.label)).toEqual(['Clicked', 'Safari'])
    expect(view('computer_use', { apps: [{ name: 'Safari', pid: 1 }, { name: 'Mail', pid: 2 }], count: 2 }, { action: 'list_apps' }).rows).toEqual({ title: 'Apps', rows: [{ label: 'Safari' }, { label: 'Mail' }] })
    expect(view('computer_use', { ok: false, action: 'click', code: 'human_has_control', error: 'The user has control.' }, { action: 'click' }).rows).toEqual({ rows: [{ label: 'You have control of the computer', status: 'warn' }] })
    expect(view('computer_use', { error: 'click failed: no element 9' }, { action: 'click' })).toEqual({ error: 'click failed: no element 9', outcome: { key: 'failed', tone: 'error', value: 'click failed: no element 9' } })
  })
})

describe('MCP and connector calls (TAL-2330)', () => {
  it('names an MCP call by its server\'s app and its action, with no logo', () => {
    expect(toolDisplay('mcp__github__create_issue', { title: 'Bug' })).toEqual({ kind: 'mcp', target: 'Create issue', focus_path: null, app: { name: 'GitHub', logo_url: null } })
    expect(toolKind('mcp__github__create_issue')).toBe('mcp')
  })

  it('names a connector call by its app, its action without the vendor prefix and its account alias, with the catalog logo inline', async () => {
    // TAL-2199: the logo ships as a data URL, so it loads under an `img-src` with no remote host; one the host refuses is none.
    await rememberConnectorLogos([{ slug: 'gmail', logo_url: 'https://logos.example/gmail.svg' }, { slug: 'slack', logo_url: null }, { slug: 'notion', logo_url: 'https://elsewhere.example/n.svg' }], logoFetch)
    expect(toolDisplay('connectors__gmail__GMAIL_SEND_EMAIL', { to: 'a@example.com', connector_alias: 'work' })).toEqual({ kind: 'connector', target: 'Send email (work)', focus_path: null, app: { name: 'Gmail', logo_url: LOGO_DATA_URL } })
    expect(toolDisplay('connectors__slack__SLACK_SEND_MESSAGE', {})).toMatchObject({ kind: 'connector', target: 'Send message', app: { name: 'Slack', logo_url: null } })
    expect(toolDisplay('connectors__notion__NOTION_CREATE_PAGE', {})).toMatchObject({ app: { name: 'Notion', logo_url: null } })
    // Live, the frame carries the same fields.
    expect(publicToolFrame({ name: 'connectors__gmail__GMAIL_SEND_EMAIL', tid: 'g', args: { connector_alias: 'work' } }, true)).toMatchObject({ kind: 'connector', target: 'Send email (work)', app: { name: 'Gmail', logo_url: LOGO_DATA_URL } })
  })

  it('titles apps as the Agent does: its known titles, else each word capitalized', () => {
    expect(['github', 'GitHub', 'googlecalendar', 'stripe_mcp', 'my-server', 'acme_crm', ' notion '].map(appTitle)).toEqual(['GitHub', 'GitHub', 'Google Calendar', 'Stripe', 'My Server', 'Acme Crm', 'Notion'])
    expect(toolDisplay('mcp__my-server__list_open_things', {})).toMatchObject({ kind: 'mcp', target: 'List open things', app: { name: 'My Server', logo_url: null } })
    // An MCP tool keeps a prefix that only a connector's vendor adds.
    expect(toolDisplay('mcp__github__GITHUB_LIST_REPOS', {})).toMatchObject({ target: 'Github list repos' })
  })

  it('keeps the file focus and edit diff of an MCP file tool, as its name tokens gave them', () => {
    const diff = '--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b'
    expect(toolEditDiff('mcp__fs__write_file', JSON.stringify({ diff }))).toMatchObject({ added: 1, removed: 1 })
    expect(toolDisplay('mcp__filesystem__read_file', { path: '/ws/src/main.ts' }, '/ws')).toMatchObject({ kind: 'mcp', focus_path: 'src/main.ts' })
    expect(toolDisplay('mcp__filesystem__write_file', { path: 'src/main.ts' })).toMatchObject({ kind: 'mcp', focus_path: 'src/main.ts' })
    expect(toolDisplay('mcp__github__create_issue', { path: 'src/main.ts' }).focus_path).toBeNull()
  })

  it('classifies a name in neither form exactly as before', () => {
    for (const [name, kind] of [['mcp__github', 'unknown'], ['mcp__github__', 'unknown'], ['connectors__gmail', 'unknown'], ['connectors____send', 'unknown'], ['connectors__gmail__', 'unknown'], ['my_mcp__read_file', 'read'], ['read_file', 'read']]) {
      const display = toolDisplay(name, { path: 'a.txt' })
      expect(display, name).not.toHaveProperty('app')
      expect(display.kind, name).toBe(kind)
    }
  })
})

describe('the outcome a collapsed tool row shows (TAL-2335)', () => {
  const outcome = (name: string, result: unknown, args?: Record<string, unknown>, flagged = false) => toolOutcome(typeof result === 'string' ? result : JSON.stringify(result), name, flagged, args).result_view.outcome

  it('says what a Talaria tool did', () => {
    expect(outcome('session_send', { outcome: 'queued', stream_id: null, steer_id: 's1' })).toEqual({ key: 'sent', tone: 'neutral' })
    expect(outcome('clarify_respond', { ok: true })).toEqual({ key: 'sent', tone: 'neutral' })
    expect(outcome('queue_send_now', { redirected: false, outcome: 'delivered' })).toEqual({ key: 'sent', tone: 'neutral' })
    expect(outcome('queue_send_now', { redirected: false, outcome: 'not_running' })).toBeUndefined()
    expect(outcome('session_new', { session_id: 's2', title: 'New', stream_id: null })).toEqual({ key: 'created', tone: 'neutral' })
    expect(outcome('approval_respond', { ok: true, choice: 'once' }, { approval_id: 'a1', choice: 'once' })).toEqual({ key: 'approved', tone: 'neutral' })
    expect(outcome('approval_respond', { ok: true }, { approval_id: 'a1', choice: 'deny' })).toEqual({ key: 'denied', tone: 'neutral' })
    expect(outcome('goal_set', { ok: true, action: 'set' })).toEqual({ key: 'goal_set', tone: 'neutral' })
    expect(outcome('session_list', { sessions: [] })).toBeUndefined()
  })

  it('counts memory changes and waits on a staged write', () => {
    expect(outcome('memory', { success: true, target: 'memory' }, { action: 'add', target: 'memory', content: 'Prefers Postgres' })).toEqual({ key: 'memory_added', tone: 'neutral', count: 1 })
    expect(outcome('memory', { success: true }, { operations: [{ action: 'remove', old_text: 'a' }, { action: 'remove', old_text: 'b' }] })).toEqual({ key: 'memory_removed', tone: 'neutral', count: 2 })
    expect(outcome('memory', { success: true }, { operations: [{ action: 'add', content: 'a' }, { action: 'patch', old_text: 'b', content: 'c' }] })).toEqual({ key: 'memory_updated', tone: 'neutral', count: 2 })
    expect(outcome('memory', { success: true, staged: true, message: 'Queued.' }, { action: 'add', content: 'a' })).toEqual({ key: 'pending_approval', tone: 'attention' })
    expect(outcome('memory', { success: true }, { action: 'constructor' })).toBeUndefined()
  })

  it('says what a skill write did, waits on a staged one and shows nothing for a refusal the Agent retries', () => {
    expect(outcome('skill_manage', { success: true, path: '/skills/pdf' }, { action: 'create', name: 'pdf' })).toEqual({ key: 'skill_created', tone: 'neutral' })
    expect(outcome('skill_manage', { success: true, results: [{ name: 'pdf', action: 'patch', success: true }] })).toEqual({ key: 'skill_updated', tone: 'neutral' })
    expect(outcome('skill_manage', { success: true, results: [{ name: 'old', action: 'delete', success: true }] })).toEqual({ key: 'removed', tone: 'neutral' })
    expect(outcome('skill_manage', { success: true, staged: true, gist: 'New skill' }, { action: 'edit', name: 'deploy-checklist' })).toEqual({ key: 'pending_approval', tone: 'attention' })
    expect(outcome('skill_manage', { success: false, error: 'old_text not found' }, { action: 'patch', name: 'pdf' })).toBeUndefined()
    expect(outcome('skill_view', { success: true, name: 'pdf', content: '# PDF' })).toBeUndefined()
  })

  it('says what a scheduled-job action did, with a new job\'s next run', () => {
    expect(outcome('cronjob_manage', { success: true, job: { job_id: 'j1', name: 'Digest', next_run_at: '2026-11-18T09:00:00+01:00' } }, { action: 'create' })).toEqual({ key: 'job_created', tone: 'neutral', value: '2026-11-18T08:00:00.000Z' })
    expect(outcome('cronjob_manage', { success: true, job: { job_id: 'j1', next_run_at: null } }, { action: 'create' })).toEqual({ key: 'job_created', tone: 'neutral' })
    expect(['pause', 'resume', 'remove', 'run'].map((action) => outcome('cronjob_manage', { success: true, job: { job_id: 'j1' } }, { action, job_id: 'j1' })?.key)).toEqual(['paused', 'resumed', 'removed', 'ran_now'])
    expect(outcome('cronjob_manage', { success: true, jobs: [] }, { action: 'list' })).toBeUndefined()
  })

  it('says where a Kanban task landed', () => {
    expect(outcome('kanban_request_review', { ok: true, task_id: 't1', status: 'review' })).toEqual({ key: 'moved_to', tone: 'neutral', value: 'Review' })
    expect(outcome('kanban_unblock', { ok: true, task_id: 't1', status: 'in_progress' })).toEqual({ key: 'moved_to', tone: 'neutral', value: 'In progress' })
    expect(outcome('kanban_block', { ok: true, task_id: 't1', status: 'blocked' })).toEqual({ key: 'blocked', tone: 'neutral' })
    expect(outcome('kanban_complete', { ok: true, task_id: 't1', status: 'done' })).toEqual({ key: 'completed', tone: 'neutral' })
    expect(outcome('kanban_comment', { ok: true, task_id: 't1' }, { task_id: 't1', body: 'LGTM' })).toEqual({ key: 'commented', tone: 'neutral' })
    expect(outcome('kanban_show', { task: { id: 't1', title: 'Fix', status: 'review' } })).toBeUndefined()
  })

  it('names connected apps, waits on a sign-in, and gives a question\'s answer or skip', () => {
    expect(outcome('manage_connections', { targets: [{ name: 'GitHub', state: 'connected' }, { name: 'Gmail', state: 'connected' }] })).toEqual({ key: 'connected', tone: 'neutral', value: 'GitHub, Gmail' })
    expect(outcome('manage_connections', { targets: [{ name: 'github', state: 'initiated', connect_url: 'https://portal.example/a' }] })).toEqual({ key: 'needs_sign_in', tone: 'attention' })
    expect(outcome('manage_connections', { connectors: [{ connector: 'github', connected: true }] })).toBeUndefined()
    expect(outcome('clarify', { responses: [{ question: 'Which repository?', status: 'answered', user_response: 'MaudeCode/talaria\nbecause it owns the bug' }] })).toEqual({ key: 'answered', tone: 'neutral', value: 'MaudeCode/talaria' })
    expect(outcome('clarify', { responses: [{ question: 'Which?', status: 'skipped', user_response: null }] })).toEqual({ key: 'skipped', tone: 'neutral' })
  })

  it('shows a non-zero exit, never a zero one', () => {
    expect(outcome('terminal', { output: 'FAIL auth.spec.ts', exit_code: 1, error: null })).toEqual({ key: 'exit', tone: 'error', count: 1 })
    expect(outcome('execute_code', { stdout: '', stderr: 'boom', exit_code: 2 })).toEqual({ key: 'exit', tone: 'error', count: 2 })
    expect(outcome('process_manage', { status: 'exited', exit_code: 137 })).toEqual({ key: 'exit', tone: 'error', count: 137 })
    expect(outcome('terminal', { output: 'clean', exit_code: 0, error: null })).toBeUndefined()
  })

  it('says a search found nothing only when it did', () => {
    expect(outcome('search_files', { total_count: 0, matches: [] }, { pattern: 'TODO(auth)' })).toEqual({ key: 'no_matches', tone: 'neutral' })
    expect(outcome('search_files', { total_count: 1, matches: [{ path: 'a.ts', line: 1, content: 'TODO(auth)' }] })).toBeUndefined()
    expect(outcome('web_search', { success: true, data: { web: [] } })).toEqual({ key: 'no_results', tone: 'neutral' })
    expect(outcome('web_search', { success: true, data: { web: [{ title: 'Release', url: 'https://example.com/r', description: 'd' }] } })).toBeUndefined()
    expect(outcome('x_search', { success: true, answer: '', citations: [] })).toEqual({ key: 'no_results', tone: 'neutral' })
    expect(outcome('session_search', { success: true, mode: 'discover', query: 'deploy', results: [], count: 0 })).toEqual({ key: 'no_results', tone: 'neutral' })
    expect(outcome('session_search', { success: true, mode: 'discover', query: 'deploy', results: [{ session_id: 's1', title: 'Deploy' }], count: 1 })).toBeUndefined()
  })

  it('shows any failed call\'s first error line, a flagged text result\'s included', () => {
    expect(outcome('memory', { success: false, error: 'Memory is full\nTry removing entries.' })).toEqual({ key: 'failed', tone: 'error', value: 'Memory is full' })
    expect(outcome('mcp__github__create_issue', 'Resource not accessible by integration', undefined, true)).toEqual({ key: 'failed', tone: 'error', value: 'Resource not accessible by integration' })
    expect(outcome('terminal', { output: '', exit_code: 0, error: 'command timed out' })).toEqual({ key: 'failed', tone: 'error', value: 'command timed out' })
    expect(outcome('session_send', { error: 'target is busy', condition: 'exceeds_caller' })).toEqual({ key: 'failed', tone: 'error', value: 'target is busy' })
  })

  it('shows nothing for reads, lists, views, media, edits and app successes', () => {
    expect(outcome('read_file', { content: '1|a', total_lines: 1 }, { path: 'a.ts' })).toBeUndefined()
    expect(outcome('skills_list', { success: true, skills: [] })).toBeUndefined()
    expect(outcome('web_extract', { results: [{ url: 'https://example.com', title: 'E', content: 'x' }] })).toBeUndefined()
    expect(outcome('browser_navigate', { success: true, url: 'https://example.com' })).toBeUndefined()
    expect(outcome('image_generate', { success: true, image: 'https://example.com/a.png' })).toBeUndefined()
    expect(outcome('write_file', { bytes_written: 12 }, { path: 'a.ts' })).toBeUndefined()
    expect(outcome('patch', { success: true, diff: '--- a\n+++ b' })).toBeUndefined()
    expect(outcome('mcp__gmail__send_email', { id: 'm1' })).toBeUndefined()
  })

  it('keeps a decided outcome, its value capped, and drops a malformed one', () => {
    expect(decidedResultView({ text: 'x', outcome: { key: 'answered', tone: 'neutral', value: 'y'.repeat(500) } }).outcome?.value?.length).toBeLessThanOrEqual(200)
    expect(decidedResultView({ text: 'x', outcome: { key: 'exit', tone: 'error', count: 1 } }).outcome).toEqual({ key: 'exit', tone: 'error', count: 1 })
    expect(decidedResultView({ text: 'x', outcome: { key: 'made_up', tone: 'neutral' } }).outcome).toBeUndefined()
  })
})
