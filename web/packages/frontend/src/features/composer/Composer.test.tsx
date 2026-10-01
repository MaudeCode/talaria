import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BootstrapContext } from '../../app/bootstrap'
import { DEFAULT_BOOTSTRAP } from '../../contracts/adapters/memory'
import type { Session } from '../../contracts'
import * as api from '../../api/endpoints'
import { dispatch, getStreamState, resetStreamStoreForTests } from '../../stream/store'
import type { LiveTurn } from '../../stream/reducer'
import type { QueuedTurn } from './Composer'

vi.mock(import('../../api/endpoints'), async (importOriginal) => ({ ...(await importOriginal()), saveDraft: vi.fn(), steerChat: vi.fn() }))
import { Composer } from './Composer'

const noop = (): void => undefined
function renderComposer(session: Session, live: LiveTurn | null = null, onQueue: (entry: QueuedTurn) => void = noop) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <BootstrapContext.Provider value={DEFAULT_BOOTSTRAP}>
        <Composer
          sessionId={session.session_id} session={session} live={live} settings={undefined} onEnsureSession={() => Promise.resolve(session)} onLocalCommand={() => Promise.resolve(false)}
          terminalOpen={false} onToggleTerminal={noop} onModelChange={noop} onWorkspaceChange={noop} onToolsetsChange={noop} onReasoningChange={noop} reasoning={null}
          yolo={false} onToggleYolo={noop} queued={[]} onQueue={onQueue}
        />
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  )
}

describe('Composer', () => {
  beforeEach(() => {
    // jsdom has no matchMedia; the composer asks whether it is on a phone-width viewport.
    window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: noop, removeEventListener: noop })) as unknown as typeof window.matchMedia
    globalThis.ResizeObserver = class { observe = noop; unobserve = noop; disconnect = noop }
  })

  it('offers no send, command or session controls for a session the server marks read-only (TAL-312)', () => {
    renderComposer({ session_id: 'child', title: 'Delegated child', is_streaming: false, read_only: true, can_branch: false, can_pin: false, can_archive: false, can_duplicate: false, source_tag: 'subagent' })
    expect(screen.getByRole('note')).toHaveTextContent('read-only')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  })

  const writable: Session = { session_id: 's1', title: 'Mine', is_streaming: true, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_duplicate: true }
  const running = (): LiveTurn => {
    resetStreamStoreForTests()
    dispatch({ type: 'start', sessionId: 's1', streamId: 'run', turnId: 'turn', userMessageId: 'u', userText: 'Inspect', now: 0 })
    return getStreamState().turns.s1!
  }

  it('sends a steer with its id and keeps it in the turn as a pending message the server accepted', async () => {
    vi.mocked(api.steerChat).mockResolvedValue({ accepted: true, steer_id: 'ignored' })
    renderComposer(writable, running())
    await userEvent.type(screen.getByRole('textbox'), 'Check b too{Enter}')
    await waitFor(() => expect(getStreamState().turns.s1!.pendingSteers).toMatchObject([{ text: 'Check b too', state: 'waiting' }]))
    const steerId = getStreamState().turns.s1!.pendingSteers[0]!.steerId
    expect(api.steerChat).toHaveBeenCalledWith({ session_id: 's1', text: 'Check b too', steer_id: steerId })
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('keeps a refused steer in the box and out of the turn', async () => {
    vi.mocked(api.steerChat).mockResolvedValue({ accepted: false, fallback: 'not_running' })
    renderComposer(writable, running())
    await userEvent.type(screen.getByRole('textbox'), 'Check b too{Enter}')
    await waitFor(() => expect(api.steerChat).toHaveBeenCalled())
    await waitFor(() => expect(getStreamState().turns.s1!.pendingSteers).toEqual([]))
    expect(screen.getByRole('textbox')).toHaveValue('Check b too')
  })

  it('queues a steer the turn ended without taking as the next turn, once', () => {
    const onQueue = vi.fn()
    renderComposer(writable, { ...running(), steerLeftovers: [{ steerId: 's1', text: 'Also do y' }] }, onQueue)
    expect(onQueue).toHaveBeenCalledTimes(1)
    expect(onQueue).toHaveBeenCalledWith(expect.objectContaining({ text: 'Also do y', attachments: [] }))
  })

  it('keeps the composer for a writable session', () => {
    renderComposer({ session_id: 'mine', title: 'Mine', is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_duplicate: true })
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(screen.queryByRole('note')).toBeNull()
  })
})
