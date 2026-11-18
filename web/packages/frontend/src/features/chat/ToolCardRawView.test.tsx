import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../../api/endpoints', () => ({ fetchToolResult: vi.fn(), fetchAnchorScene: vi.fn() }))
vi.mock('../../lib/clipboard', () => ({ copyWithToast: vi.fn() }))
import * as api from '../../api/endpoints'
import { copyWithToast } from '../../lib/clipboard'
import { TurnActivityView } from './TurnActivityView'
import { WorklogDisclosureProvider } from './blocks/Worklog'
import { ToolCard, type ToolCardData } from './blocks/ToolCard'
import { groupAssistantTurns, persistedActivity } from './turnActivity'
import { projectMessages } from './useTranscript'
import type { Message } from '../../contracts'

afterEach(() => { cleanup(); localStorage.clear(); vi.mocked(api.fetchToolResult).mockReset(); vi.mocked(copyWithToast).mockReset() })

// A scene row as the server ships it (TAL-2338): its formatted rows beside its redacted raw view.
const rawArgs = '{\n  "limit": 2\n}'
const rawResult = '{\n  "sessions": [\n    {\n      "title": "Release chat"\n    }\n  ],\n  "token": "***"\n}'
const listRow = { row_id: 'tool:list', role: 'tool', tool: { id: 'list', name: 'session_list', kind: 'session', target: '', preview: null, args: { limit: 2 }, args_fields: [{ key: 'limit', value: '2', multiline: false }], raw_args: rawArgs, result: '{"sessions":[{"title":"Release chat"}],"token":"***"}', raw_result: rawResult, result_view: { text: '{"sessions":[{"title":"Release chat"}],"token":"***"}', fields: [{ key: 'sessions', value: '- title: Release chat', multiline: false }, { key: 'token', value: '***', multiline: false }] }, done: true, is_error: false, duration: null, cost_usd: null } }
// A limited response clipped this one; its whole raw view is one request away.
const clipped = `${'x'.repeat(4000)}...`
const bigRow = { row_id: 'tool:big', role: 'tool', tool: { id: 'big', name: 'read_file', kind: 'read', target: 'big.txt', preview: null, args: { path: 'big.txt' }, args_fields: [{ key: 'path', value: 'big.txt', multiline: false }], raw_args: '{\n  "path": "big.txt"\n}', result: clipped, raw_result: clipped, result_view: { text: clipped }, done: true, is_error: false, duration: null, cost_usd: null, result_truncated: true, result_chars: 6000 } }

// Typed sections show in place of the result's text; Copy takes what shows.
const memoryRow = { row_id: 'tool:memory', role: 'tool', tool: { id: 'memory', name: 'memory', kind: 'memory', target: '', preview: null, args: {}, raw_result: '{\n  "success": true\n}', result_view: { text: 'Applied 1 operation(s).', rows: { title: 'User memory', rows: [{ label: 'Added', detail: 'Prefers short replies' }] } }, done: true, is_error: false, duration: null, cost_usd: null } }
const readRow = { row_id: 'tool:read', role: 'tool', tool: { id: 'read', name: 'read_file', kind: 'read', target: 'a.ts', preview: null, args: {}, raw_result: '1|const a = 1', result_view: { text: '1|const a = 1', file_excerpt: { path: 'a.ts', language: 'typescript', start_line: 1, lines: [{ n: 1, text: 'const a = 1' }], total_lines: 1, truncated: false } }, done: true, is_error: false, duration: null, cost_usd: null } }

