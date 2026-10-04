import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../../api/endpoints', () => ({ fetchToolResult: vi.fn(), fetchAnchorScene: vi.fn() }))
import * as api from '../../api/endpoints'
import { TurnActivityView } from './TurnActivityView'
import { WorklogDisclosureProvider } from './blocks/Worklog'
import { groupAssistantTurns, persistedActivity } from './turnActivity'
import { projectMessages } from './useTranscript'
import type { Message } from '../../contracts'

afterEach(() => { cleanup(); localStorage.clear(); vi.mocked(api.fetchToolResult).mockReset() })

const full = 'x'.repeat(6000)
const clipped = `${full.slice(0, 4096)}\n\n[Tool output truncated in paginated session response; load the full transcript to inspect the complete result.]`
const tool = (id: string, result: string, extra: Record<string, unknown> = {}) => ({ row_id: `tool:${id}`, role: 'tool', tool: { id, name: 'read_file', kind: 'read', target: `${id}.txt`, preview: null, result, done: true, is_error: false, duration: null, cost_usd: null, ...extra } })

function renderTurn() {
  // A limited response's scene, as the server ships it: the clipped row is flagged, the short one is not.
  const rows = [tool('big', clipped, { result_truncated: true, result_chars: 6000 }), { row_id: 'p', role: 'prose', text: 'Next.' }, tool('small', 'short')].map((row, order_index) => ({ ...row, order_index }))
  const message = { role: 'assistant', id: 'settled', content: '', _turn_id: 'turn', _anchor_activity_scene: { version: 'activity_scene_v1', terminal_state: 'completed', final_answer: 'Done.', expanded_by_default: true, activity_rows: rows } } as Message
  const activity = persistedActivity(groupAssistantTurns(projectMessages([message]))[0]!)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><WorklogDisclosureProvider scope="profile/sess-1"><TurnActivityView activity={activity} mode="compact_worklog" sessionId="sess-1" /></WorklogDisclosureProvider></QueryClientProvider>)
}

const open = (id: string) => { fireEvent.click(document.querySelector(`[data-tool-id="${id}"] > button`)!) }
const resultText = (id: string) => document.querySelector(`[data-tool-id="${id}"] .tool-card-result pre`)?.textContent

describe('clipped tool output (TAL-331)', () => {
  it('fetches and shows the whole result of a row the server flagged as clipped', async () => {
    vi.mocked(api.fetchToolResult).mockResolvedValue({ tool_call_id: 'big', result: full })
    renderTurn()
    open('big')
    expect(resultText('big')).toBe(clipped)
    fireEvent.click(screen.getByRole('button', { name: 'Show full output' }))
    await waitFor(() => { expect(resultText('big')).toBe(full) })
    expect(vi.mocked(api.fetchToolResult).mock.calls[0]?.slice(0, 2)).toEqual(['sess-1', 'big'])
    expect(screen.queryByRole('button', { name: 'Show full output' })).toBeNull()
  })

  it('offers no full output for a row the server sent whole', () => {
    renderTurn()
    open('small')
    expect(resultText('small')).toBe('short')
    expect(document.querySelector('[data-tool-id="small"]')?.textContent).not.toContain('Show full output')
  })

  it('keeps the clipped text and offers a retry when the fetch fails', async () => {
    vi.mocked(api.fetchToolResult).mockRejectedValue(new Error('offline'))
    renderTurn()
    open('big')
    fireEvent.click(screen.getByRole('button', { name: 'Show full output' }))
    await screen.findByRole('button', { name: 'Retry' })
    expect(resultText('big')).toBe(clipped)
  })
})
