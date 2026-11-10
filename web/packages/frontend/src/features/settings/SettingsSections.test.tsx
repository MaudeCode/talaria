import { beforeEach, describe, expect, it, vi } from 'vitest'
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
import { saveSettings, fetchAuxiliaryModels, fetchModels, fetchSettings, setDefaultModel, fetchConnectorsAvailable, fetchReasoning, setReasoningEffort, setReasoningDisplay } from '../../api/endpoints'
import { ApiError } from '../../contracts/common'
import { showToast } from '../toast/toast'
import { keys } from '../../api/queryKeys'
import { BootstrapContext } from '../../app/bootstrap'
import { DEFAULT_BOOTSTRAP } from '../../contracts/adapters/memory'
import { SettingsSection } from './SettingsSection'
import { ModelsSection } from './ModelsSection'
import { NotificationsSection } from './NotificationsSection'
import { PrivacySettings } from './PrivacySettings'
import { ToolsSection } from './ToolsSection'

const renderSection = (ui: ReactElement, canManage = true, qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) => {
  const bootstrap = { ...DEFAULT_BOOTSTRAP, auth: { ...DEFAULT_BOOTSTRAP.auth, can_manage_server: canManage } }
  return render(<QueryClientProvider client={qc}><BootstrapContext.Provider value={bootstrap}>{ui}</BootstrapContext.Provider></QueryClientProvider>)
}

/**
 * TAL-1691, TAL-2100, TAL-2075: every field the retired Preferences, Conversation, System and Models & Providers pages edited, and
 * the one section that now edits it. A key is a settings field; a selector is a control with no settings field of its own.
 */
const PLACEMENT: Record<string, SettingsSectionId> = {
  send_key: 'chat', default_message_mode: 'chat', large_text_paste_as_attachment: 'chat', chat_activity_display_mode: 'chat', transparent_stream_event_timestamps: 'chat',
  worklog_details_expanded_default: 'chat', auto_scroll_follow: 'chat', render_user_markdown: 'chat', fade_text_effect: 'chat', virtualize_transcript: 'chat',
  show_busy_placeholder_hint: 'chat', show_token_usage: 'chat', show_tps: 'chat',
  max_tokens: 'chat', compression_prepare_ahead: 'chat', group_discussion_max_rounds: 'chat', group_discussion_max_messages: 'chat', auto_title_refresh_every: 'chat',
  sidebar_density: 'navigation', pinned_sessions_limit: 'navigation', session_endless_scroll: 'chat', session_jump_buttons: 'chat', show_conversation_outline: 'chat', project_quick_create_buttons: 'navigation',
  show_cli_sessions: 'navigation', show_claude_code_sessions: 'navigation', show_cron_sessions: 'navigation', show_webhook_sessions: 'navigation', show_kanban_sessions: 'navigation',
  show_previous_messaging_sessions: 'navigation', hidden_tabs: 'navigation', show_titlebar_profile: 'navigation', show_sidebar_feedback: 'navigation', show_quota_chip: 'chat',
  '[data-group="quotas"]': 'navigation', workspace_panel_open: 'navigation', workspace_todos_tab: 'navigation', new_chat_on_workspace_switch: 'navigation',
  terminal_auto_expand_on_output: 'navigation', screen_reader_mode: 'navigation',
  default_model: 'models', '#settingsModel': 'models', '[data-group="auxiliary"]': 'models', '[data-group="quota-thresholds"]': 'providers',
  notifications_enabled: 'notifications', sound_enabled: 'notifications', '#completionSound': 'notifications',
  agent_approvals: 'tools',
  sync_to_insights: 'access', api_redact_enabled: 'access', confirm_external_links: 'access', trusted_link_hosts: 'access', bot_name: 'access', auth_disabled_acknowledged: 'access',
  update_channel: 'system', agent_update_channel: 'system', ignore_agent_updates: 'system', check_for_updates: 'system', auto_apply_updates: 'system',
  summarize_updates_automatically: 'system', '[data-group="health"]': 'system', '[data-group="server"]': 'system',
}
const isControl = (key: string) => key.startsWith('#') || key.startsWith('[')
const CONTROLS = Object.keys(PLACEMENT).filter(isControl)

