import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SidebarSection } from './SidebarSection'
import { ChatSection, ChatSubPage } from './ChatSection'
import { NotificationsSection } from './NotificationsSection'
import { PrivacySettings } from './PrivacySettings'
import { LimitsGroup } from './ModelsSection'
import { GroupDiscussionsGroup } from './SystemSection'
import { BootstrapContext } from '../../app/bootstrap'
import { DEFAULT_BOOTSTRAP } from '../../contracts/adapters/memory'
import { keys } from '../../api/queryKeys'
import { deferred } from '../../test/fixtures'
import { renderRouted } from '../../test/router'
import * as api from '../../api/endpoints'
import { ApiError } from '../../contracts/common'
import { showToast } from '../toast/toast'

vi.mock('../../api/endpoints', () => ({ fetchSettings: vi.fn(), saveSettings: vi.fn(), fetchModels: vi.fn(), fetchAuxiliaryModels: vi.fn(), fetchAgentHealth: vi.fn(), restartAgent: vi.fn() }))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
const initial = { bot_name: 'Hermes', send_key: 'enter', pinned_sessions_limit: 3, max_tokens: null, show_cli_sessions: false, sound_enabled: false }
let user: UserEvent

afterEach(() => { vi.unstubAllGlobals() })
beforeEach(() => {
  vi.resetAllMocks()
  // No per-keystroke macrotask yield; the default delay: 0 timed out under full-suite load.
  user = userEvent.setup({ delay: null })
  vi.mocked(api.fetchSettings).mockResolvedValue(initial)
  vi.mocked(api.fetchModels).mockResolvedValue({ groups: [] })
  vi.mocked(api.fetchAuxiliaryModels).mockResolvedValue({ main: {}, tasks: [] })
})

async function setup() {
  // Browser notifications stay enabled only where the browser has notifications (TAL-2146).
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn() })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(keys.settings, initial)
  // TAL-2138: Chat's rarely changed rows sit on its sub-pages. TAL-2160: the profile's limits on Models, Group discussion limits on System.
  await renderRouted(<QueryClientProvider client={qc}><BootstrapContext.Provider value={DEFAULT_BOOTSTRAP}><SidebarSection /><ChatSection /><ChatSubPage page="workspace-panel" /><ChatSubPage page="advanced" /><NotificationsSection /><PrivacySettings /><LimitsGroup /><GroupDiscussionsGroup /></BootstrapContext.Provider></QueryClientProvider>)
  return qc
}

it('renders actual preference and conversation controls before their writes finish', async () => {
  vi.mocked(api.saveSettings).mockReturnValue(deferred<typeof initial>().promise)
  await setup()
  const ctrlEnter = within(screen.getByRole('radiogroup', { name: 'Send with' })).getByRole('radio', { name: 'Ctrl Enter' })
  await user.click(ctrlEnter)
  expect(ctrlEnter).toBeChecked()
  for (const name of ['Terminal and desktop apps', 'Notification sound', 'Browser notifications', 'Format Markdown in my messages', 'Terminal screen reader mode']) {
    const control = screen.getByRole('switch', { name })
    await user.click(control)
    expect(control).toBeChecked()
  }
  fireEvent.change(document.getElementById('settingsPinnedLimit')!, { target: { value: '12' } })
  expect(document.getElementById('settingsPinnedLimit')).toHaveValue(12)
})

it('shows the prepared compaction choice at once and rolls back when the server refuses it (TAL-1825)', async () => {
  vi.mocked(api.fetchSettings).mockResolvedValue({ ...initial, compression_prepare_ahead: false })
  const held = deferred<typeof initial>()
  vi.mocked(api.saveSettings).mockReturnValue(held.promise)
  const qc = await setup()
  qc.setQueryData(keys.settings, { ...initial, compression_prepare_ahead: false })
  const control = await screen.findByRole('switch', { name: 'Prepare compaction in the background' })
  await user.click(control)
  expect(control).toBeChecked()
  await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ compression_prepare_ahead: true }))
  const message = 'config.yaml is package-managed. Update the declarative configuration instead.'
  held.reject(new ApiError({ kind: 'http', status: 409, path: 'api/settings', message, body: { error: message, condition: 'config_write_refused' } }))
  await waitFor(() => expect(control).not.toBeChecked())
  expect(showToast).toHaveBeenCalledWith(message, 4000, 'error')
})

it('offers no prepared compaction choice when the Agent has none (TAL-1825)', async () => {
  const qc = await setup()
  act(() => qc.setQueryData(keys.settings, { ...initial, compression_prepare_ahead: null }))
  expect(screen.queryByRole('switch', { name: 'Prepare compaction in the background' })).toBeNull()
})

