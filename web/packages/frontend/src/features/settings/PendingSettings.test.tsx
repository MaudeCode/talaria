import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, it, vi } from 'vitest'
import { PreferencesSection } from './PreferencesSection'
import { ConversationSection } from './ConversationSection'
import { BootstrapContext } from '../../app/bootstrap'
import { DEFAULT_BOOTSTRAP } from '../../contracts/adapters/memory'
import { keys } from '../../api/queryKeys'
import { deferred } from '../../test/fixtures'
import * as api from '../../api/endpoints'
import { ApiError } from '../../contracts/common'
import { showToast } from '../toast/toast'

vi.mock('../../api/endpoints', () => ({ fetchSettings: vi.fn(), saveSettings: vi.fn(), fetchModels: vi.fn(), fetchAuxiliaryModels: vi.fn() }))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
const initial = { bot_name: 'Hermes', send_key: 'enter', pinned_sessions_limit: 3, structured_code_auto_tree_lines: 40, max_tokens: null, show_cli_sessions: false, sound_enabled: false }

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.fetchSettings).mockResolvedValue(initial)
  vi.mocked(api.fetchModels).mockResolvedValue({ groups: [] })
  vi.mocked(api.fetchAuxiliaryModels).mockResolvedValue({ main: {}, tasks: [] })
})

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(keys.settings, initial)
  render(<QueryClientProvider client={qc}><BootstrapContext.Provider value={DEFAULT_BOOTSTRAP}><PreferencesSection /><ConversationSection /></BootstrapContext.Provider></QueryClientProvider>)
  return qc
}

it('renders actual preference and conversation controls before their writes finish', async () => {
  vi.mocked(api.saveSettings).mockReturnValue(deferred<typeof initial>().promise)
  setup()
  await userEvent.click(screen.getByRole('combobox', { name: 'Send Key' }))
  await userEvent.click(await screen.findByRole('option', { name: /Ctrl/ }))
  expect(screen.getByRole('combobox', { name: 'Send Key' })).toHaveTextContent(/Ctrl/)
  for (const name of ['Show non-WebUI sessions', 'Notification sound', 'Browser notifications', 'Render markdown in user messages']) {
    const control = screen.getByRole('switch', { name })
    await userEvent.click(control)
    expect(control).toBeChecked()
  }
  fireEvent.change(document.getElementById('settingsPinnedLimit')!, { target: { value: '12' } })
  expect(document.getElementById('settingsPinnedLimit')).toHaveValue(12)
  fireEvent.change(document.getElementById('settingsStructuredCodeAutoLines')!, { target: { value: '80' } })
  expect(document.getElementById('settingsStructuredCodeAutoLines')).toHaveValue(80)
})

it('keeps an empty numeric draft across unrelated refreshes and restores the confirmed value on blur', async () => {
  vi.mocked(api.saveSettings).mockReturnValue(deferred<typeof initial>().promise)
  const qc = setup()
  const input = document.getElementById('settingsPinnedLimit')!
  await userEvent.click(input)
  await userEvent.clear(input)
  expect(input).toHaveValue(null)
  act(() => qc.setQueryData(keys.settings, { ...initial, pinned_sessions_limit: 9 }))
  expect(input).toHaveValue(null)
  await userEvent.tab()
  expect(input).toHaveValue(9)
})

it.each(['normalization', 'failure'] as const)('reconciles the focused numeric draft after its owning save %s', async (outcome) => {
  const held = deferred<typeof initial>()
  vi.mocked(api.saveSettings).mockImplementation(() => held.promise.then((value) => {
    if (outcome === 'failure') throw new Error('Save refused')
    return value
  }))
  setup()
  const input = document.getElementById('settingsPinnedLimit')!
  await userEvent.click(input)
  fireEvent.change(input, { target: { value: '100' } })
  expect(input).toHaveValue(100)
  await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ pinned_sessions_limit: 100 }))
  held.resolve(initial)
  await waitFor(() => expect(input).toHaveValue(3))
  expect(input).toHaveFocus()
})

it('preserves a newer incomplete numeric draft when an older save settles', async () => {
  const held = deferred<typeof initial>()
  vi.mocked(api.saveSettings).mockReturnValue(held.promise)
  setup()
  const input = document.getElementById('settingsPinnedLimit')!
  await userEvent.click(input)
  fireEvent.change(input, { target: { value: '10' } })
  await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ pinned_sessions_limit: 10 }))
  await userEvent.clear(input)
  held.resolve(initial)
  await waitFor(() => expect(api.fetchSettings).toHaveBeenCalled())
  expect(input).toHaveValue(null)
  expect(input).toHaveFocus()
})

it('retains submitted and newer text drafts when a save fails and shows the existing error', async () => {
  const held = deferred<typeof initial>()
  vi.mocked(api.saveSettings).mockImplementation(() => held.promise.then(() => { throw new Error('Save refused') }))
  setup()
  const input = screen.getByLabelText('Default assistant name')
  await userEvent.clear(input)
  await userEvent.type(input, 'Requested name')
  await userEvent.click(within(input.closest('form')!).getByRole('button', { name: 'Save' }))
  expect(input).toHaveValue('Requested name')
  const hosts = screen.getByLabelText('Trusted link hosts')
  await userEvent.type(hosts, 'docs.example.com')
  await userEvent.click(within(hosts.closest('form')!).getByRole('button', { name: 'Save' }))
  await userEvent.type(input, ' with new edits')
  held.resolve(initial)
  await waitFor(() => expect(showToast).toHaveBeenCalledTimes(2))
  expect(showToast).toHaveBeenCalledWith('Save refused', 4000, 'error')
  expect(input).toHaveValue('Requested name with new edits')
})

it('rolls max output tokens back to the confirmed value after a managed config conflict', async () => {
  const held = deferred<typeof initial>()
  const message = 'config.yaml is package-managed. Update the declarative configuration instead.'
  vi.mocked(api.saveSettings).mockReturnValue(held.promise)
  const qc = setup()
  const input = screen.getByLabelText('Max output tokens')
  await userEvent.click(input)
  fireEvent.change(input, { target: { value: '1234' } })
  expect(input).toHaveValue(1234)
  await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ max_tokens: 1234 }))
  held.reject(new ApiError({ kind: 'http', status: 409, path: 'api/settings', message, body: { error: message, condition: 'config_write_refused' } }))
  await waitFor(() => expect(input).toHaveValue(null))
  expect(qc.getQueryData(keys.settings)).toMatchObject({ max_tokens: null })
  expect(showToast).toHaveBeenCalledWith(message, 4000, 'error')
})
