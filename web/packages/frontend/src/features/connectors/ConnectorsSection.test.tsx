import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ConnectorOperationView, ConnectorsPage } from '@maudecode/talaria-web-contracts'

// The shared Web/App fixture the server suite composes (contracts/fixtures/connectors.json).
const shared = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../contracts/fixtures/connectors.json'), 'utf8')) as { page: ConnectorsPage; connect_card: ConnectorOperationView }
const offered: ConnectorsPage = { ...shared.page, sign_in_required: false, sign_in_offer: {
  available: true, due: true, visible: true, offer_id: 'offer-1', actions: ['sign_in', 'dismiss'], refresh_after: null,
} }
const waiting: ConnectorOperationView = { op_id: 'op-page', settled: false, outcome: null, can_continue: false, tool_call_id: null, targets: [
  { name: 'gmail', title: 'Gmail', kind: 'connector', state: 'initiated', detail: '', connect_url: 'https://vendor.example.test/authorize/conn-1', actions: ['skip'], env_fields: [] },
] }
let operation = waiting
vi.mock('../../api/endpoints', () => ({
  fetchConnectors: vi.fn(() => Promise.resolve(shared.page)),
  fetchConnectorTools: vi.fn(),
  dismissConnectorOffer: vi.fn(),
  onboardingOauthStart: vi.fn(),
  onboardingOauthPoll: vi.fn(),
  onboardingOauthCancel: vi.fn(),
  setConnectorRule: vi.fn(() => Promise.resolve({ ok: true, revision: 'rev-8' })),
  connectConnector: vi.fn(() => Promise.resolve(waiting)),
  fetchConnectorOperation: vi.fn(() => Promise.resolve(operation)),
  respondConnectorOperation: vi.fn(({ action }: { action: string }) => Promise.resolve({ ...operation, settled: action === 'continue' })),
  removeConnectorAccount: vi.fn(() => Promise.resolve({ ok: true })),
}))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
import * as api from '../../api/endpoints'
import { showToast } from '../toast/toast'
import { ConnectorsSection } from './ConnectorsSection'
import { ConnectCard } from './ConnectCard'