it('edits every retired Preferences, Conversation, System and Models & Providers field on exactly its one new section (TAL-1691, TAL-2100)', async () => {
  // jsdom has no matchMedia; Appearance reads the colour scheme.
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
  const settings = Object.fromEntries(Object.keys(PLACEMENT).filter((key) => !isControl(key)).map((key) => [key, false]))
  Object.assign(settings, { provider_quota_thresholds: {}, hidden_tabs: [], trusted_link_hosts: [], group_discussion_max_rounds: 3, group_discussion_max_messages: 10, auth_enabled: false })
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

/** TAL-2075, TAL-2076: every Chat and Navigation row by its label, in page order, with the `data-group` it sits in. */
const GROUPS: Record<'chat' | 'navigation', [string, string][]> = {
  chat: [
    ['Send Key', 'composer'], ['Default message mode', 'composer'], ['Attach large pasted text as file', 'composer'], ['Show busy placeholder hint', 'composer'],
    ['Show provider quota chip in composer', 'composer'],
    ['Model', 'composer-chips'], ['Reasoning', 'composer-chips'], ['Profile', 'composer-chips'], ['Workspace', 'composer-chips'], ['Toolsets', 'composer-chips'],
    ['Attach button', 'composer-controls'], ['Microphone', 'composer-controls'], ['Context ring', 'composer-controls'], ['YOLO mode notice', 'composer-controls'],
    ['Activity display', 'transcript'], ['Show Transparent Stream event timestamps', 'transcript'], ['Open Worklog details automatically', 'transcript'],
    ['Render markdown in user messages', 'transcript'], ['Fade text effect', 'transcript'], ['Show token usage', 'transcript'], ['Show token speed (TPS)', 'transcript'],
    ['Auto-follow new content', 'scrolling'], ['Virtualize long transcripts (experimental)', 'scrolling'], ['Load older messages while scrolling up', 'scrolling'],
    ['Show session jump buttons', 'scrolling'], ['Show conversation outline', 'scrolling'],
    ['Max output tokens', 'limits'], ['Prepare compaction in the background', 'limits'], ['Adaptive title refresh', 'limits'],
    ['Group Chat rounds', 'group-discussions'], ['Group Chat replies', 'group-discussions'],
  ],
  navigation: [
    ['Pinned conversations limit', 'chats'], ['Sidebar density', 'chats'], ['Show per-project new-conversation buttons', 'chats'],
    ['Show CLI and other external sessions', 'sessions'], ['Show Claude Code sessions', 'sessions'], ['Show cron sessions', 'sessions'], ['Show webhook sessions', 'sessions'],
    ['Show kanban sessions', 'sessions'], ['Show previous messaging sessions', 'sessions'],
    ['Tasks', 'destinations'], ['Kanban', 'destinations'], ['Skills', 'destinations'], ['Memory', 'destinations'], ['Discussions', 'destinations'], ['Todos', 'destinations'],
    ['Decisions', 'destinations'], ['Insights', 'destinations'],
    ['Sidebar feedback button', 'buttons'], ['Show profile switcher in titlebar', 'buttons'],
    ['Claude', 'quotas'], ['OpenRouter', 'quotas'],
    ['Keep workspace panel open by default', 'workspace'], ['Show Todos tab in workspace panel', 'workspace'], ['Start a new chat when switching workspace', 'workspace'],
    ['Auto-expand terminal on output', 'workspace'], ['Terminal screen reader mode', 'workspace'],
  ],
}

it('puts each Chat and Navigation row in the group where it applies, each once with its own labelled control (TAL-2075)', async () => {
  const settings = { hidden_tabs: ['kanban'], compression_prepare_ahead: true, group_discussion_max_rounds: 3, group_discussion_max_messages: 10 }
  const quotas = { sources: [{ source_id: 'qsrc_claude', display_name: 'Claude' }, { source_id: 'qsrc_or', display_name: 'OpenRouter' }], sidebar_source_ids: ['qsrc_or'], sidebar_can_pin: true }
  for (const section of ['chat', 'navigation'] as const) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(keys.settings, settings)
    qc.setQueryData(keys.providerQuotas, quotas)
    const view = renderSection(<SettingsSection section={section} />, true, qc)
    await waitFor(() => expect(view.container.querySelector(`[data-section="${section}"]`)).not.toBeNull())
    const labels = [...view.container.querySelectorAll<HTMLLabelElement>(`[data-section="${section}"] label`)]
    expect(labels.map((label) => [label.textContent, label.closest('[data-group]')?.getAttribute('data-group')]), section).toEqual(GROUPS[section])
    for (const label of labels) expect(document.getElementById(label.htmlFor), label.textContent ?? '').not.toBeNull()
    for (const [name, group] of GROUPS[section]) if (group === 'destinations' || group === 'quotas') expect(screen.getByRole('switch', { name })).toBeInTheDocument()
    view.unmount()
  }
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
    renderSection(<ToolsSection />)
    const toggle = await screen.findByRole('switch', { name: 'Let agents approve or deny other chats\' commands' })
    expect(toggle).toBeChecked()
    const approvals = screen.getByRole('region', { name: 'Approvals' })
    expect(within(approvals).getByRole('heading', { name: 'Approvals' })).toBeVisible()
    expect(approvals).toContainElement(toggle)
    expect(approvals.querySelector('#settings-agent_approvals')).not.toBeNull()
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

describe('the profile reasoning defaults (TAL-2078)', () => {
  const status = { show_reasoning: true, reasoning_effort: 'medium', supported_efforts: ['low', 'medium', 'high'], supports_reasoning_effort: true, supports_thinking_toggle: true }
  const refusal = () => new ApiError({ kind: 'http', status: 409, path: '/api/reasoning', message: 'config.yaml is package-managed.' })
  const held = () => { let reject!: (e: unknown) => void; const promise = new Promise<never>((_, r) => { reject = r }); return { promise, reject } }
  const effortRow = () => screen.queryByRole('combobox', { name: 'Default reasoning effort' })
  const thinkingRow = () => screen.queryByRole('switch', { name: 'Show thinking' })
  beforeEach(() => { vi.mocked(fetchAuxiliaryModels).mockResolvedValue({ main: {}, tasks: [] }) })

  it.each([[true, true], [true, false], [false, true], [false, false]])('shows the effort row when effort is supported (%s) and the thinking row when the toggle is (%s)', async (effort, toggle) => {
    vi.mocked(fetchReasoning).mockResolvedValue({ ...status, supports_reasoning_effort: effort, supports_thinking_toggle: toggle })
    renderSection(<ModelsSection />)
    await waitFor(() => expect(fetchReasoning).toHaveBeenCalledWith(undefined, undefined, undefined))
    await waitFor(() => expect(!!effortRow() || !!thinkingRow() || (!effort && !toggle)).toBe(true))
    expect(!!effortRow()).toBe(effort)
    expect(!!thinkingRow()).toBe(toggle)
  })

  it('offers exactly the server\'s efforts with the provider default and saves the profile default without a chat', async () => {
    vi.mocked(fetchReasoning).mockResolvedValue(status)
    vi.mocked(setReasoningEffort).mockImplementation((effort) => {
      vi.mocked(fetchReasoning).mockResolvedValue({ ...status, reasoning_effort: effort })
      return Promise.resolve({ ...status, reasoning_effort: effort })
    })
    renderSection(<ModelsSection />)
    const select = await screen.findByRole('combobox', { name: 'Default reasoning effort' })
    expect(select).toHaveTextContent('medium')
    await userEvent.click(select)
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Default', 'low', 'medium', 'high'])
    await userEvent.click(screen.getByRole('option', { name: 'high' }))
    expect(setReasoningEffort).toHaveBeenCalledWith('high', null, null, undefined)
    await waitFor(() => expect(select).toHaveTextContent('high'))
  })

  it('moves the effort at once and rolls it back with the error toast when the server refuses', async () => {
    vi.mocked(fetchReasoning).mockResolvedValue(status)
    const write = held()
    vi.mocked(setReasoningEffort).mockReturnValue(write.promise)
    renderSection(<ModelsSection />)
    const select = await screen.findByRole('combobox', { name: 'Default reasoning effort' })
    await userEvent.click(select)
    await userEvent.click(await screen.findByRole('option', { name: 'Default' }))
    expect(setReasoningEffort).toHaveBeenLastCalledWith('', null, null, undefined)
    expect(select).toHaveTextContent('Default')
    write.reject(refusal())
    await waitFor(() => expect(select).toHaveTextContent('medium'))
    expect(showToast).toHaveBeenCalledWith('config.yaml is package-managed.', 4000, 'error')
  })

  it('moves Show thinking at once and rolls it back with the error toast when the server refuses', async () => {
    vi.mocked(fetchReasoning).mockResolvedValue(status)
    const write = held()
    vi.mocked(setReasoningDisplay).mockReturnValue(write.promise)
    renderSection(<ModelsSection />)
    const toggle = await screen.findByRole('switch', { name: 'Show thinking' })
    expect(toggle).toBeChecked()
    await userEvent.click(toggle)
    expect(setReasoningDisplay).toHaveBeenLastCalledWith('hide')
    expect(toggle).not.toBeChecked()
    write.reject(refusal())
    await waitFor(() => expect(toggle).toBeChecked())
    expect(showToast).toHaveBeenCalledWith('config.yaml is package-managed.', 4000, 'error')
  })
})

it('offers device-local completion sound presets and explicit preview', async () => {
  renderSection(<NotificationsSection />)
  expect(await screen.findByRole('combobox', { name: 'Completion sound' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Preview sound' })).toBeInTheDocument()
})

it('shows a failed connectors gate with a retry on the Connectors tab instead of loading forever (TAL-1691)', async () => {
  vi.mocked(fetchConnectorsAvailable).mockRejectedValueOnce(new Error('gate down'))
  renderSection(<ToolsSection tab="connectors" />)
  expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'Plugins' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.queryByRole('tab', { name: 'Connectors' })).toBeNull()
})
