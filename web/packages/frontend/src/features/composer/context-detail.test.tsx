import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query'
import type { ContextDetail } from '@maudecode/talaria-web-contracts'
import { unavailableContextDetail } from '@maudecode/talaria-web-contracts'
import { ContextRing, ContextRow } from './chips'
import { fetchContextDetail } from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { invalidateSessionQueries } from '../../api/sessionQueries'

vi.mock('../../api/endpoints', () => ({ fetchContextDetail: vi.fn() }))
const detail: ContextDetail = { ...unavailableContextDetail(), available: true, reason: null, source: 'local_estimate', estimated: true,
  used_tokens: 3790, window_tokens: 256000, estimated_total: 3500,
  categories: [{ id: 'rules', tokens: 1000, percent: 0.390625, estimated: true }, { id: 'conversation', tokens: 0, percent: 0, estimated: true }],
  files: [{ label: 'AGENTS.md', characters: 4000, tokens: 1000, status: 'loaded', loaded: true }], last_turn_output_tokens: 12 }
const props = { sessionId: 'context-chat', detailKey: 'owner-a', used: 3790, window: 256000, percent: 1 }
const wrapper = (qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) => {
  return ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('context details in the existing inspector', () => {
  it('reads only while open and shares category/provenance/file rows with the phone inspector', async () => {
    vi.mocked(fetchContextDetail).mockResolvedValue(detail)
    vi.mocked(fetchContextDetail).mockClear()
    const onCompress = vi.fn()
    const view = render(<ContextRing {...props} onCompress={onCompress} />, { wrapper: wrapper() })
    expect(fetchContextDetail).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /Context window usage/ }))
    expect(await screen.findByText('Estimated tokens by category')).toBeVisible()
    expect(fetchContextDetail).toHaveBeenCalledWith('context-chat', 'owner-a', expect.any(AbortSignal))
    expect(screen.getByText('Occupancy from local estimate')).toBeVisible()
    expect(screen.getByText('AGENTS.md')).toBeVisible()
    expect(screen.getByText('4,000 characters · ~1,000 tokens')).toBeVisible()
    expect(screen.getByText('Last turn output: 12')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Compress now' }))
    expect(onCompress).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByText('AGENTS.md')).not.toBeInTheDocument())
    view.unmount()
    render(<ContextRow {...props} />, { wrapper: wrapper() })
    expect(await screen.findByText('AGENTS.md')).toBeVisible()
  })

  it('shows categories without a provenance line when the read has no occupancy source', async () => {
    vi.mocked(fetchContextDetail).mockResolvedValue({ ...detail, source: null, estimated: null, used_tokens: null, window_tokens: null, files: [], last_turn_output_tokens: null })
    render(<ContextRow {...props} detailKey="stored-read" />, { wrapper: wrapper() })
    expect(await screen.findByText('Estimated tokens by category')).toBeVisible()
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument()
  })

  it('drops delayed details on context identity changes and never reuses a prior result', async () => {
    let resolve!: (value: ContextDetail) => void
    vi.mocked(fetchContextDetail).mockReturnValueOnce(new Promise((done) => { resolve = done })).mockResolvedValue(unavailableContextDetail('not_built'))
    const view = render(<ContextRow {...props} />, { wrapper: wrapper() })
    await waitFor(() => expect(resolve).toBeDefined())
    view.rerender(<ContextRow {...props} detailKey="owner-b-new-model-compressed" />)
    expect(await screen.findByText('Context details unavailable before the first turn')).toBeVisible()
    resolve(detail)
    await waitFor(() => expect(screen.queryByText('AGENTS.md')).not.toBeInTheDocument())
    view.rerender(<ContextRow {...props} sessionId="foreign-session" detailKey="foreign-profile" />)
    expect(await screen.findByText('Context details unavailable before the first turn')).toBeVisible()
    expect(screen.queryByText('AGENTS.md')).not.toBeInTheDocument()
  })

  it('reads once per opening: session refreshes, focus and reconnect leave the open inspector alone (TAL-1672)', async () => {
    vi.mocked(fetchContextDetail).mockResolvedValue(detail)
    vi.mocked(fetchContextDetail).mockClear()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<ContextRow {...props} />, { wrapper: wrapper(qc) })
    expect(await screen.findByText('AGENTS.md')).toBeVisible()
    // An id-less sessions_changed frame, the session's own refresh, a tab refocus and a reconnect.
    await qc.invalidateQueries({ queryKey: keys.sessions.all })
    await invalidateSessionQueries(qc, props.sessionId)
    focusManager.setFocused(false); focusManager.setFocused(true); focusManager.setFocused(undefined)
    onlineManager.setOnline(false); onlineManager.setOnline(true)
    await waitFor(() => expect(qc.isFetching()).toBe(0))
    expect(fetchContextDetail).toHaveBeenCalledOnce()
  })

  it('reads again when the popover reopens before its close finishes (TAL-1672)', async () => {
    vi.mocked(fetchContextDetail).mockResolvedValue(detail)
    vi.mocked(fetchContextDetail).mockClear()
    render(<ContextRing {...props} />, { wrapper: wrapper() })
    const ring = screen.getByRole('button', { name: /Context window usage/ })
    await userEvent.click(ring)
    expect(await screen.findByText('AGENTS.md')).toBeVisible()
    // A running exit transition: Base UI keeps the popup, and its details, mounted until this finishes.
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: () => [{ finished: new Promise(() => undefined), pending: true }] })
    try {
      await userEvent.keyboard('{Escape}')
      await waitFor(() => { expect(document.getElementById('ctxPopup')).toHaveAttribute('data-ending-style') })
      await userEvent.click(ring)
      await waitFor(() => expect(fetchContextDetail).toHaveBeenCalledTimes(2))
    } finally {
      delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations
    }
  })
})