function renderWith(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('ConnectorsSection (TAL-818)', () => {
  it('offers native scheduled guest sign-in without starting OAuth on page open (TAL-1507)', async () => {
    vi.mocked(api.fetchConnectors).mockResolvedValueOnce(offered)
    renderWith(<ConnectorsSection />)
    expect(await screen.findByRole('button', { name: 'Not now' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Sign in with Nous Portal' })).toBeEnabled()
    expect(api.onboardingOauthStart).not.toHaveBeenCalled()
  })

  it('keeps an unavailable retained offer understandable without enabling sign-in', async () => {
    vi.mocked(api.fetchConnectors).mockResolvedValueOnce({ ...offered, sign_in_offer: {
      ...offered.sign_in_offer!, available: false, due: false, actions: ['dismiss'],
    } })
    renderWith(<ConnectorsSection />)
    expect(await screen.findByRole('button', { name: 'Not now' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Sign in with Nous Portal' })).toBeDisabled()
  })

  it('dismisses immediately, reconciles an unknown outcome, and rolls back a refusal', async () => {
    const hidden: ConnectorsPage = { ...offered, sign_in_offer: { ...offered.sign_in_offer!, visible: false, actions: [] } }
    vi.mocked(api.fetchConnectors).mockResolvedValue(offered)
    let reject!: (reason: Error) => void
    vi.mocked(api.dismissConnectorOffer).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    try {
      renderWith(<ConnectorsSection />)
      await userEvent.click(await screen.findByRole('button', { name: 'Not now' }))
      expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull()
      expect(api.dismissConnectorOffer).toHaveBeenCalledWith('offer-1')
      const { ApiError } = await import('../../contracts')
      act(() => { reject(new ApiError({ kind: 'http', status: 409, message: 'Offer changed', path: '/api/connectors/sign-in-offer/dismiss', retryable: false })) })
      expect(await screen.findByRole('button', { name: 'Not now' })).toBeEnabled()
      // The server accepted the second click, but the response was lost. Its page read decides the display.
      vi.mocked(api.dismissConnectorOffer).mockImplementationOnce(() => {
        vi.mocked(api.fetchConnectors).mockResolvedValue(hidden)
        return Promise.reject(new Error('response lost'))
      })
      await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull())
    } finally { vi.mocked(api.fetchConnectors).mockResolvedValue(shared.page) }
  })

  it('renders the server rows: a locked app is read-only, an editable rule writes from the page revision', async () => {
    renderWith(<ConnectorsSection />)
    const gmail = await screen.findByRole('switch', { name: 'Gmail available to Hermes' })
    expect(gmail).toHaveAttribute('aria-disabled', 'true')
    expect(within(gmail.closest('li')!).getByText('Off by organization rule')).toBeInTheDocument()
    const notion = screen.getByRole('switch', { name: 'Notion available to Hermes' })
    expect(notion).not.toBeChecked()
    expect(within(screen.getByRole('list', { name: 'Notion accounts' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['workDisconnect', 'old@example.testDisconnect'])
    await userEvent.click(notion)
    expect(api.setConnectorRule).toHaveBeenCalledWith('notion', 'rev-7', { enabled: true })
  })

  it('offers existing Nous sign-in when the server requires it, even without a catalog', async () => {
    vi.mocked(api.fetchConnectors).mockResolvedValueOnce({ ...shared.page, connectors: [], sign_in_required: true })
    renderWith(<ConnectorsSection />)
    expect(await screen.findByRole('button', { name: 'Sign in with Nous Portal' })).toBeEnabled()
    expect(screen.queryByText('No connectors available.')).not.toBeInTheDocument()
  })

  it('connects: the authorization link while it waits, then the connected toast once the server reports it', async () => {
    operation = waiting
    renderWith(<ConnectorsSection />)
    const row = (await screen.findByRole('switch', { name: 'Gmail available to Hermes' })).closest('li')!
    await userEvent.click(within(row).getByRole('button', { name: 'Connect' }))
    const link = await within(row).findByRole('link', { name: 'Authorize' })
    expect(link).toHaveAttribute('href', 'https://vendor.example.test/authorize/conn-1')
    expect(within(row).getByText('Waiting for authorization')).toBeInTheDocument()
    operation = { ...waiting, settled: true, outcome: 'connected', targets: [{ ...waiting.targets[0]!, state: 'connected', connect_url: null, actions: [] }] }
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Gmail connected', 3000, 'info'), { timeout: 5000 })
    await waitFor(() => expect(within(row).queryByRole('link', { name: 'Authorize' })).not.toBeInTheDocument())
  })
})

describe('ConnectCard (TAL-818)', () => {
  it('keeps the card and polls on after a failed read; only a gone operation drops it', async () => {
    const { ApiError } = await import('../../contracts')
    const read = vi.mocked(api.fetchConnectorOperation)
    read.mockRejectedValueOnce(new ApiError({ kind: 'http', status: 502, path: '/api/connectors/operations/op-chat', message: 'Bad gateway', retryable: true }))
    renderWith(<ConnectCard initial={shared.connect_card} />)
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1), { timeout: 4000 })
    expect(screen.getByRole('region', { name: 'Connect apps' })).toBeInTheDocument()
    read.mockRejectedValueOnce(new ApiError({ kind: 'http', status: 404, code: 'operation_not_found', path: '/api/connectors/operations/op-chat', message: 'gone', retryable: false }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Connect apps' })).not.toBeInTheDocument(), { timeout: 6000 })
    expect(read).toHaveBeenCalledTimes(2)
  }, 15_000)

  it('shows each app with the moves the server offers and continues the turn', async () => {
    operation = shared.connect_card
    renderWith(<ConnectCard initial={shared.connect_card} />)
    const card = screen.getByRole('region', { name: 'Connect apps' })
    expect(within(card).getByRole('link', { name: 'Authorize' })).toHaveAttribute('href', 'https://vendor.example.test/authorize/conn-2')
    const approve = within(card).getByRole('button', { name: 'Approve' })
    expect(approve).toBeDisabled()
    await userEvent.type(within(card).getByLabelText('API key'), 'lin-key')
    expect(approve).toBeEnabled()
    await userEvent.click(within(card).getByRole('button', { name: 'Continue' }))
    expect(api.respondConnectorOperation).toHaveBeenCalledWith({ op_id: 'op-chat', action: 'continue' })
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Connect apps' })).not.toBeInTheDocument())
  })
})
