import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { Transcript } from './Transcript'
import { projectMessages } from './useTranscript'
import { initialStreamState, streamReducer, type LiveTurn } from '../../stream/reducer'
import type { Message, Session } from '../../contracts'
import { claimAutoRead } from '../voice/autoReadClaim'
import { BootstrapContext } from '../../app/bootstrap'
import { deferred } from '../../test/fixtures'
import type { Bootstrap } from '../../contracts/bootstrap'
import { speak } from '../voice/tts'

vi.mock(import('../voice/tts'), async (importOriginal) => ({ ...(await importOriginal()), speak: vi.fn(() => Promise.resolve()) }))

// Storage atomicity is exercised with real IndexedDB in speech.spec.ts; this suite owns hook lifecycle.
vi.mock(import('../voice/autoReadClaim'), () => ({ claimAutoRead: vi.fn() }))
const claims = new Set<string>()
let bootstrap: Bootstrap | null = null

const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
beforeEach(() => {
  claims.clear()
  vi.mocked(claimAutoRead).mockImplementation((key) => {
    const owned = !claims.has(key)
    claims.add(key)
    return Promise.resolve(owned)
  })
  bootstrap = { auth: {}, profile: { name: 'default' } } as Bootstrap
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
})
afterEach(() => {
  cleanup()
  vi.mocked(speak).mockClear()
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScroll)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
})

const question: Message = { role: 'user', id: 1, content: 'Inspect', _turn_id: 'run' }
const answer: Message = { role: 'assistant', id: 2, content: 'All files checked.', _turn_id: 'run' }

function turns() {
  const running = streamReducer(initialStreamState, { type: 'start', sessionId: 's', streamId: 'run', turnId: 'run', userMessageId: '1', userText: 'Inspect', now: 0 }).turns.s!
  const session = { session_id: 's', messages: [question, answer] } as Session
  const done = streamReducer({ turns: { s: running } }, { type: 'event', sessionId: 's', streamId: 'run', event: { event: 'done', data: { session } }, lastEventId: 'run:1', now: 1 }).turns.s!
  return { running, done }
}

function View({ messages, live, autoRead }: { messages: Message[]; live: LiveTurn; autoRead: boolean }) {
  return <BootstrapContext.Provider value={bootstrap}><Transcript rows={projectMessages(messages)} live={live} assistantName="Assistant" mode="compact_worklog" renderUserMarkdown={false} autoFollow={false} sessionId="s" actions={{}} tts={false} autoRead={autoRead} truncated={false} loadedFrom={0} onLoadOlder={() => undefined} loadingOlder={false} emptyState={null} showJumpButtons={false} virtualizeLongTranscripts={false} /></BootstrapContext.Provider>
}

describe('auto-read (TAL-568)', () => {
  it('admits one automatic speech request across two readers of the same reply', async () => {
    const { running, done } = turns()
    const first = render(<View messages={[question]} live={running} autoRead />)
    const second = render(<View messages={[question]} live={running} autoRead />)
    first.rerender(<View messages={[question, answer]} live={done} autoRead />)
    second.rerender(<View messages={[question, answer]} live={done} autoRead />)
    await waitFor(() => expect(speak).toHaveBeenCalledExactlyOnceWith('All files checked.'))
  })

  it('speaks the reply once the server persists the turn this view watched', async () => {
    const { running, done } = turns()
    const view = render(<View messages={[question]} live={running} autoRead />)
    expect(speak).not.toHaveBeenCalled()
    view.rerender(<View messages={[question, answer]} live={done} autoRead />)
    await waitFor(() => expect(speak).toHaveBeenCalledExactlyOnceWith('All files checked.'))
    view.rerender(<View messages={[question, { ...answer }]} live={done} autoRead />)
    expect(speak).toHaveBeenCalledOnce()
  })

  it.each(['unmount', 'disabled', 'new turn'] as const)('does not start a pending claim after %s', async (exit) => {
    const claim = deferred<boolean>()
    vi.mocked(claimAutoRead).mockReturnValue(claim.promise)
    const { running, done } = turns()
    const view = render(<View messages={[question]} live={running} autoRead />)
    view.rerender(<View messages={[question, answer]} live={done} autoRead />)
    if (exit === 'unmount') view.unmount()
    else view.rerender(<View messages={[question, answer]} live={exit === 'new turn' ? { ...running, streamId: 'next', turnId: 'next' } : done} autoRead={exit !== 'disabled'} />)
    await act(() => { claim.resolve(true); return claim.promise })
    expect(speak).not.toHaveBeenCalled()
  })

  it('does not replay a claim after a reader remounts', async () => {
    const { running, done } = turns()
    const view = render(<View messages={[question]} live={running} autoRead />)
    view.rerender(<View messages={[question, answer]} live={done} autoRead />)
    await waitFor(() => expect(speak).toHaveBeenCalledOnce())
    view.unmount()
    const next = render(<View messages={[question]} live={running} autoRead />)
    next.rerender(<View messages={[question, answer]} live={done} autoRead />)
    await act(() => Promise.resolve())
    expect(speak).toHaveBeenCalledOnce()
  })

  it('keeps playback quiet when storage fails or bootstrap identity is unknown', async () => {
    const { running, done } = turns()
    vi.mocked(claimAutoRead).mockRejectedValue(new Error('Storage unavailable'))
    const view = render(<View messages={[question]} live={running} autoRead />)
    view.rerender(<View messages={[question, answer]} live={done} autoRead />)
    await act(() => Promise.resolve())
    expect(speak).not.toHaveBeenCalled()
    cleanup()
    bootstrap = null
    const unknown = render(<View messages={[question]} live={running} autoRead />)
    unknown.rerender(<View messages={[question, answer]} live={done} autoRead />)
    await act(() => Promise.resolve())
    expect(speak).not.toHaveBeenCalled()
  })

  it('uses the stable turn id when a replacement stream observes the same reply', async () => {
    const { running, done } = turns()
    const view = render(<View messages={[question]} live={running} autoRead />)
    view.rerender(<View messages={[question, answer]} live={done} autoRead />)
    await waitFor(() => expect(speak).toHaveBeenCalledOnce())
    view.unmount()
    const next = render(<View messages={[question]} live={{ ...running, streamId: 'replacement' }} autoRead />)
    next.rerender(<View messages={[question, answer]} live={{ ...done, streamId: 'replacement' }} autoRead />)
    await act(() => Promise.resolve())
    expect(speak).toHaveBeenCalledOnce()
  })

  it('stays quiet when auto-read is off or the turn finished before the view saw it run', () => {
    const { running, done } = turns()
    const off = render(<View messages={[question]} live={running} autoRead={false} />)
    off.rerender(<View messages={[question, answer]} live={done} autoRead={false} />)
    cleanup()
    render(<View messages={[question, answer]} live={done} autoRead />)
    expect(speak).not.toHaveBeenCalled()
  })
})
