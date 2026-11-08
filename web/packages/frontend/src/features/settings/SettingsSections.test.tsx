import { describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const titleTask = { task: 'title_generation', label: 'Title generation', description: 'session titles', provider: 'auto', model: '', is_auto: true, value_label: 'Claude Sonnet 4.6', provider_label: 'Anthropic', selected_option_id: null, in_catalog: true, inherit_from: null, reasoning_effort: '' }
// Every other endpoint stays pending, so a page's other lists sit in their loading state.
vi.mock('../../api/endpoints', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return {
    ...Object.fromEntries(Object.entries(real).map(([name, value]) => [name, typeof value === 'function' ? vi.fn(() => new Promise(() => undefined)) : value])),
    fetchSettings: vi.fn(() => Promise.resolve({ default_model: 'claude-sonnet-4-6', confirm_external_links: true, trusted_link_hosts: ['docs.example.com'] })),
    saveSettings: vi.fn((patch: Record<string, unknown>) => Promise.resolve(patch)),
    fetchModels: vi.fn(() => Promise.resolve({ groups: [] })),
    setDefaultModel: vi.fn(),
    fetchAuxiliaryModels: vi.fn(() => Promise.resolve({ main: {}, tasks: [titleTask] })),
    setAuxiliaryModel: vi.fn(),
  }
})
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
// Records which settings fields a rendered page reads.
const reads = vi.hoisted(() => new Set<string>())
vi.mock('../../app/settings', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../app/settings')>()
  return {
    ...real,
    useSettingsQuery: (fields?: readonly string[]) => {
      const result = real.useSettingsQuery(fields)
      const data = result.data
      return data ? { ...result, data: new Proxy(data, { get: (target, key) => { if (typeof key === 'string') reads.add(key); return Reflect.get(target, key) } }) } : result
    },
  }
})
import { SettingsSectionSchema, type SettingsSectionId } from '@maudecode/talaria-web-contracts'
import { saveSettings, fetchAuxiliaryModels, fetchModels, fetchSettings, setDefaultModel, fetchConnectorsAvailable } from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { BootstrapContext } from '../../app/bootstrap'
import { DEFAULT_BOOTSTRAP } from '../../contracts/adapters/memory'
import { SettingsSection } from './SettingsSection'
import { ModelsSection } from './ModelsSection'
import { NotificationsSection } from './NotificationsSection'
import { PrivacySettings } from './PrivacySettings'
import { AgentSection } from './AgentSection'

const renderSection = (ui: ReactElement, canManage = true, qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) => {
  const bootstrap = { ...DEFAULT_BOOTSTRAP, auth: { ...DEFAULT_BOOTSTRAP.auth, can_manage_server: canManage } }
  return render(<QueryClientProvider client={qc}><BootstrapContext.Provider value={bootstrap}>{ui}</BootstrapContext.Provider></QueryClientProvider>)
}

/**
 * TAL-1691: every field the retired Preferences, Conversation and System pages edited, and the one section that now
 * edits it. A key is a settings field; a selector is a control with no settings field of its own.
 */
const PLACEMENT: Record<string, SettingsSectionId> = {
  sidebar_density: 'appearance',
  send_key: 'chat', default_message_mode: 'chat', large_text_paste_as_attachment: 'chat', chat_activity_display_mode: 'chat', transparent_stream_event_timestamps: 'chat',
  worklog_details_expanded_default: 'chat', auto_scroll_follow: 'chat', render_user_markdown: 'chat', fade_text_effect: 'chat', virtualize_transcript: 'chat',
  show_busy_placeholder_hint: 'chat', show_token_usage: 'chat', show_tps: 'chat', structured_code_default_view: 'chat', structured_code_auto_tree_lines: 'chat',
  max_tokens: 'chat', compression_prepare_ahead: 'chat', group_discussion_max_rounds: 'chat', group_discussion_max_messages: 'chat', auto_title_refresh_every: 'chat',
  pinned_sessions_limit: 'sidebar', session_endless_scroll: 'sidebar', session_jump_buttons: 'sidebar', show_conversation_outline: 'sidebar', project_quick_create_buttons: 'sidebar',
  show_cli_sessions: 'sidebar', show_claude_code_sessions: 'sidebar', show_cron_sessions: 'sidebar', show_webhook_sessions: 'sidebar', show_kanban_sessions: 'sidebar',
  show_previous_messaging_sessions: 'sidebar', hidden_tabs: 'sidebar', show_titlebar_profile: 'sidebar', show_sidebar_feedback: 'sidebar', show_quota_chip: 'sidebar',
  '#settingsSidebarQuotas': 'sidebar', workspace_panel_open: 'sidebar', workspace_todos_tab: 'sidebar', new_chat_on_workspace_switch: 'sidebar',
  terminal_auto_expand_on_output: 'sidebar', screen_reader_mode: 'sidebar',
  default_model: 'models', '#settingsModel': 'models', '[data-group="auxiliary"]': 'models',
  notifications_enabled: 'notifications', sound_enabled: 'notifications', '#completionSound': 'notifications',
  agent_approvals: 'agent',
  sync_to_insights: 'system', api_redact_enabled: 'system', confirm_external_links: 'system', trusted_link_hosts: 'system', bot_name: 'system',
  update_channel: 'system', agent_update_channel: 'system', ignore_agent_updates: 'system', check_for_updates: 'system', auto_apply_updates: 'system',
  summarize_updates_automatically: 'system', auth_disabled_acknowledged: 'system',
}
const isControl = (key: string) => key.startsWith('#') || key.startsWith('[')
const CONTROLS = Object.keys(PLACEMENT).filter(isControl)

