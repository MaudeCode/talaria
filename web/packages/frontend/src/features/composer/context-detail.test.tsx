import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ContextDetail } from '@maudecode/talaria-web-contracts'
import { unavailableContextDetail } from '@maudecode/talaria-web-contracts'
import { ContextRing, ContextRow } from './chips'
import { fetchContextDetail } from '../../api/endpoints'

vi.mock('../../api/endpoints', () => ({ fetchContextDetail: vi.fn() }))
const detail: ContextDetail = { ...unavailableContextDetail(), available: true, reason: null, source: 'local_estimate', estimated: true,
  used_tokens: 3790, window_tokens: 256000, estimated_total: 3500,
  categories: [{ id: 'rules', tokens: 1000, percent: 0.390625, estimated: true }, { id: 'conversation', tokens: 0, percent: 0, estimated: true }],
  files: [{ label: 'AGENTS.md', characters: 4000, tokens: 1000, status: 'loaded', loaded: true }], last_turn_output_tokens: 12 }
const props = { sessionId: 'context-chat', detailKey: 'owner-a', used: 3790, window: 256000, percent: 1 }
const wrapper = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
})
