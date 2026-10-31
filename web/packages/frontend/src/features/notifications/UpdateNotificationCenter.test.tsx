import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { focusManager, notifyManager, onlineManager, QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
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
import { showRichToast } from '../toast/toast'
import { UpdateNotificationCenterButton, UpdateNotificationProvider, useUpdateProgress, type UpdateProgress } from './UpdateNotificationCenter'
import { ApiError } from '../../contracts/common'
import { keys } from '../../api/queryKeys'

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

  /** TAL-1622: the server holds the refresh notice back while the dialog shows; the tab shows it once the server sends it. */
  it('shows no refresh toast over a Web update whose build changed mid-update, and shows it once the update fails', async () => {
    const WEB = ['Installing', 'Restarting Talaria Web', 'Ready']
    const web = (overrides: Partial<UpdateNotification>) => record({ id: '00000000-0000-4000-8000-000000000303', target: 'webui', title: 'Talaria Web update', ...overrides })
    const refresh = record({
      id: '00000000-0000-4000-8000-000000000304', kind: 'web_refresh', target: 'webui', phase: 'refresh_required', severity: 'warning',
      persistent: true, requires_acknowledgement: true, requires_interaction: true, can_dismiss: false, destination: null, steps: [], presents_dialog: false, dialog_close: 'close',
      title: 'Talaria Web was updated', message: 'Refresh this tab to load the new version.', actions: [{ id: 'reload', label: 'Refresh now', style: 'primary', acknowledges: false }],
    })
    const refreshToasts = () => vi.mocked(showRichToast).mock.calls.filter(([toast]) => toast.id === `server-${refresh.id}`)
    vi.mocked(showRichToast).mockClear()
    await renderProvider()
    await serve([web({ active: true, steps: steps(WEB, 0) })])
    await serve([web({ phase: 'restarting', active: true, steps: steps(WEB, 1) })])
    expect(stepTexts('Talaria Web')).toEqual(WEB)
    expect(refreshToasts()).toEqual([])
    const failed = web({ phase: 'failed', presents_dialog: false, dialog_close: 'close', message: 'The update could not be completed.', steps: steps(WEB, 1, 'failed') })
    await serve([refresh, failed], failed)
    expect(refreshToasts()).toMatchObject([[{ title: 'Talaria Web was updated', ttl: 0, dismissible: false, actions: [{ id: 'reload', label: 'Refresh now' }] }]])
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

describe('notification writes show their result at once (TAL-1179)', () => {
  const finished = (id: string, title: string, extra: Partial<UpdateNotification> = {}) => record({ id, title, phase: 'complete', steps: [], presents_dialog: false, ...extra })
  async function open(rows: UpdateNotification[]) {
    server.rows = rows
    vi.mocked(api.fetchUpdateNotifications).mockImplementation(() => Promise.resolve({ ...list(), unread_count: rows.filter((row) => row.unread).length, clearable_count: rows.filter((row) => row.can_dismiss).length, can_clear: true }))
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(<QueryClientProvider client={qc}><UpdateNotificationProvider><UpdateNotificationCenterButton placement="rail" /></UpdateNotificationProvider></QueryClientProvider>)
    return screen.findByRole('button', { name: 'Notifications' })
  }

  it('clears the badge on open, before the reads answer', async () => {
    vi.mocked(api.readUpdateNotification).mockReturnValue(new Promise(() => undefined))
    const button = await open([finished('a', 'First'), finished('b', 'Second')])
    expect(await screen.findByLabelText('2 unread update notifications')).toBeInTheDocument()
    await userEvent.click(button)
    expect(api.readUpdateNotification).toHaveBeenCalledTimes(2)
    expect(screen.queryByLabelText(/unread update notifications/)).toBeNull()
  })

  it('dismisses a row at once and brings it back when refused', async () => {
    vi.mocked(api.readUpdateNotification).mockReturnValue(new Promise(() => undefined))
    let refuse!: (error: unknown) => void
    vi.mocked(api.dismissUpdateNotification).mockReturnValue(new Promise((_, reject) => { refuse = reject }) as never)
    await userEvent.click(await open([finished('a', 'First'), finished('b', 'Second')]))
    const dialog = within(await screen.findByRole('dialog', { name: 'Notifications' }))
    await userEvent.click(within(dialog.getByText('First').closest('li')!).getByRole('button', { name: 'Dismiss' }))
    expect(dialog.queryByText('First')).toBeNull()
    refuse(new ApiError({ kind: 'http', status: 409, path: '/x', message: 'Still running' }))
    expect(await dialog.findByText('First')).toBeInTheDocument()
  })

  it('clears every dismissible row at once; rows the server keeps return with its answer', async () => {
    vi.mocked(api.readUpdateNotification).mockReturnValue(new Promise(() => undefined))
    let answer!: (value: UpdateNotifications) => void
    vi.mocked(api.clearUpdateNotifications).mockReturnValue(new Promise((resolve) => { answer = resolve }))
    const kept = finished('b', 'Second')
    await userEvent.click(await open([finished('a', 'First'), kept, finished('c', 'Pinned', { can_dismiss: false })]))
    const dialog = within(await screen.findByRole('dialog', { name: 'Notifications' }))
    await userEvent.click(dialog.getByRole('button', { name: 'Clear all' }))
    expect(dialog.queryByText('First')).toBeNull()
    expect(dialog.queryByText('Second')).toBeNull()
    expect(dialog.getByText('Pinned')).toBeInTheDocument()
    server.rows = [kept, finished('c', 'Pinned', { can_dismiss: false })]
    await act(async () => { answer({ ...list(), notifications: server.rows }); await Promise.resolve() })
    expect(await dialog.findByText('Second')).toBeInTheDocument()
    expect(dialog.queryByText('First')).toBeNull()
  })
})

describe('adaptive notification polling (TAL-1246)', () => {
  let progress: UpdateProgress | null
  function Controls() {
    const current = useUpdateProgress()
    useEffect(() => { progress = current }, [current])
    return <UpdateNotificationCenterButton placement="rail" />
  }
  async function advance(ms = 0) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  }
  async function mount() {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(<QueryClientProvider client={qc}><UpdateNotificationProvider><Controls /></UpdateNotificationProvider></QueryClientProvider>)
    await advance()
    expect(api.fetchUpdateNotifications).toHaveBeenCalledOnce()
  }
  beforeEach(() => { vi.useFakeTimers(); notifyManager.setScheduler(queueMicrotask); focusManager.setFocused(true); onlineManager.setOnline(true) })
  afterEach(() => {
    cleanup()
    qc?.clear()
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
    notifyManager.setScheduler((callback) => { setTimeout(callback, 0) })
    vi.useRealTimers()
  })

  it('backs off while idle and still discovers external notifications on the fallback', async () => {
    await mount()
    await advance(29_999)
    expect(api.fetchUpdateNotifications).toHaveBeenCalledOnce()
    server.rows = [record({ active: true })]
    await advance(1)
    expect(api.fetchUpdateNotifications).toHaveBeenCalledTimes(2)
    expect(updating('Hermes Agent')).toBeVisible()
    await advance(2_000)
    expect(api.fetchUpdateNotifications).toHaveBeenCalledTimes(3)
  })

  it.each([
    { active: true, presents_dialog: false },
    { active: false, presents_dialog: true },
  ])('keeps server flags authoritative for cadence: %j', async (flags) => {
    server.rows = [record(flags)]
    await mount()
    await advance(2_000)
    expect(api.fetchUpdateNotifications).toHaveBeenCalledTimes(2)
    expect(updating('Hermes Agent') !== null).toBe(flags.presents_dialog)
  })

  it('fetches immediately on begin and follows active, restart and terminal server states', async () => {
    await mount()
    act(() => { progress!.begin('agent') })
    await advance()
    expect(api.fetchUpdateNotifications).toHaveBeenCalledTimes(2)
    expect(updating('Hermes Agent')).toHaveTextContent('Starting the update')
    server.tabUpdate = record({ active: true })
    await advance(2_000)
    expect(api.fetchUpdateNotifications).toHaveBeenCalledTimes(3)
    server.tabUpdate = record({ active: true, phase: 'restarting' })
    await advance(2_000)
    expect(api.fetchUpdateNotifications).toHaveBeenCalledTimes(4)
    server.tabUpdate = record({ active: false, phase: 'failed', presents_dialog: false, dialog_close: 'close' })
    await advance(2_000)
    expect(api.fetchUpdateNotifications).toHaveBeenCalledTimes(5)
    fireEvent.click(within(updating('Hermes Agent')!).getByRole('button', { name: 'Close' }))
    await advance(29_999)
    expect(api.fetchUpdateNotifications).toHaveBeenCalledTimes(5)
    await advance(1)
    expect(api.fetchUpdateNotifications).toHaveBeenCalledTimes(6)
  })

  it('keeps following the same recovering operation after a dropped response', async () => {
    await mount()
    act(() => { progress!.begin('agent') })
    await advance()
    act(() => { progress!.settle('agent', { failure: new ApiError({ kind: 'network', status: 0, path: '/api/updates/apply', message: 'Lost response' }) }) })
    const recovery = record({ active: true, phase: 'recovering', presents_dialog: true, can_dismiss: false, dialog_close: 'none',
      steps: [{ id: 'recovery', label: 'Attempting recovery', state: 'active' }] })
    server.tabUpdate = recovery
    await advance(2_000)
    expect(updating('Hermes Agent')).toHaveTextContent('Attempting recovery')
    expect(within(updating('Hermes Agent')!).queryByRole('button')).toBeNull()
    const before = vi.mocked(api.fetchUpdateNotifications).mock.calls.length
    await advance(2_000)
    expect(api.fetchUpdateNotifications).toHaveBeenCalledTimes(before + 1)
    server.tabUpdate = { ...recovery, active: false, phase: 'failed', presents_dialog: false, dialog_close: 'close', detail: 'The requested update failed. Service recovered on the previous revision.' }
    await advance(2_000)
    expect(updating('Hermes Agent')).toHaveTextContent('Service recovered on the previous revision')
    expect(api.performUpdateNotificationAction).not.toHaveBeenCalled()
  })

  it('rechecks on inbox open and uses fast polling until it closes', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    await advance()
    expect(api.fetchUpdateNotifications).toHaveBeenCalledTimes(2)
    await advance(2_000)
    expect(api.fetchUpdateNotifications).toHaveBeenCalledTimes(3)
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Notifications' })).getByRole('button', { name: 'Close' }))
    await advance(29_999)
    expect(api.fetchUpdateNotifications).toHaveBeenCalledTimes(3)
    await advance(1)
    expect(api.fetchUpdateNotifications).toHaveBeenCalledTimes(4)
  })

  it.each(['network', 'timeout', 'http'] as const)('keeps an unknown %s start fast through failed reads and recovers without replaying the write', async (kind) => {
    await mount()
    act(() => { progress!.begin('agent') })
    await advance()
    vi.mocked(api.fetchUpdateNotifications).mockRejectedValue(new Error('Server restarting'))
    act(() => { progress!.settle('agent', { failure: new ApiError({ kind, status: kind === 'http' ? 500 : 0, path: '/x', message: 'Lost connection' }) }) })
    await advance()
    expect(updating('Hermes Agent')).toHaveTextContent(/reconnect/i)
    const before = vi.mocked(api.fetchUpdateNotifications).mock.calls.length
    await advance(2_000)
    expect(api.fetchUpdateNotifications).toHaveBeenCalledTimes(before + 1)
    server.tabUpdate = record({ active: true, phase: 'verifying' })
    vi.mocked(api.fetchUpdateNotifications).mockImplementation(() => Promise.resolve(list()))
    await advance(2_000)
    expect(updating('Hermes Agent')).toHaveTextContent('Agent responding')
    expect(api.performUpdateNotificationAction).not.toHaveBeenCalled()
  })

  it('returns a definite start refusal to idle polling after the immediate settle read', async () => {
    await mount()
    act(() => { progress!.begin('agent') })
    await advance()
    act(() => { progress!.settle('agent', { failure: new ApiError({ kind: 'http', status: 409, path: '/x', message: 'Update refused' }) }) })
    await advance()
    expect(updating('Hermes Agent')).toHaveTextContent('Update refused')
    const before = vi.mocked(api.fetchUpdateNotifications).mock.calls.length
    await advance(29_999)
    expect(api.fetchUpdateNotifications).toHaveBeenCalledTimes(before)
    await advance(1)
    expect(api.fetchUpdateNotifications).toHaveBeenCalledTimes(before + 1)
  })

  it.each([false, true])('suppresses hidden and offline polls with active=%s and immediately refreshes on focus and reconnect', async (active) => {
    if (active) server.tabUpdate = record({ active: true })
    await mount()
    act(() => { focusManager.setFocused(false) })
    await advance(60_000)
    expect(api.fetchUpdateNotifications).toHaveBeenCalledOnce()
    act(() => { focusManager.setFocused(true) })
    await advance()
    expect(api.fetchUpdateNotifications).toHaveBeenCalledTimes(2)
    act(() => { onlineManager.setOnline(false) })
    await advance(60_000)
    expect(api.fetchUpdateNotifications).toHaveBeenCalledTimes(2)
    act(() => { onlineManager.setOnline(true) })
    await advance()
    expect(api.fetchUpdateNotifications).toHaveBeenCalledTimes(3)
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true) })
    await advance()
    expect(api.fetchUpdateNotifications).toHaveBeenCalledTimes(4)
  })

  it('immediately rechecks on service-worker takeover', async () => {
    const worker = new EventTarget()
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: worker })
    try {
      await mount()
      act(() => { worker.dispatchEvent(new Event('controllerchange')) })
      await advance()
      expect(api.fetchUpdateNotifications).toHaveBeenCalledTimes(2)
    } finally { cleanup(); Reflect.deleteProperty(navigator, 'serviceWorker') }
  })
})