function renderTurn() {
  const rows = [listRow, { row_id: 'p', role: 'prose', text: 'Next.' }, bigRow, { row_id: 'q', role: 'prose', text: 'More.' }, memoryRow, readRow].map((row, order_index) => ({ ...row, order_index }))
  const message = { role: 'assistant', id: 'settled', content: '', _turn_id: 'turn', _anchor_activity_scene: { version: 'activity_scene_v1', terminal_state: 'completed', final_answer: 'Done.', expanded_by_default: true, activity_rows: rows } } as Message
  const activity = persistedActivity(groupAssistantTurns(projectMessages([message]))[0]!)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><WorklogDisclosureProvider scope="profile/sess-1"><TurnActivityView activity={activity} mode="compact_worklog" sessionId="sess-1" /></WorklogDisclosureProvider></QueryClientProvider>)
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-tool-id="${id}"]`)!
const open = (id: string) => { fireEvent.click(row(id).querySelector(':scope > button')!) }
const button = (id: string, name: string) => Array.from(row(id).querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === name)
const pres = (id: string) => Array.from(row(id).querySelectorAll('.tool-card-detail pre')).map((pre) => pre.textContent)

describe('raw view and copy on an open tool row (TAL-2338)', () => {
  it('switches between the formatted rows and the server\'s raw view, copying whichever shows', () => {
    renderTurn()
    open('list')
    expect(button('list', 'Show raw')?.getAttribute('aria-pressed')).toBe('false')
    const toggle = button('list', 'Show raw')!
    fireEvent.click(button('list', 'Copy')!)
    expect(copyWithToast).toHaveBeenLastCalledWith('limit: 2\n\nsessions: - title: Release chat\ntoken: ***')

    fireEvent.click(toggle)
    expect(button('list', 'Show raw')).toBeUndefined()
    expect(button('list', 'Show formatted')?.getAttribute('aria-pressed')).toBe('true')
    expect(row('list').querySelector('[data-tool-view]')?.getAttribute('data-tool-view')).toBe('raw')
    expect(pres('list')).toEqual([rawArgs, rawResult])
    expect(button('list', 'Copy')).toBeUndefined()
    fireEvent.click(button('list', 'Copy raw')!)
    expect(copyWithToast).toHaveBeenLastCalledWith(`${rawArgs}\n\n${rawResult}`)

    fireEvent.click(button('list', 'Show formatted')!)
    expect(row('list').querySelector('[data-tool-view]')?.getAttribute('data-tool-view')).toBe('formatted')
    expect(button('list', 'Copy')).toBeDefined()
  })

  it('copies a typed result as it shows, not the text it stands in for', () => {
    renderTurn()
    open('memory')
    fireEvent.click(button('memory', 'Copy')!)
    expect(copyWithToast).toHaveBeenLastCalledWith('User memory\nAdded: Prefers short replies')
    open('read')
    fireEvent.click(button('read', 'Copy')!)
    expect(copyWithToast).toHaveBeenLastCalledWith('a.ts\nconst a = 1')
  })

  it('fetches a clipped result whole before showing or copying its raw view', async () => {
    const whole = 'x'.repeat(6000)
    let answer: (value: Awaited<ReturnType<typeof api.fetchToolResult>>) => void = () => undefined
    vi.mocked(api.fetchToolResult).mockReturnValue(new Promise((resolve) => { answer = resolve }))
    renderTurn()
    open('big')
    expect(button('big', 'Show raw')).toBeDefined()
    fireEvent.click(button('big', 'Show raw')!)
    expect(vi.mocked(api.fetchToolResult).mock.calls[0]?.slice(0, 2)).toEqual(['sess-1', 'big'])
    // Until the whole result arrives, nothing clipped shows or copies as raw.
    expect(pres('big')).toEqual(['{\n  "path": "big.txt"\n}'])
    expect(button('big', 'Copy raw')?.disabled).toBe(true)
    answer({ tool_call_id: 'big', result: whole, result_view: { text: whole }, raw_result: whole })
    await waitFor(() => { expect(pres('big')).toEqual(['{\n  "path": "big.txt"\n}', whole]) })
    fireEvent.click(button('big', 'Copy raw')!)
    expect(copyWithToast).toHaveBeenLastCalledWith(`{\n  "path": "big.txt"\n}\n\n${whole}`)
    expect(screen.queryAllByRole('button', { name: 'Copy raw' })).toHaveLength(1)
  })
})

describe('the server\'s raw default (TAL-2341)', () => {
  it('follows `opens_raw` while the row stays mounted, until the reader picks a view', () => {
    const call: ToolCardData = { id: 'list', name: 'session_list', kind: 'session', target: '', args: { limit: 2 }, argsFields: [{ key: 'limit', value: '2', multiline: false }], rawArgs, rawResult, preview: null, done: true, isError: false, duration: null, costUsd: null, resultView: null, progress: null }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const ui = (c: ToolCardData) => <QueryClientProvider client={qc}><WorklogDisclosureProvider scope="profile/sess-1"><ToolCard call={c} sessionId="sess-1" /></WorklogDisclosureProvider></QueryClientProvider>
    const view = render(ui(call))
    open('list')
    const pressed = () => (button('list', 'Show raw') ?? button('list', 'Show formatted'))?.getAttribute('aria-pressed')
    expect(pressed()).toBe('false')
    view.rerender(ui({ ...call, opensRaw: true }))
    expect(pressed()).toBe('true')
    fireEvent.click(button('list', 'Show formatted')!)
    expect(pressed()).toBe('false')
    // The reader's choice outlasts the next default.
    view.rerender(ui({ ...call, opensRaw: undefined }))
    view.rerender(ui({ ...call, opensRaw: true }))
    expect(pressed()).toBe('false')
  })
})