const limits = { group_discussion_max_rounds: 3, group_discussion_max_messages: 10, group_discussion_restart_required: false }

it('shows a Group discussion limit at once and rolls back when the server refuses it (TAL-1828)', async () => {
  vi.mocked(api.fetchSettings).mockResolvedValue({ ...initial, ...limits })
  const held = deferred<typeof initial>()
  vi.mocked(api.saveSettings).mockReturnValue(held.promise)
  const qc = await setup()
  act(() => qc.setQueryData(keys.settings, { ...initial, ...limits }))
  const control = await screen.findByRole('spinbutton', { name: 'Rounds per discussion' })
  fireEvent.change(control, { target: { value: '5' } })
  expect(control).toHaveValue(5)
  await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ group_discussion_max_rounds: 5 }))
  const message = 'group_discussion_max_rounds must be a positive integer'
  held.reject(new ApiError({ kind: 'http', status: 400, path: 'api/settings', message, body: { error: message } }))
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(message, 4000, 'error'))
  fireEvent.blur(control)
  await waitFor(() => expect(control).toHaveValue(3))
})

it('offers no Group discussion limits when the server reports them unavailable (TAL-1828)', async () => {
  const qc = await setup()
  act(() => qc.setQueryData(keys.settings, { ...initial, group_discussion_max_rounds: null, group_discussion_max_messages: null, group_discussion_restart_required: null }))
  expect(screen.queryByRole('spinbutton', { name: 'Rounds per discussion' })).toBeNull()
  expect(screen.queryByRole('spinbutton', { name: 'Messages per discussion' })).toBeNull()
})

it('offers the existing restart action only while the server requires one, and rereads settings after it (TAL-1828)', async () => {
  vi.mocked(api.fetchSettings).mockResolvedValue({ ...initial, ...limits, group_discussion_restart_required: true })
  vi.mocked(api.fetchAgentHealth).mockResolvedValue({ alive: true, gateway_lifecycle: { managed: true, reason: 'local_gateway', start_command: null } })
  vi.mocked(api.restartAgent).mockResolvedValue({ ok: true, message: 'restarted' })
  const qc = await setup()
  act(() => qc.setQueryData(keys.settings, { ...initial, ...limits }))
  expect(screen.queryByRole('button', { name: 'Restart agent' })).toBeNull()
  act(() => qc.setQueryData(keys.settings, { ...initial, ...limits, group_discussion_restart_required: true }))
  vi.mocked(api.fetchSettings).mockResolvedValue({ ...initial, ...limits })
  await user.click(await screen.findByRole('button', { name: 'Restart agent' }))
  await waitFor(() => expect(api.restartAgent).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Restart agent' })).toBeNull())
})

it('keeps an empty numeric draft across unrelated refreshes and restores the confirmed value on blur', async () => {
  vi.mocked(api.saveSettings).mockReturnValue(deferred<typeof initial>().promise)
  const qc = await setup()
  const input = document.getElementById('settingsPinnedLimit')!
  await user.click(input)
  await user.clear(input)
  expect(input).toHaveValue(null)
  act(() => qc.setQueryData(keys.settings, { ...initial, pinned_sessions_limit: 9 }))
  expect(input).toHaveValue(null)
  await user.tab()
  expect(input).toHaveValue(9)
})

it.each(['normalization', 'failure'] as const)('reconciles the focused numeric draft after its owning save %s', async (outcome) => {
  const held = deferred<typeof initial>()
  vi.mocked(api.saveSettings).mockImplementation(() => held.promise.then((value) => {
    if (outcome === 'failure') throw new Error('Save refused')
    return value
  }))
  await setup()
  const input = document.getElementById('settingsPinnedLimit')!
  await user.click(input)
  fireEvent.change(input, { target: { value: '100' } })
  expect(input).toHaveValue(100)
  // TAL-2160: above the server's maximum, the row writes the maximum.
  await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ pinned_sessions_limit: 99 }))
  held.resolve(initial)
  await waitFor(() => expect(input).toHaveValue(3))
  expect(input).toHaveFocus()
})

it('preserves a newer incomplete numeric draft when an older save settles', async () => {
  const held = deferred<typeof initial>()
  vi.mocked(api.saveSettings).mockReturnValue(held.promise)
  await setup()
  const input = document.getElementById('settingsPinnedLimit')!
  await user.click(input)
  fireEvent.change(input, { target: { value: '10' } })
  await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ pinned_sessions_limit: 10 }))
  await user.clear(input)
  held.resolve(initial)
  await waitFor(() => expect(api.fetchSettings).toHaveBeenCalled())
  expect(input).toHaveValue(null)
  expect(input).toHaveFocus()
})