describe('update status after a server phase change (TAL-1525)', () => {
  it('refetches update status, health and settings once when an update row advances, showing the new installed version', async () => {
    const status = { installed: 'web-v1.0.0' }
    const reads = {
      updates: vi.fn(() => Promise.resolve({ webui: { current_version: status.installed } })),
      system: vi.fn(() => Promise.resolve({})), agent: vi.fn(() => Promise.resolve({})), settings: vi.fn(() => Promise.resolve({})),
    }
    function Installed() {
      const updates = useQuery({ queryKey: keys.updates.check, queryFn: reads.updates, staleTime: Infinity })
      useQuery({ queryKey: keys.health.system, queryFn: reads.system, staleTime: Infinity })
      useQuery({ queryKey: keys.health.agent, queryFn: reads.agent, staleTime: Infinity })
      useQuery({ queryKey: keys.settings, queryFn: reads.settings, staleTime: Infinity })
      return <p>Installed {updates.data?.webui.current_version ?? ''}</p>
    }
    const web = (overrides: Partial<UpdateNotification>) => record({ id: '00000000-0000-4000-8000-000000000303', target: 'webui', title: 'Talaria Web update', ...overrides })
    server.rows = [web({ phase: 'restarting' })]
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(<QueryClientProvider client={qc}><UpdateNotificationProvider><Installed /></UpdateNotificationProvider></QueryClientProvider>)
    await screen.findByText('Installed web-v1.0.0')
    const readNotifications = async () => {
      await act(async () => { await qc.refetchQueries({ queryKey: keys.updateNotifications }) })
      await act(() => new Promise((resolve) => { setTimeout(resolve, 0) }))
    }
    // An unchanged phase reads nothing else.
    await readNotifications()
    for (const read of Object.values(reads)) expect(read).toHaveBeenCalledOnce()
    status.installed = 'web-v2.0.0'
    server.rows = [web({ phase: 'succeeded' })]
    await readNotifications()
    expect(await screen.findByText('Installed web-v2.0.0')).toBeVisible()
    for (const read of Object.values(reads)) expect(read).toHaveBeenCalledTimes(2)
  })
})