it('edits every retired Preferences, Conversation and System field on exactly its one new section (TAL-1691)', async () => {
  // jsdom has no matchMedia; Appearance reads the colour scheme.
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
  const settings = Object.fromEntries(Object.keys(PLACEMENT).filter((key) => !isControl(key)).map((key) => [key, false]))
  Object.assign(settings, { hidden_tabs: [], trusted_link_hosts: [], group_discussion_max_rounds: 3, group_discussion_max_messages: 10, auth_enabled: false })
  const found: Record<string, SettingsSectionId[]> = {}
  for (const section of SettingsSectionSchema.options) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(keys.settings, settings)
    reads.clear()
    const view = renderSection(<SettingsSection section={section} />, true, qc)
    await waitFor(() => expect(view.container.querySelector(`[data-section="${section}"]`)).not.toBeNull())
    for (const control of CONTROLS) if (view.container.querySelector(control)) reads.add(control)
    for (const key of reads) if (key in PLACEMENT) (found[key] ??= []).push(section)
    view.unmount()
  }
  vi.unstubAllGlobals()
  expect(found).toEqual(Object.fromEntries(Object.entries(PLACEMENT).map(([key, section]) => [key, [section]])))
})

describe('settings pages', () => {
  it('edits the external-link confirmation and trusted hosts through settings (TAL-279)', async () => {
    renderSection(<PrivacySettings />)
    const confirm = await screen.findByRole('switch', { name: 'Confirm before opening external links' })
    expect(confirm).toBeChecked()
    await userEvent.click(confirm)
    expect(saveSettings).toHaveBeenLastCalledWith({ confirm_external_links: false })
    const hosts = screen.getByLabelText('Trusted link hosts')
    expect(hosts).toHaveValue('docs.example.com')
    await userEvent.type(hosts, '\nAPI.Example.com')
    await userEvent.click(within(hosts.closest('form')!).getByRole('button', { name: 'Save' }))
    expect(saveSettings).toHaveBeenLastCalledWith({ trusted_link_hosts: ['docs.example.com', 'API.Example.com'] })
  })

  it('shows the profile\'s agent approvals setting as the server reports it and writes it (TAL-1169)', async () => {
    vi.mocked(fetchSettings).mockResolvedValueOnce({ default_model: 'claude-sonnet-4-6', agent_approvals: true })
    renderSection(<AgentSection />)
    const toggle = await screen.findByRole('switch', { name: 'Let agents approve or deny other chats\' commands' })
    expect(toggle).toBeChecked()
    await userEvent.click(toggle)
    expect(saveSettings).toHaveBeenLastCalledWith({ agent_approvals: false })
  })

  it('lets only a server owner change link safety and redaction (TAL-279, TAL-1880)', async () => {
    renderSection(<PrivacySettings />, false)
    expect(await screen.findByRole('switch', { name: 'Confirm before opening external links' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByLabelText('Trusted link hosts')).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Redact sensitive data in API responses' })).toHaveAttribute('aria-disabled', 'true')
  })
})

it('renders and saves only the server-provided speed tiers (TAL-788)', async () => {
  vi.mocked(fetchAuxiliaryModels).mockResolvedValue({ main: { model: 'gpt-6-astra', provider: 'openai-codex', service_tier: 'priority', supported_speed_tiers: [
    { id: 'standard', service_tier: 'default' }, { id: 'priority', service_tier: 'priority' }, { id: 'ultrafast', service_tier: 'ultrafast' },
  ] }, tasks: [] })
  vi.mocked(setDefaultModel).mockResolvedValue({ ok: true, model: 'gpt-6-astra', provider: 'openai-codex' })
  renderSection(<ModelsSection />)
  const speed = await screen.findByRole('combobox', { name: 'Speed' })
  expect(speed).toHaveTextContent('Fast')
  await userEvent.click(speed)
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Standard', 'Fast', 'Ultrafast'])
  await userEvent.click(screen.getByRole('option', { name: 'Ultrafast' }))
  expect(setDefaultModel).toHaveBeenCalledWith('gpt-6-astra', 'openai-codex', { service_tier: 'ultrafast' })
})

it('shows a chosen speed and default model at once, sending the shown model with the speed (TAL-1179)', async () => {
  vi.mocked(fetchAuxiliaryModels).mockResolvedValue({ main: { model: 'gpt-6-astra', provider: 'openai-codex', service_tier: 'priority', supported_speed_tiers: [
    { id: 'standard', service_tier: 'default' }, { id: 'priority', service_tier: 'priority' },
  ] }, tasks: [] })
  vi.mocked(fetchModels).mockResolvedValue({ groups: [{ provider: 'OpenAI Codex', provider_id: 'openai-codex', models: [{ id: '@openai-codex:gpt-6-astra', label: 'GPT-6 Astra', provider_id: 'openai-codex' }, { id: '@openai-codex:gpt-5.6-sol', label: 'GPT-5.6 Sol', provider_id: 'openai-codex', supported_speed_tiers: [{ id: 'standard', service_tier: 'default' }, { id: 'priority', service_tier: 'priority' }] }] }] })
  vi.mocked(setDefaultModel).mockReturnValue(new Promise(() => undefined))
  renderSection(<ModelsSection />)
  const model = await screen.findByRole('combobox', { name: 'Default Model' })
  await userEvent.click(model)
  await userEvent.click(await screen.findByRole('option', { name: 'GPT-5.6 Sol' }))
  expect(setDefaultModel).toHaveBeenLastCalledWith('@openai-codex:gpt-5.6-sol', 'openai-codex', undefined)
  expect(model).toHaveTextContent('GPT-5.6 Sol')
  expect(model).not.toHaveAttribute('data-disabled')
  const speed = screen.getByRole('combobox', { name: 'Speed' })
  await userEvent.click(speed)
  await userEvent.click(await screen.findByRole('option', { name: 'Standard' }))
  expect(speed).toHaveTextContent('Standard')
  expect(model).toHaveTextContent('GPT-5.6 Sol')
  expect(setDefaultModel).toHaveBeenCalledTimes(1)
})

it('rereads the auxiliary slots after the default model changes (TAL-1383)', async () => {
  vi.mocked(fetchAuxiliaryModels).mockResolvedValue({ main: {}, tasks: [] })
  vi.mocked(fetchModels).mockResolvedValue({ groups: [{ provider: 'OpenAI Codex', provider_id: 'openai-codex', models: [{ id: '@openai-codex:gpt-5.6-sol', label: 'GPT-5.6 Sol', provider_id: 'openai-codex' }] }] })
  vi.mocked(setDefaultModel).mockResolvedValue({ ok: true, model: 'gpt-5.6-sol', provider: 'openai-codex' })
  renderSection(<ModelsSection />)
  await waitFor(() => expect(fetchAuxiliaryModels).toHaveBeenCalled())
  const before = vi.mocked(fetchAuxiliaryModels).mock.calls.length
  await userEvent.click(await screen.findByRole('combobox', { name: 'Default Model' }))
  await userEvent.click(await screen.findByRole('option', { name: 'GPT-5.6 Sol' }))
  await waitFor(() => expect(vi.mocked(fetchAuxiliaryModels).mock.calls.length).toBeGreaterThan(before))
})

it('offers the chosen model\'s own speed tiers before the server answers (TAL-1383)', async () => {
  vi.mocked(fetchAuxiliaryModels).mockResolvedValue({ main: { model: 'gpt-6-astra', provider: 'openai-codex', service_tier: 'ultrafast', supported_speed_tiers: [
    { id: 'standard', service_tier: 'default' }, { id: 'ultrafast', service_tier: 'ultrafast' },
  ] }, tasks: [] })
  vi.mocked(fetchModels).mockResolvedValue({ groups: [{ provider: 'OpenAI Codex', provider_id: 'openai-codex', models: [
    { id: '@openai-codex:gpt-6-astra', label: 'GPT-6 Astra', provider_id: 'openai-codex' },
    { id: '@openai-codex:gpt-5.6-sol', label: 'GPT-5.6 Sol', provider_id: 'openai-codex', supported_speed_tiers: [{ id: 'standard', service_tier: 'default' }, { id: 'priority', service_tier: 'priority' }] },
  ] }] })
  vi.mocked(setDefaultModel).mockReturnValue(new Promise(() => undefined))
  renderSection(<ModelsSection />)
  await userEvent.click(await screen.findByRole('combobox', { name: 'Default Model' }))
  await userEvent.click(await screen.findByRole('option', { name: 'GPT-5.6 Sol' }))
  await userEvent.click(screen.getByRole('combobox', { name: 'Speed' }))
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Standard', 'Fast'])
})

it('offers device-local completion sound presets and explicit preview', async () => {
  renderSection(<NotificationsSection />)
  expect(await screen.findByRole('combobox', { name: 'Completion sound' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Preview sound' })).toBeInTheDocument()
})

it('shows a failed connectors gate with a retry on the Connectors tab instead of loading forever (TAL-1691)', async () => {
  vi.mocked(fetchConnectorsAvailable).mockRejectedValueOnce(new Error('gate down'))
  renderSection(<AgentSection tab="connectors" />)
  expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'Plugins' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.queryByRole('tab', { name: 'Connectors' })).toBeNull()
})
