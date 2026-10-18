import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { UpdateNotification, UpdateNotifications } from '../../contracts'

vi.mock('../../api/endpoints', () => ({
  fetchUpdateNotifications: vi.fn(),
  performUpdateNotificationAction: vi.fn(),
  readUpdateNotification: vi.fn(),
  dismissUpdateNotification: vi.fn(),
  clearUpdateNotifications: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('../toast/toast', () => ({ dismissToast: vi.fn(), removeToast: vi.fn(), showRichToast: vi.fn(), showToast: vi.fn() }))
vi.mock('../notices/ServerStoppedOverlay', () => ({ ServerStoppedOverlay: () => null }))
import * as api from '../../api/endpoints'
import { UpdateNotificationProvider, useUpdateProgress } from './UpdateNotificationCenter'

type Step = UpdateNotification['steps'][number]
const AGENT = ['Installing', 'Restarting Talaria Web', 'Restarting gateway', 'Agent responding']
/** Steps as the server derives them: everything before `at` done, `at` in `state`, the rest pending. */
const IDS: Record<number, Step['id'][]> = { 3: ['install', 'web_restart', 'ready'], 4: ['install', 'web_restart', 'gateway_restart', 'agent_ready'], 5: ['install', 'web_restart', 'gateway_wait', 'gateway_restart', 'agent_ready'] }
const steps = (labels: string[], at: number, state: Step['state'] = 'active'): Step[] => labels.map((label, index) => ({
  id: IDS[labels.length]![index]!, label, state: index < at ? 'done' : index > at ? 'pending' : state,
}))
let stamp = 0
/** A synthetic server record; each call is a newer revision, as the server's `updated_at` would be. */
const record = (overrides: Partial<UpdateNotification>): UpdateNotification => ({
  id: '00000000-0000-4000-8000-000000000301', kind: 'update', target: 'agent', phase: 'applying', severity: 'info',
  persistent: false, requires_acknowledgement: false, actions: [], destination: { key: 'settings.system', label: 'Open System settings' },
  title: 'Hermes Agent update', message: 'Installing the selected Hermes Agent update.',
  created_at: '2026-10-18T12:00:00Z', updated_at: new Date(Date.parse('2026-10-18T12:00:00Z') + (stamp += 1) * 1000).toISOString(),
  read_at: null, acknowledged_at: null, acknowledged_action_id: null, verified_revision: null, verified_version: null, detail: null,
  unread: true, active: false, requires_interaction: false, can_dismiss: true,
  steps: steps(AGENT, 0), presents_dialog: true, dialog_close: 'none', ...overrides,
})
const server = { rows: [] as UpdateNotification[], tabUpdate: null as UpdateNotification | null }
const list = (): UpdateNotifications => ({
  scope_id: 'owner-a', frontend_build: { current_build: null, loaded_build: null, refresh_required: false, notification_id: null },
  notifications: server.rows, tab_update: server.tabUpdate, tab_joined_at: server.tabUpdate ? '2026-10-18T12:00:00Z' : null,
  unread_count: 0, clearable_count: 0, can_clear: false,
})

function UpdateButton({ target }: { target: 'webui' | 'agent' }) {
  const progress = useUpdateProgress()
  return <button type="button" onClick={() => { progress?.begin(target) }}>Start {target}</button>
}

let qc: QueryClient
/** Mounts the provider and waits for its first read, so each `serve` is a fresh read. */
async function renderProvider() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const view = render(<QueryClientProvider client={qc}><UpdateNotificationProvider><UpdateButton target="webui" /><UpdateButton target="agent" /></UpdateNotificationProvider></QueryClientProvider>)
  await waitFor(() => { expect(qc.getQueryCache().getAll()[0]?.state.status).toBe('success') })
  return view
}
/** The server now answers `rows`; the tab reads it at once rather than waiting for the next poll. */
async function serve(rows: UpdateNotification[], tabUpdate: UpdateNotification | null = rows[0] ?? null) {
  server.rows = rows
  server.tabUpdate = tabUpdate
  await act(async () => { await qc.refetchQueries() })
  // React Query notifies its observers on the next macrotask.
  await act(() => new Promise((resolve) => { setTimeout(resolve, 0) }))
}
const updating = (name: string) => screen.queryByRole('dialog', { name: `Updating ${name}` })
const stepTexts = (name: string) => within(screen.getByRole('dialog', { name: `Updating ${name}` })).getAllByRole('listitem').map((item) => item.textContent)

const reload = vi.fn()
beforeEach(() => {
  server.rows = []
  server.tabUpdate = null
  vi.mocked(api.fetchUpdateNotifications).mockReset().mockImplementation(() => Promise.resolve(list()))
  vi.mocked(api.performUpdateNotificationAction).mockReset().mockImplementation((id) => Promise.resolve(server.rows.find((row) => row.id === id)!))
  vi.stubGlobal('location', { href: 'http://localhost/settings/system', reload })
  reload.mockReset()
})
afterEach(() => { vi.unstubAllGlobals() })

describe('UpdateNotificationProvider Updating dialog (TAL-1138)', () => {
  it('runs a Web update in one dialog that cannot be closed until Reload', async () => {
    const WEB = ['Installing', 'Restarting Talaria Web', 'Ready']
    const web = (overrides: Partial<UpdateNotification>) => record({ id: '00000000-0000-4000-8000-000000000302', target: 'webui', title: 'Talaria Web update', ...overrides })
    await renderProvider()
    await userEvent.click(screen.getByRole('button', { name: 'Start webui' }))
    expect(updating('Talaria Web')).toHaveTextContent('Starting the update')
    expect(within(updating('Talaria Web')!).queryByRole('button')).toBeNull()
    await userEvent.keyboard('{Escape}')
    expect(updating('Talaria Web')).toBeVisible()
    await serve([web({ steps: steps(WEB, 0) })])
    expect(stepTexts('Talaria Web')).toEqual(WEB)
    await serve([web({ phase: 'restarting', steps: steps(WEB, 1) })])
    await serve([web({ phase: 'succeeded', steps: steps(['Installing', 'Restarting Talaria Web', 'Talaria Web 1.4.0 is ready'], 3), actions: [{ id: 'reload', label: 'Reload', style: 'primary', acknowledges: false }] })])
    const dialog = updating('Talaria Web')!
    expect(stepTexts('Talaria Web').at(-1)).toBe('Talaria Web 1.4.0 is ready')
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(['Reload'])
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reload' }))
    expect(api.performUpdateNotificationAction).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000302', 'reload')
    await waitFor(() => { expect(reload).toHaveBeenCalledOnce() })
  })

  it('opens for an Agent update the server presents and closes itself once the Agent responds', async () => {
    await renderProvider()
    await serve([record({ phase: 'verifying', active: true, steps: steps(AGENT, 3) })], null)
    expect(stepTexts('Hermes Agent')).toEqual(AGENT)
    expect(within(updating('Hermes Agent')!).queryByRole('button')).toBeNull()
    await serve([record({ phase: 'succeeded', presents_dialog: false, dialog_close: 'auto', steps: steps([...AGENT.slice(0, 3), 'Hermes Agent v0.22.1 is running'], 4) })], null)
    expect(updating('Hermes Agent')).toHaveTextContent('Hermes Agent v0.22.1 is running')
    await waitFor(() => { expect(updating('Hermes Agent')).toBeNull() }, { timeout: 4_000 })
    await serve(server.rows, null)
    expect(updating('Hermes Agent')).toBeNull()
  })

  it('Restart now and Restart later act on the wait, and the deferred restart reopens the dialog until it succeeds', async () => {
    const WAIT = ['Installing', 'Restarting Talaria Web', 'Waiting for 2 gateway tasks', 'Restarting gateway', 'Agent responding']
    const wait = record({
      phase: 'waiting_for_idle', presents_dialog: false, dialog_close: 'restart_later', can_dismiss: false, steps: steps(WAIT, 2),
      actions: [{ id: 'restart_gateway_now', label: 'Restart now', style: 'destructive', acknowledges: false }],
    })
    await renderProvider()
    await userEvent.click(screen.getByRole('button', { name: 'Start agent' }))
    await serve([wait])
    const dialog = updating('Hermes Agent')!
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restart now' }))
    expect(api.performUpdateNotificationAction).toHaveBeenCalledWith(wait.id, 'restart_gateway_now')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restart later' }))
    expect(updating('Hermes Agent')).toBeNull()
    // The wait goes on in the bell; the closed dialog stays closed.
    await serve([{ ...wait, updated_at: record({}).updated_at, steps: steps([...WAIT.slice(0, 2), 'Waiting for 1 gateway task', ...WAIT.slice(3)], 2) }])
    expect(updating('Hermes Agent')).toBeNull()

    await serve([record({ phase: 'restarting', active: true, steps: steps(WAIT, 3) })])
    expect(within(updating('Hermes Agent')!).getAllByRole('listitem')[3]).toHaveAttribute('aria-current', 'step')
    expect(within(updating('Hermes Agent')!).queryByRole('button')).toBeNull()
    await serve([record({ phase: 'verifying', active: true, steps: steps(WAIT, 4) })])
    await serve([record({ phase: 'succeeded', presents_dialog: false, dialog_close: 'auto', steps: steps(WAIT, 5) })])
    await waitFor(() => { expect(updating('Hermes Agent')).toBeNull() }, { timeout: 4_000 })
  })

  it('shows a failure with Close, and a later read or reload never reopens it', async () => {
    const failed = record({
      phase: 'failed', presents_dialog: false, dialog_close: 'close', message: 'The update could not be completed.',
      detail: 'Hermes Agent was updated, but the gateway did not come back. Run `hermes gateway restart` manually.', steps: steps(AGENT, 3, 'failed'),
    })
    const view = await renderProvider()
    await serve([record({ phase: 'verifying', active: true, steps: steps(AGENT, 3) })])
    await serve([failed])
    const dialog = updating('Hermes Agent')!
    expect(within(dialog).getAllByRole('listitem').at(-1)).toHaveTextContent('the gateway did not come back')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(updating('Hermes Agent')).toBeNull()
    await serve([failed])
    expect(updating('Hermes Agent')).toBeNull()
    view.unmount()
    await renderProvider()
    await serve([failed])
    expect(updating('Hermes Agent')).toBeNull()
  })
})
