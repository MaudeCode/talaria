import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BootstrapContext } from '../../app/bootstrap'
import { DEFAULT_BOOTSTRAP } from '../../contracts/adapters/memory'
import { ApiError } from '../../contracts/common'
import type { ClarifyPending, Session } from '../../contracts'
import type { LiveTurn } from '../../stream/reducer'
import { keys } from '../../api/queryKeys'

// The server's queue head as `/api/clarify/pending` reports it.
let head: ClarifyPending | null = null
vi.mock(import('../../api/endpoints'), async (importOriginal) => ({
  ...(await importOriginal()), saveDraft: vi.fn(), fetchClarifyPending: vi.fn(() => Promise.resolve({ pending: head, pending_count: head ? 1 : 0 })),
  respondClarify: vi.fn(() => Promise.resolve({ ok: true })), steerChat: vi.fn(() => Promise.resolve({ accepted: true })),
}))
vi.mock(import('../../stream/connection'), async (importOriginal) => ({ ...(await importOriginal()), startTurn: vi.fn(), cancelTurn: vi.fn(() => Promise.resolve(true)) }))
import * as api from '../../api/endpoints'
import * as connection from '../../stream/connection'
import { Composer } from '../composer/Composer'
import { ClarifyCard } from './ClarifyCard'
import { useClarify } from './useClarify'

const noop = (): void => undefined
const session: Session = { session_id: 's1', title: 'Evening', is_streaming: true, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_duplicate: true }
const streaming = { status: 'streaming', clarify: null } as unknown as LiveTurn
const onQueue = vi.fn()
let qc: QueryClient

/** ChatView's clarify wiring: the flyout card above the composer, both driven by one `useClarify`. */
function Chat({ live = streaming }: { live?: LiveTurn }) {
  const clarify = useClarify('s1', live)
  return (
    <>
      {clarify && <ClarifyCard key={clarify.pending.clarify_id} clarify={clarify} />}
      <Composer
        sessionId="s1" session={session} live={live} settings={undefined} onEnsureSession={() => Promise.resolve(session)} onLocalCommand={() => Promise.resolve(false)}
        terminalOpen={false} onToggleTerminal={noop} onModelChange={noop} onWorkspaceChange={noop} onToolsetsChange={noop} onReasoningChange={noop} reasoning={null}
        yolo={false} onToggleYolo={noop} queued={[]} onQueue={onQueue} clarify={clarify}
      />
    </>
  )
}

const tree = (live?: LiveTurn) => <QueryClientProvider client={qc}><BootstrapContext.Provider value={DEFAULT_BOOTSTRAP}><Chat {...(live ? { live } : {})} /></BootstrapContext.Provider></QueryClientProvider>
let view: ReturnType<typeof render>
const renderChat = () => { view = render(tree()); return view }
/** The server's queue head changes: a new head arrives as a chat-stream `clarify` frame, a cleared one on the next poll. */
async function push(next: ClarifyPending | null) {
  head = next
  if (next) view.rerender(tree({ status: 'streaming', clarify: next } as unknown as LiveTurn))
  else await act(() => qc.invalidateQueries({ queryKey: keys.clarify('s1') }))
}

// The server frame for an Agent batch: no top-level question, the questions only as ordered steps.
const batch: ClarifyPending = { clarify_id: 'batch-1', question: '', steps: [
  { qid: 'q0', question: 'What sounds best for a quiet evening?', choices: ['A book (Recommended)', 'A movie'], multi_select: false },
  { qid: 'q1', question: 'Which snacks?', choices: ['Popcorn (Recommended)', 'Tea', 'Chips'], multi_select: true },
] }
const single: ClarifyPending = { clarify_id: 'single-1', question: 'Which env?', steps: [{ qid: 'q0', question: 'Which env?', choices: [], multi_select: false }] }

describe('clarification through the composer (TAL-362)', () => {
  beforeEach(() => {
    window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: noop, removeEventListener: noop })) as unknown as typeof window.matchMedia
    globalThis.ResizeObserver = class { observe = noop; unobserve = noop; disconnect = noop }
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    head = null
    vi.mocked(api.respondClarify).mockReset().mockImplementation(() => { head = null; return Promise.resolve({ ok: true }) })
    vi.mocked(api.steerChat).mockClear()
    vi.mocked(connection.startTurn).mockClear()
    onQueue.mockClear()
  })

  it('shows every batch question, collects keyed answers including multi-select, and keeps the chat draft', async () => {
    renderChat()
    const box = screen.getByRole('textbox')
    await userEvent.type(box, 'my draft')
    await push(batch)
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('What sounds best for a quiet evening?'))
    expect(box).toHaveValue('')
    await userEvent.click(screen.getByRole('button', { name: 'A movie' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Which snacks?')
    expect(screen.getByRole('dialog')).toHaveTextContent('Question 2 of 2')
    // The composer answers the active question; message-only controls leave the footer.
    expect(screen.getByRole('textbox', { name: 'Which snacks?' })).toBe(box)
    expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull()
    // Typed text wins over pressed choices, and picking a choice clears typed text.
    await userEvent.click(screen.getByRole('button', { name: 'Chips' }))
    expect(screen.getByRole('button', { name: 'Chips' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.type(box, 'Nachos')
    expect(screen.getByRole('button', { name: 'Chips' })).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(screen.getByRole('button', { name: 'Popcorn (Recommended)' }))
    expect(box).toHaveValue('')
    await userEvent.click(screen.getByRole('button', { name: 'Tea' }))
    await userEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    await waitFor(() => expect(api.respondClarify).toHaveBeenCalledWith({ session_id: 's1', clarify_id: 'batch-1', answers: { q0: 'A movie', q1: ['Popcorn (Recommended)', 'Tea'] } }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(box).toHaveValue('my draft')
    expect(api.steerChat).not.toHaveBeenCalled()
    expect(connection.startTurn).not.toHaveBeenCalled()
    expect(onQueue).not.toHaveBeenCalled()
  })

  it('sends a typed single answer through the clarify endpoint and keeps it for a retry when the relay fails', async () => {
    vi.mocked(api.respondClarify).mockRejectedValueOnce(new ApiError({ kind: 'http', status: 503, path: 'api/clarify/respond', message: 'relay failed' }))
    // Cold attach or refresh: the prompt is already queued, and the first read of the pending endpoint shows it.
    head = single
    renderChat()
    await screen.findByRole('dialog')
    const box = screen.getByRole('textbox')
    await userEvent.type(box, '/steer prod{Enter}')
    await waitFor(() => expect(api.respondClarify).toHaveBeenCalledTimes(1))
    expect(box).toHaveValue('/steer prod')
    expect(screen.getByRole('dialog')).toHaveTextContent('Which env?')
    await userEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    await waitFor(() => expect(api.respondClarify).toHaveBeenLastCalledWith({ session_id: 's1', clarify_id: 'single-1', answers: { q0: '/steer prod' } }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.steerChat).not.toHaveBeenCalled()
  })

  it('replaces the temporary answer when a new queue head arrives and clears when the server drops the prompt', async () => {
    renderChat()
    await push(single)
    await screen.findByRole('dialog')
    const box = screen.getByRole('textbox')
    await userEvent.type(box, 'half an answer')
    await push(batch)
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('What sounds best for a quiet evening?'))
    expect(box).toHaveValue('')
    await push(null)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.respondClarify).not.toHaveBeenCalled()
  })

  it('drops the prompt once the turn is no longer running', async () => {
    head = single
    const view = renderChat()
    await screen.findByRole('dialog')
    view.rerender(tree({ status: 'done', clarify: null } as unknown as LiveTurn))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