it('retains submitted and newer text drafts when a save fails and shows the existing error', async () => {
  const held = deferred<typeof initial>()
  vi.mocked(api.saveSettings).mockImplementation(() => held.promise.then(() => { throw new Error('Save refused') }))
  await setup()
  await user.click(screen.getByRole('button', { name: 'Trusted link hosts' }))
  const hosts = screen.getByRole('textbox', { name: 'Trusted link hosts' })
  await user.type(hosts, 'docs.example.com')
  await user.click(within(hosts.closest('form')!).getByRole('button', { name: 'Save' }))
  expect(hosts).toHaveValue('docs.example.com')
  await user.type(hosts, '{Enter}api.example.com')
  held.resolve(initial)
  await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1))
  expect(showToast).toHaveBeenCalledWith('Save refused', 4000, 'error')
  expect(hosts).toHaveValue('docs.example.com\napi.example.com')
})

it('rolls max output tokens back to the confirmed value after a managed config conflict', async () => {
  const held = deferred<typeof initial>()
  const message = 'config.yaml is package-managed. Update the declarative configuration instead.'
  vi.mocked(api.saveSettings).mockReturnValue(held.promise)
  const qc = await setup()
  const input = screen.getByLabelText('Max output tokens')
  await user.click(input)
  fireEvent.change(input, { target: { value: '1234' } })
  expect(input).toHaveValue(1234)
  await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ max_tokens: 1234 }))
  held.reject(new ApiError({ kind: 'http', status: 409, path: 'api/settings', message, body: { error: message, condition: 'config_write_refused' } }))
  await waitFor(() => expect(input).toHaveValue(null))
  expect(qc.getQueryData(keys.settings)).toMatchObject({ max_tokens: null })
  expect(showToast).toHaveBeenCalledWith(message, 4000, 'error')
})

/** TAL-2160: a viewport `matches` the phone query, else wider. */
const viewport = (phone: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({ matches: phone && query === '(max-width: 640px)', media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))

it.each([[true, 'Ctrl Enter'], [false, 'Enter']])('shows the send rule phones always use, disabled, only at phone width (phone %s, TAL-2160)', async (phone, checked) => {
  viewport(phone)
  await setup()
  const group = screen.getByRole('radiogroup', { name: 'Send with' })
  expect(within(group).getByRole('radio', { name: checked })).toBeChecked()
  for (const radio of within(group).getAllByRole('radio')) if (phone) expect(radio).toBeDisabled(); else expect(radio).toBeEnabled()
})

it('names each title refresh option with its unit and disables it while the profile generates no titles (TAL-2160)', async () => {
  const qc = await setup()
  await user.click(screen.getByRole('combobox', { name: 'Refresh chat titles' }))
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Never', 'Every 5 exchanges', 'Every 10 exchanges', 'Every 20 exchanges'])
  await user.keyboard('{Escape}')
  act(() => qc.setQueryData(keys.settings, { ...initial, auto_title_refresh_available: false }))
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Refresh chat titles' })).toHaveAttribute('data-disabled'))
})

it('shows the output limit a turn uses when the profile sets none (TAL-2160)', async () => {
  const qc = await setup()
  act(() => qc.setQueryData(keys.settings, { ...initial, max_tokens_source: 'agent', max_tokens_effective: 8192 }))
  await waitFor(() => expect(screen.getByLabelText('Max output tokens')).toHaveAttribute('placeholder', 'Agent default: 8,192'))
  act(() => qc.setQueryData(keys.settings, { ...initial, max_tokens_source: 'none', max_tokens_effective: null }))
  await waitFor(() => expect(screen.getByLabelText('Max output tokens')).toHaveAttribute('placeholder', 'No limit set'))
})

it('lets only an owner change the insights sync, and only while a sidecar runs (TAL-2160)', async () => {
  const qc = await setup()
  const sync = () => screen.getByRole('switch', { name: 'Add Talaria chats to the Agent’s insights' })
  expect(sync()).not.toHaveAttribute('aria-disabled')
  act(() => qc.setQueryData(keys.settings, { ...initial, sync_to_insights_available: false }))
  await waitFor(() => expect(sync()).toHaveAttribute('aria-disabled', 'true'))
  cleanup()
  const guest = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  guest.setQueryData(keys.settings, { ...initial, sync_to_insights_available: true })
  await renderRouted(<QueryClientProvider client={guest}><BootstrapContext.Provider value={{ ...DEFAULT_BOOTSTRAP, auth: { ...DEFAULT_BOOTSTRAP.auth, can_manage_server: false } }}><PrivacySettings /></BootstrapContext.Provider></QueryClientProvider>)
  expect(sync()).toHaveAttribute('aria-disabled', 'true')
})
