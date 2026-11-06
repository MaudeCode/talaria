import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ConnectorOperationView, ConnectorsPage } from '@maudecode/talaria-web-contracts'

// The shared Web/App fixture the server suite composes (contracts/fixtures/connectors.json).
const shared = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../contracts/fixtures/connectors.json'), 'utf8')) as { page: ConnectorsPage; connect_card: ConnectorOperationView; native_connection: { view: ConnectorOperationView } }
const offered: ConnectorsPage = { ...shared.page, sign_in_required: false, sign_in_offer: {
  available: true, due: true, visible: true, offer_id: 'offer-1', actions: ['sign_in', 'dismiss'], refresh_after: null,
} }
const waiting: ConnectorOperationView = { op_id: 'op-page', settled: false, outcome: null, can_continue: false, tool_call_id: null, targets: [
  { name: 'gmail', title: 'Gmail', kind: 'connector', state: 'initiated', detail: '', connect_url: 'https://vendor.example.test/authorize/conn-1', launch: null, actions: ['skip'], env_fields: [] },
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
  respondConnectorOperation: vi.fn(({ action }: { action: string }) => { operation = { ...operation, settled: action === 'continue' }; return Promise.resolve(operation) }),
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
    await waitFor(() => expect(api.respondConnectorOperation).toHaveBeenCalledWith({ op_id: 'op-chat', action: 'continue' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Connect apps' })).not.toBeInTheDocument())
  })

  it('shows what an MCP row runs or contacts word for word until it is skipped (TAL-1907)', async () => {
    const launch = shared.connect_card.targets.find((target) => target.name === 'linear')!.launch!
    const remote = { name: 'hosted', title: 'Hosted', kind: 'mcp', state: 'pending', detail: '', connect_url: null, actions: ['approve', 'skip'], env_fields: [], launch: { kind: 'remote', target: 'https://mcp.example.test/sse', env: [], cwd: null } } satisfies ConnectorOperationView['targets'][number]
    const view = { ...shared.connect_card, targets: [...shared.connect_card.targets, remote] }
    operation = view
    const answer = vi.mocked(api.respondConnectorOperation)
    answer.mockImplementationOnce(() => new Promise(() => undefined))
    renderWith(<ConnectCard initial={view} />)
    const card = screen.getByRole('region', { name: 'Connect apps' })
    const lines = (name: string) => [...card.querySelector(`[data-connect-target="${name}"] [data-connect-launch]`)?.children ?? []].map((line) => line.textContent)
    expect(lines('linear')).toEqual([`Runs: ${launch.target}`, `Working dir: ${launch.cwd!}`, `Env: ${launch.env.join(', ')}`])
    expect(lines('hosted')).toEqual(['Connects to: https://mcp.example.test/sse'])
    expect(lines('gmail')).toEqual([])
    await userEvent.click(within(card.querySelector<HTMLElement>('[data-connect-target="linear"]')!).getByRole('button', { name: 'Skip' }))
    expect(lines('linear')).toEqual([])
  })

  it('reads and answers a canonical owner through the view\'s owner, and lets its live frames replace the view (TAL-1317)', async () => {
    const native = shared.native_connection.view
    operation = native
    const read = vi.mocked(api.fetchConnectorOperation)
    const answer = vi.mocked(api.respondConnectorOperation)
    read.mockClear()
    answer.mockClear()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const view = (initial: ConnectorOperationView) => <QueryClientProvider client={qc}><ConnectCard initial={initial} /></QueryClientProvider>
    const { rerender } = render(view(native))
    const card = screen.getByRole('region', { name: 'Connect apps' })
    await userEvent.click(within(within(card).getAllByRole('listitem')[2]!).getByRole('button', { name: 'Try again' }))
    expect(answer).toHaveBeenCalledWith({ op_id: 'op-native', ...native.owner, action: 'retry', target: 'notion', env: {} })
    await waitFor(() => expect(read).toHaveBeenCalledWith('op-native', native.owner), { timeout: 4000 })
    // A live frame moves the same card, and a settled one closes it.
    operation = { ...native, targets: native.targets.map((t) => t.name === 'gmail' ? { ...t, state: 'connected', connect_url: null, actions: [] } : t) }
    rerender(view(operation))
    await waitFor(() => expect(within(card).queryByRole('link', { name: 'Authorize' })).not.toBeInTheDocument())
    rerender(view({ ...operation, settled: true }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Connect apps' })).not.toBeInTheDocument())
  }, 15_000)

  it('wakes the owner on return from an authorization link only while the server offers it (TAL-1317)', async () => {
    const native = shared.native_connection.view
    operation = native
    const answer = vi.mocked(api.respondConnectorOperation)
    answer.mockClear()
    renderWith(<ConnectCard initial={native} />)
    await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve() })
    expect(answer).toHaveBeenCalledWith({ op_id: 'op-native', ...native.owner, action: 'wake' })
  })

  it('never wakes a direct operation (TAL-1317)', async () => {
    operation = shared.connect_card
    const answer = vi.mocked(api.respondConnectorOperation)
    answer.mockClear()
    renderWith(<ConnectCard initial={shared.connect_card} />)
    await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve() })
    expect(answer).not.toHaveBeenCalled()
  })

  it('shows Skip and Continue at once, rolls a refusal back and lets a read decide a lost answer (TAL-1317)', async () => {
    const { ApiError } = await import('../../contracts')
    const native = shared.native_connection.view
    operation = native
    const answer = vi.mocked(api.respondConnectorOperation)
    answer.mockClear()
    let settle!: { resolve: (view: ConnectorOperationView) => void; reject: (reason: Error) => void }
    const held = () => new Promise<ConnectorOperationView>((resolve, reject) => { settle = { resolve, reject } })
    const row = (name: string) => document.querySelector(`[data-connect-target="${name}"]`) as HTMLElement
    renderWith(<ConnectCard initial={native} />)
    const card = screen.getByRole('region', { name: 'Connect apps' })

    // The owner has not answered: the row already shows the choice, and the rest of the card stays usable.
    answer.mockImplementationOnce(held)
    await userEvent.click(within(row('gmail')).getByRole('button', { name: 'Skip' }))
    expect(within(row('gmail')).getByText('Skipped')).toBeInTheDocument()
    expect(within(row('gmail')).queryByRole('link', { name: 'Authorize' })).toBeNull()
    expect(within(card).getByRole('button', { name: 'Continue' })).toBeEnabled()
    expect(within(row('notion')).getByRole('button', { name: 'Try again' })).toBeEnabled()
    // A definite refusal restores the confirmed row.
    await act(async () => { settle.reject(new ApiError({ kind: 'http', status: 409, code: 'operation_refused', message: 'Refused', path: '/api/connectors/operations/op-native', retryable: false })); await Promise.resolve() })
    expect(await within(row('gmail')).findByRole('link', { name: 'Authorize' })).toBeInTheDocument()
    expect(showToast).toHaveBeenCalledWith('Refused', 5000, 'error')

    // The answer is lost: the choice stays until a fresh read decides, and nothing is sent again.
    answer.mockClear()
    answer.mockImplementationOnce(held)
    await userEvent.click(within(row('gmail')).getByRole('button', { name: 'Skip' }))
    operation = { ...native, targets: native.targets.map((t) => t.name === 'gmail' ? { ...t, state: 'skipped', connect_url: null, actions: [] } : t) }
    await act(async () => { settle.reject(new ApiError({ kind: 'network', message: 'Lost', path: '/api/connectors/operations/op-native', retryable: true })); await Promise.resolve() })
    await waitFor(() => expect(vi.mocked(api.fetchConnectorOperation)).toHaveBeenCalled())
    expect(within(row('gmail')).getByText('Skipped')).toBeInTheDocument()
    expect(answer).toHaveBeenCalledTimes(1)

    // Continue closes the card before the owner answers, and a refusal brings it back.
    answer.mockImplementationOnce(held)
    await userEvent.click(within(card).getByRole('button', { name: 'Continue' }))
    expect(screen.queryByRole('region', { name: 'Connect apps' })).toBeNull()
    await act(async () => { settle.reject(new ApiError({ kind: 'http', status: 409, code: 'operation_refused', message: 'Refused', path: '/api/connectors/operations/op-native', retryable: false })); await Promise.resolve() })
    expect(await screen.findByRole('region', { name: 'Connect apps' })).toBeInTheDocument()
  }, 15_000)

  it('keeps a busy state only on the install or authorization control that started it (TAL-1317)', async () => {
    const native = shared.native_connection.view
    operation = native
    const answer = vi.mocked(api.respondConnectorOperation)
    let finish!: (view: ConnectorOperationView) => void
    answer.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    renderWith(<ConnectCard initial={native} />)
    const row = (name: string) => document.querySelector(`[data-connect-target="${name}"]`) as HTMLElement
    await userEvent.click(within(row('notion')).getByRole('button', { name: 'Try again' }))
    expect(within(row('notion')).getByRole('button', { name: 'Try again' })).toBeDisabled()
    expect(within(row('gmail')).getByRole('button', { name: 'Skip' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
    await act(async () => { finish(native); await Promise.resolve() })
    await waitFor(() => expect(within(row('notion')).getByRole('button', { name: 'Try again' })).toBeEnabled())
  })
})
