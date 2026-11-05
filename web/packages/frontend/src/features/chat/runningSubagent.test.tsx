import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Message } from '../../contracts'
import { sessionFixture } from '../../test/fixtures'
import { stubAnimate } from '../../test/animate'

vi.mock('../../api/endpoints', async (original) => ({ ...await original<typeof import('../../api/endpoints')>(), fetchSession: vi.fn() }))
vi.mock('../../api/sse', async (original) => ({ ...await original<typeof import('../../api/sse')>(), openSessionStream: vi.fn(() => ({ close: vi.fn(), readyState: () => 1 })) }))
const api = await import('../../api/endpoints')
const { useTranscript } = await import('./useTranscript')
const { Transcript } = await import('./Transcript')

const toolRow = (id: string, done = true) => ({ row_id: `tool:${id}`, role: 'tool', tool: { id, name: 'read_file', kind: 'read', target: id, args: {}, done, is_error: false, result: 'body' } })
const scene = (terminal_state: string, final_answer: string, activity_rows: unknown[], expanded_by_default = false) => ({ version: 'activity_scene_v1', terminal_state, final_answer, activity_rows, expanded_by_default })
/** An earlier turn whose work the server opens by default, then the child's last turn. */
const detail = (last: ReturnType<typeof scene>, refresh_after: number | null) => ({ session: sessionFixture({ session_id: 'child', read_only: true, refresh_after, messages: [
  { id: 1, role: 'user', content: 'First goal', _turn_id: 'first' },
  { id: 2, role: 'assistant', content: '', _turn_id: 'first', _anchor_activity_scene: scene('no_response', '', [toolRow('earlier')], true) },
  { id: 3, role: 'user', content: 'Second goal', _turn_id: 'second' },
  { id: 4, role: 'assistant', content: 'Interim', _turn_id: 'second', _anchor_activity_scene: last },
] as Message[] }) })

function ChildPage() {
  const { rows } = useTranscript('child')
  return <Transcript rows={rows} live={null} assistantName="Assistant" mode="compact_worklog" renderUserMarkdown={false} autoFollow={false} sessionId="child" actions={{}} tts={false} truncated={false} loadedFrom={0} onLoadOlder={vi.fn()} loadingOlder={false} emptyState={null} showJumpButtons={false} virtualizeLongTranscripts={false} disclosureScope="child" />
}

beforeEach(() => {
  vi.useFakeTimers()
  stubAnimate()
  const observer = class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn() }
  vi.stubGlobal('IntersectionObserver', observer)
  vi.stubGlobal('ResizeObserver', observer)
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia
  HTMLElement.prototype.scrollTo = vi.fn()
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear() })

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
/** Delivers a finished read: the query's notifications are themselves timers. */
const settle = () => advance(10)

it('rereads a running child on the server\'s delay until it settles, and keeps the reader\'s collapsed scene shut (TAL-1760)', async () => {
  const running = (ids: string[]) => detail(scene('running', '', ids.map((id, i) => toolRow(id, i < ids.length - 1)), true), 5)
  vi.mocked(api.fetchSession).mockResolvedValue(running(['one']))
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ChildPage /></QueryClientProvider>)
  await settle()
  expect(api.fetchSession).toHaveBeenCalledTimes(1)
  const worklogs = () => [...document.querySelectorAll('[data-tool-worklog-group]')].filter((group) => !group.hasAttribute('data-activity-sequence-group'))
  expect(worklogs().map((group) => group.getAttribute('data-worklog-status'))).toEqual(['no_response', 'running'])

  fireEvent.click(document.querySelector('.tool-worklog-summary')!)
  expect(worklogs()[0]).toHaveAttribute('data-open', '0')

  // Nothing before the server's delay; the new row after it, with the reader's choice intact.
  vi.mocked(api.fetchSession).mockResolvedValue(running(['one', 'two']))
  await advance(4_900)
  expect(api.fetchSession).toHaveBeenCalledTimes(1)
  await advance(100)
  await settle()
  expect(api.fetchSession).toHaveBeenCalledTimes(2)
  expect(document.body.textContent).toContain('two')
  expect(worklogs()[0]).toHaveAttribute('data-open', '0')

  // The child ended: the settled scene arrives and reads stop.
  vi.mocked(api.fetchSession).mockResolvedValue(detail(scene('completed', 'All fixed.', [toolRow('one')]), null))
  await advance(5_000)
  await settle()
  expect(api.fetchSession).toHaveBeenCalledTimes(3)
  expect(screen.getByText('All fixed.')).toBeVisible()
  expect(worklogs()[0]).toHaveAttribute('data-open', '0')
  await advance(60_000)
  expect(api.fetchSession).toHaveBeenCalledTimes(3)
})
