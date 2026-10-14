import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ConnectorOperationView, ConnectorsPage } from '@maudecode/talaria-web-contracts'

// The shared Web/App fixture the server suite composes (contracts/fixtures/connectors.json).
const shared = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../contracts/fixtures/connectors.json'), 'utf8')) as { page: ConnectorsPage; connect_card: ConnectorOperationView }
const waiting: ConnectorOperationView = { op_id: 'op-page', settled: false, outcome: null, can_continue: false, tool_call_id: null, targets: [
  { name: 'gmail', title: 'Gmail', kind: 'connector', state: 'initiated', detail: '', connect_url: 'https://vendor.example.test/authorize/conn-1', actions: ['skip'], env_fields: [] },
] }
let operation = waiting
vi.mock('../../api/endpoints', () => ({
  fetchConnectors: vi.fn(() => Promise.resolve(shared.page)),
  fetchConnectorTools: vi.fn(),
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
