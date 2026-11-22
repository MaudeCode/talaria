import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionBotDeliveries } from '@maudecode/talaria-web-contracts'

vi.mock('../../api/endpoints', () => ({ fetchBotDeliveries: vi.fn() }))
import * as api from '../../api/endpoints'
import { ApiError } from '../../contracts/common'
import { BotDeliveriesCard, useBotDeliveries } from './BotDeliveries'

const shared = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../contracts/fixtures/bot-deliveries.json'), 'utf8')) as Record<'available' | 'unavailable' | 'not_bot_chat', SessionBotDeliveries>

function Chat() {
  const deliveries = useBotDeliveries('bot-chat-tip').data ?? []
  return deliveries.length ? <BotDeliveriesCard deliveries={deliveries} /> : <p>none</p>
}

function renderChat(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><Chat /></QueryClientProvider>)
  return qc
}

const rows = () => within(screen.getByRole('region', { name: 'Teammate requests' })).getAllByRole('listitem')

beforeEach(() => { vi.mocked(api.fetchBotDeliveries).mockReset() })

describe('Teammate requests in the Bot Chat (TAL-2684)', () => {
  it('lists each request with its teammate and the state the server named', async () => {
    vi.mocked(api.fetchBotDeliveries).mockResolvedValue(shared.available)
    renderChat()
    await screen.findByRole('region', { name: 'Teammate requests' })
    expect(rows().map((row) => [row.dataset.deliveryState, row.textContent])).toEqual([
      ['waiting_on_user', '@scout Which quarter should the summary cover?Waiting on your answer'],
      ['running', '@writer Draft the release announcementWorking'],
      ['running', '@writer Proofread the changelogWorking'],
      ['queued', '@scout Collect the Q3 numbersQueued'],
    ])
    // Read-only: no row offers an action.
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('keeps the last confirmed list when a reread fails', async () => {
    vi.mocked(api.fetchBotDeliveries).mockResolvedValueOnce(shared.available).mockRejectedValue(new ApiError({ kind: 'http', status: 503, path: '/api/session/bot-deliveries', message: 'Could not read', retryable: true }))
    const qc = renderChat()
    await screen.findByRole('region', { name: 'Teammate requests' })
    await act(() => qc.refetchQueries())
    expect(api.fetchBotDeliveries).toHaveBeenCalledTimes(2)
    expect(rows()).toHaveLength(4)
  })

  it.each(['unavailable', 'not_bot_chat'] as const)('shows nothing for %s', async (state) => {
    vi.mocked(api.fetchBotDeliveries).mockResolvedValue(shared[state])
    renderChat()
    expect(await screen.findByText('none')).toBeInTheDocument()
  })
})
