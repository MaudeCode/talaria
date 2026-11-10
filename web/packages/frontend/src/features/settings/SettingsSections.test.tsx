import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const titleTask = { task: 'title_generation', label: 'Title generation', description: 'session titles', provider: 'auto', model: '', is_auto: true, value_label: 'Claude Sonnet 4.6', provider_label: 'Anthropic', selected_option_id: null, in_catalog: true, inherit_from: null, reasoning_effort: '', reasoning: { saved: null, effective: '', inherited: true, default_source: 'provider', options: ['low', 'medium', 'high'], unavailable: null } }
// Every other endpoint stays pending, so a page's other lists sit in their loading state.
vi.mock('../../api/endpoints', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return {
    ...Object.fromEntries(Object.entries(real).map(([name, value]) => [name, typeof value === 'function' ? vi.fn(() => new Promise(() => undefined)) : value])),
    fetchSettings: vi.fn(() => Promise.resolve({ default_model: 'claude-sonnet-4-6', confirm_external_links: true, trusted_link_hosts: ['docs.example.com'], trusted_link_hosts_count: 1 })),
    saveSettings: vi.fn((patch: Record<string, unknown>) => Promise.resolve(patch)),
    fetchModels: vi.fn(() => Promise.resolve({ groups: [] })),
    setDefaultModel: vi.fn(),
    fetchAuxiliaryModels: vi.fn(() => Promise.resolve({ main: {}, tasks: [titleTask] })),
    setAuxiliaryModel: vi.fn(),
  }
})
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
vi.mock('../voice/completionAudio', async (importOriginal) => ({ ...await importOriginal<typeof import('../voice/completionAudio')>(), previewSound: vi.fn(() => Promise.resolve()) }))
vi.mock('../voice/tts', async (importOriginal) => ({ ...await importOriginal<typeof import('../voice/tts')>(), speak: vi.fn(() => Promise.resolve()), stopSpeaking: vi.fn() }))
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
import { AccessSection } from './AccessSection'
import { SpeechSection } from './SpeechSection'
import { AUDIO_KEY, DEFAULT_AUDIO, previewSound } from '../voice/completionAudio'
import { speak, stopSpeaking } from '../voice/tts'
import { ToolsSection } from './ToolsSection'
import { ChatPageSchema } from '../../contracts/url'
import type { SettingsPage } from './settingsIndex'
import { renderRouted } from '../../test/router'

const withProviders = (ui: ReactElement, canManage: boolean, qc: QueryClient) => {
  const bootstrap = { ...DEFAULT_BOOTSTRAP, auth: { ...DEFAULT_BOOTSTRAP.auth, can_manage_server: canManage } }
  return <QueryClientProvider client={qc}><BootstrapContext.Provider value={bootstrap}>{ui}</BootstrapContext.Provider></QueryClientProvider>
}
// Providers' and Chat's pages link and navigate (TAL-2135, TAL-2136, TAL-2138), so every page renders under a router.
const renderSection = (ui: ReactElement, canManage = true, qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) => renderRouted(withProviders(ui, canManage, qc))
/** Every Settings page, with the pages under Providers (TAL-2136) and Chat (TAL-2138). */
const PAGES: { section: SettingsSectionId; page?: SettingsPage; id: string }[] = SettingsSectionSchema.options.flatMap((section) => [
  { section, id: section },
  ...(section === 'chat' ? ChatPageSchema.options.map((page) => ({ section, page, id: `chat/${page}` })) : section === 'providers' ? [{ section, page: 'quota-alerts' as const, id: 'providers/quota-alerts' }] : []),
])
const renderPage = ({ section, page }: { section: SettingsSectionId; page?: SettingsPage | undefined }, qc: QueryClient) => renderSection(<SettingsSection section={section} page={page} />, true, qc)

/**
 * TAL-1691, TAL-2100, TAL-2075, TAL-2138: every field the retired Preferences, Conversation, System and Models & Providers pages
 * edited, and the one page that now edits it (`chat/<page>` for a Chat sub-page). A key is a settings field; a selector is a
 * control with no settings field of its own.
 */
const PLACEMENT: Record<string, string> = {
  send_key: 'chat', default_message_mode: 'chat', large_text_paste_as_attachment: 'chat', chat_activity_display_mode: 'chat', transparent_stream_event_timestamps: 'chat/advanced',
  worklog_details_expanded_default: 'chat', auto_scroll_follow: 'chat', render_user_markdown: 'chat', fade_text_effect: 'chat/advanced', virtualize_transcript: 'chat/advanced',
  show_busy_placeholder_hint: 'chat/advanced', show_token_usage: 'chat', show_tps: 'chat/advanced',
  max_tokens: 'chat/advanced', compression_prepare_ahead: 'chat/advanced', group_discussion_max_rounds: 'chat', group_discussion_max_messages: 'chat', auto_title_refresh_every: 'chat/advanced',
  sidebar_density: 'navigation', pinned_sessions_limit: 'navigation', session_endless_scroll: 'chat/advanced', session_jump_buttons: 'chat', show_conversation_outline: 'chat', project_quick_create_buttons: 'navigation',
  show_cli_sessions: 'navigation', show_claude_code_sessions: 'navigation', show_cron_sessions: 'navigation', show_webhook_sessions: 'navigation', show_kanban_sessions: 'navigation',
  show_previous_messaging_sessions: 'navigation', hidden_tabs: 'navigation', show_titlebar_profile: 'navigation', show_sidebar_feedback: 'navigation', show_quota_chip: 'chat',
  hide_composer_model: 'chat', hide_composer_reasoning: 'chat', hide_composer_profile: 'chat', hide_composer_workspace: 'chat', hide_composer_toolsets: 'chat',
  hide_composer_attach: 'chat', hide_composer_mic: 'chat', hide_composer_context: 'chat', hide_composer_yolo: 'chat',
  workspace_panel_open: 'chat/workspace-panel', workspace_todos_tab: 'chat/workspace-panel', new_chat_on_workspace_switch: 'chat/workspace-panel',
  terminal_auto_expand_on_output: 'chat/workspace-panel', screen_reader_mode: 'chat/workspace-panel',
  default_model: 'models', '#settingsModel': 'models', '[data-group="auxiliary"]': 'models', '[data-group="quota-remaining"]': 'providers/quota-alerts',
  notifications_enabled: 'notifications', sound_enabled: 'notifications', '#completionSound': 'notifications',
  agent_approvals: 'tools',
  sync_to_insights: 'access', api_redact_enabled: 'access', confirm_external_links: 'access', trusted_link_hosts: 'access', auth_disabled_acknowledged: 'access',
  update_channel: 'system', agent_update_channel: 'system', ignore_agent_updates: 'system', check_for_updates: 'system', auto_apply_updates: 'system',
  summarize_updates_automatically: 'system', '[data-group="health"]': 'system', '[data-group="server"]': 'system',
}
const isControl = (key: string) => key.startsWith('#') || key.startsWith('[')
const CONTROLS = Object.keys(PLACEMENT).filter(isControl)

it('edits every retired Preferences, Conversation, System and Models & Providers field on exactly its one new page (TAL-1691, TAL-2100, TAL-2138)', async () => {
  // jsdom has no matchMedia; Appearance reads the colour scheme.
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
  const settings = Object.fromEntries(Object.keys(PLACEMENT).filter((key) => !isControl(key)).map((key) => [key, false]))
  Object.assign(settings, { provider_quota_thresholds: {}, hidden_tabs: [], trusted_link_hosts: [], group_discussion_max_rounds: 3, group_discussion_max_messages: 10, auth_enabled: false })
  const found: Record<string, string[]> = {}
  for (const page of PAGES) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(keys.settings, settings)
    reads.clear()
    const view = await renderPage(page, qc)
    await waitFor(() => expect(view.container.querySelector(`[data-section="${page.section}"]`)).not.toBeNull())
    if (page.page) await waitFor(() => expect(view.container.querySelector('[data-group]')).not.toBeNull())
    for (const control of CONTROLS) if (view.container.querySelector(control)) reads.add(control)
    // Chat reads whether the Agent offers prepared compaction to count Advanced's rows; only Advanced edits it.
    for (const key of reads) if (key in PLACEMENT && !(page.id === 'chat' && key === 'compression_prepare_ahead')) (found[key] ??= []).push(page.id)
    view.unmount()
  }
  vi.unstubAllGlobals()
  expect(found).toEqual(Object.fromEntries(Object.entries(PLACEMENT).map(([key, section]) => [key, [section]])))
  // Every page renders in turn, as in the index placement test (TAL-2086).
}, 30_000)

/** TAL-2075, TAL-2076, TAL-2138: every Chat, Chat sub-page and Navigation row by its label, in page order, with the `data-group` it sits in. */
const GROUPS: Record<string, [string, string][]> = {
  chat: [
    ['Send with', 'composer'], ['While the agent is working', 'composer'], ['Attach long pasted text as a file', 'composer'],
    ['Activity display', 'transcript'], ['Open worklog details automatically', 'transcript'], ['Format Markdown in my messages', 'transcript'], ['Show token usage', 'transcript'],
    ['Follow new content', 'transcript'], ['Conversation outline', 'transcript'], ['Jump buttons', 'transcript'],
    ['Rounds per discussion', 'group-discussions'], ['Messages per discussion', 'group-discussions'],
  ],
  'chat/workspace-panel': [
    ['Keep workspace panel open by default', 'panel'], ['Show Todos tab in workspace panel', 'panel'], ['Start a new chat when switching workspace', 'panel'],
    ['Auto-expand terminal on output', 'terminal'], ['Terminal screen reader mode', 'terminal'],
  ],
  'chat/advanced': [
    ['Name the busy action in the composer', 'transcript-advanced'], ['Event timestamps', 'transcript-advanced'], ['Fade in streamed text', 'transcript-advanced'],
    ['Show tokens per second', 'transcript-advanced'], ['Render only visible messages (experimental)', 'transcript-advanced'], ['Load earlier messages while scrolling', 'transcript-advanced'],
    ['Max output tokens', 'limits'], ['Prepare compaction in the background', 'limits'], ['Refresh chat titles', 'limits'],
  ],
  navigation: [
    ['Pinned conversations limit', 'chats'], ['Sidebar density', 'chats'], ['Show per-project new-conversation buttons', 'chats'],
    ['Show CLI and other external sessions', 'sessions'], ['Show Claude Code sessions', 'sessions'], ['Show cron sessions', 'sessions'], ['Show webhook sessions', 'sessions'],
    ['Show kanban sessions', 'sessions'], ['Show previous messaging sessions', 'sessions'],
    ['Tasks', 'destinations'], ['Kanban', 'destinations'], ['Skills', 'destinations'], ['Memory', 'destinations'], ['Discussions', 'destinations'], ['Todos', 'destinations'],
    ['Decisions', 'destinations'], ['Insights', 'destinations'],
    ['Sidebar feedback button', 'buttons'], ['Show profile switcher in titlebar', 'buttons'],
  ],
}

it('puts each Chat and Navigation row in the group where it applies, each once with its own labelled control (TAL-2075, TAL-2138)', async () => {
  const settings = { hidden_tabs: ['kanban'], compression_prepare_ahead: true, group_discussion_max_rounds: 3, group_discussion_max_messages: 10 }
  for (const page of PAGES.filter((p) => p.id in GROUPS)) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(keys.settings, settings)
    const view = await renderPage(page, qc)
    await waitFor(() => expect(view.container.querySelector(`[data-section="${page.section}"]`)).not.toBeNull())
    const labels = [...view.container.querySelectorAll<HTMLLabelElement>(`[data-section="${page.section}"] label`)]
    expect(labels.map((label) => [label.textContent, label.closest('[data-group]')?.getAttribute('data-group')]), page.id).toEqual(GROUPS[page.id])
    for (const label of labels) expect(document.getElementById(label.htmlFor), label.textContent ?? '').not.toBeNull()
    for (const [name, group] of GROUPS[page.id]!) if (group === 'destinations') expect(screen.getByRole('switch', { name })).toBeInTheDocument()
    view.unmount()
  }
})

it('keeps Chat to the composer drawing and at most 14 rows, with links that count their sub-pages\' rows (TAL-2138)', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(keys.settings, { compression_prepare_ahead: null, group_discussion_max_rounds: 3, group_discussion_max_messages: 10 })
  const view = await renderPage({ section: 'chat' }, qc)
  const page = await waitFor(() => view.container.querySelector<HTMLElement>('[data-section="chat"]')!)
  expect([...page.querySelectorAll('section[data-group]')].map((g) => g.getAttribute('data-group'))).toEqual(['composer', 'transcript', 'group-discussions', 'more'])
  expect(page.querySelector('[data-group="composer"] [data-composer-preview]')).not.toBeNull()
  expect(page.querySelectorAll('[data-group] label').length + page.querySelectorAll('[data-group="more"] a').length).toBeLessThanOrEqual(14)
  // The Agent without a prepared-compaction choice leaves Advanced one row short.
  expect(within(page).getByRole('link', { name: /Workspace panel/ })).toHaveTextContent('5 settings')
  expect(within(page).getByRole('link', { name: /Advanced/ })).toHaveTextContent('8 settings')
  for (const name of ['Send with', 'While the agent is working', 'Activity display']) expect(within(page).getByRole('radiogroup', { name })).toBeInTheDocument()
  expect(within(page).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Enter', 'Ctrl Enter', 'Steer', 'Queue', 'Interrupt', 'Compact', 'Every step', 'Final answer only'])
  expect(page.querySelector('[role="switch"][id^="settings-hide_composer_"]')).toBeNull()
})

describe('settings pages', () => {
  it('edits the external-link confirmation and trusted hosts through settings (TAL-279)', async () => {
    await renderSection(<PrivacySettings />)
    const confirm = await screen.findByRole('switch', { name: 'Confirm before opening external links' })
    expect(confirm).toBeChecked()
    await userEvent.click(confirm)
    expect(saveSettings).toHaveBeenLastCalledWith({ confirm_external_links: false })
    // TAL-2143: one closed row with the host count; saving keeps it open and updates the count.
    const disclosure = screen.getByRole('button', { name: 'Trusted link hosts' })
    expect(disclosure).toHaveTextContent('1 host')
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('textbox', { name: 'Trusted link hosts' })).toBeNull()
    await userEvent.click(disclosure)
    const hosts = screen.getByRole('textbox', { name: 'Trusted link hosts' })
    expect(hosts).toHaveValue('docs.example.com')
    await userEvent.type(hosts, '\nAPI.Example.com')
    // The server answers its normalized hosts and their count on the reread that follows the save.
    vi.mocked(fetchSettings).mockResolvedValueOnce({ default_model: 'claude-sonnet-4-6', confirm_external_links: false, trusted_link_hosts: ['docs.example.com', 'api.example.com'], trusted_link_hosts_count: 2 })
    await userEvent.click(within(hosts.closest('form')!).getByRole('button', { name: 'Save' }))
    expect(saveSettings).toHaveBeenLastCalledWith({ trusted_link_hosts: ['docs.example.com', 'API.Example.com'] })
    await waitFor(() => expect(disclosure).toHaveTextContent('2 hosts'))
    expect(hosts).toBeVisible()
  })

  it('shows the profile\'s agent approvals setting below the tabs as the server reports it and writes it (TAL-1169, TAL-2138)', async () => {
    vi.mocked(fetchSettings).mockResolvedValueOnce({ default_model: 'claude-sonnet-4-6', agent_approvals: true })
    await renderSection(<ToolsSection />)
    const toggle = await screen.findByRole('switch', { name: 'Let agents approve or deny other chats\' commands' })
    expect(toggle).toBeChecked()
    const approvals = screen.getByRole('region', { name: 'Agent permissions' })
    expect(within(approvals).getByRole('heading', { name: 'Agent permissions' })).toBeVisible()
    expect(approvals).toContainElement(toggle)
    expect(approvals.querySelector('#settings-agent_approvals')).not.toBeNull()
    // TAL-2138: the tab strip comes first, the approvals group after the tab panel.
    const tools = document.querySelector('[data-section="tools"]')!
    expect(tools.firstElementChild).toContainElement(screen.getByRole('tablist'))
    expect(screen.getByRole('tabpanel').compareDocumentPosition(approvals) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await userEvent.click(toggle)
    expect(saveSettings).toHaveBeenLastCalledWith({ agent_approvals: false })
  })

  it('TAL-2143: without a password the row says so, or carries the server\'s warning level, and Escape closes the form Set password opens', async () => {
    const access = (warning: 'error' | 'warning' | null) => <BootstrapContext.Provider value={{ ...DEFAULT_BOOTSTRAP, auth: { ...DEFAULT_BOOTSTRAP.auth, auth_enabled: false, no_password_warning: warning } }}><AccessSection /></BootstrapContext.Provider>
    vi.mocked(fetchSettings).mockResolvedValueOnce({ password_auth_enabled: false, auth_enabled: false })
    const view = await renderSection(access(null))
    const signIn = await screen.findByRole('region', { name: 'Sign-in' })
    expect(within(signIn).getByText('Not set').closest('[data-status]')).toHaveAttribute('data-status', 'idle')
    await userEvent.click(within(signIn).getByRole('button', { name: 'Set password' }))
    expect(screen.queryByLabelText('Enter current password…')).toBeNull()
    expect(screen.getByLabelText('Enter new password…')).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByLabelText('Enter new password…')).toBeNull()
    // Settings › Access has no assistant name (the default profile's page) and no approvals switch (Settings › Tools).
    expect(screen.queryByText(/assistant name/i)).toBeNull()
    expect(screen.queryByRole('switch', { name: /approve/i })).toBeNull()
    view.unmount()
    for (const level of ['warning', 'error'] as const) {
      vi.mocked(fetchSettings).mockResolvedValueOnce({ password_auth_enabled: false, auth_enabled: false })
      const warnedView = await renderSection(access(level))
      const warned = within(await screen.findByRole('region', { name: 'Sign-in' })).getByText('This instance is accessible without authentication.')
      expect(warned.closest('[data-status]')).toHaveAttribute('data-status', level)
      warnedView.unmount()
    }
  })

  it('lets only a server owner change link safety and redaction (TAL-279, TAL-1880)', async () => {
    await renderSection(<PrivacySettings />, false)
    expect(await screen.findByRole('switch', { name: 'Confirm before opening external links' })).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Trusted link hosts' }))
    expect(screen.getByRole('textbox', { name: 'Trusted link hosts' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Redact sensitive data in API responses' })).toHaveAttribute('aria-disabled', 'true')
  })
})

// jsdom lays nothing out; the model picker's scroller gets a height so the virtualized list renders its rows (TAL-2137).
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
beforeAll(() => { Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return this.hasAttribute('data-model-picker-list') ? 100_000 : 0 } }) })
afterAll(() => { if (offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight) })

it('renders and saves only the server-provided speed tiers (TAL-788)', async () => {
  vi.mocked(fetchAuxiliaryModels).mockResolvedValue({ main: { model: 'gpt-6-astra', provider: 'openai-codex', service_tier: 'priority', supported_speed_tiers: [
    { id: 'standard', service_tier: 'default' }, { id: 'priority', service_tier: 'priority' }, { id: 'ultrafast', service_tier: 'ultrafast' },
  ] }, tasks: [] })
  vi.mocked(setDefaultModel).mockResolvedValue({ ok: true, model: 'gpt-6-astra', provider: 'openai-codex' })
  await renderSection(<ModelsSection />)
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
  const view = await renderSection(<ModelsSection />)
  const change = await screen.findByRole('button', { name: 'Change model' })
  await userEvent.click(change)
  await userEvent.click(await screen.findByRole('option', { name: 'GPT-5.6 Sol' }))
  expect(setDefaultModel).toHaveBeenLastCalledWith('@openai-codex:gpt-5.6-sol', 'openai-codex', undefined)
  // TAL-2137: the headline names the model and its provider; Change stays usable while the write runs.
  const model = view.container.querySelector('[data-setting-headline]')
  expect(model).toHaveTextContent('GPT-5.6 SolOpenAI Codex')
  expect(change).toBeEnabled()
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
  await renderSection(<ModelsSection />)
  await waitFor(() => expect(fetchAuxiliaryModels).toHaveBeenCalled())
  const before = vi.mocked(fetchAuxiliaryModels).mock.calls.length
  await userEvent.click(await screen.findByRole('button', { name: 'Change model' }))
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
  await renderSection(<ModelsSection />)
  await userEvent.click(await screen.findByRole('button', { name: 'Change model' }))
  await userEvent.click(await screen.findByRole('option', { name: 'GPT-5.6 Sol' }))
  await userEvent.click(screen.getByRole('combobox', { name: 'Speed' }))
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Standard', 'Fast'])
})

describe('the profile reasoning defaults (TAL-2078)', () => {
  const status = { show_reasoning: true, reasoning_effort: 'medium', supported_efforts: ['low', 'medium', 'high'], supports_reasoning_effort: true, supports_thinking_toggle: true }
  const refusal = () => new ApiError({ kind: 'http', status: 409, path: '/api/reasoning', message: 'config.yaml is package-managed.' })
  const held = () => { let reject!: (e: unknown) => void; const promise = new Promise<never>((_, r) => { reject = r }); return { promise, reject } }
  const effortRow = () => screen.queryByRole('radiogroup', { name: 'Reasoning effort' }) ?? screen.queryByRole('combobox', { name: 'Reasoning effort' })
  const thinkingRow = () => screen.queryByRole('switch', { name: 'Show thinking' })
  beforeEach(() => { vi.mocked(fetchAuxiliaryModels).mockResolvedValue({ main: {}, tasks: [] }) })

  it.each([[true, true], [true, false], [false, true], [false, false]])('shows the effort row when effort is supported (%s) and the thinking row when the toggle is (%s)', async (effort, toggle) => {
    vi.mocked(fetchReasoning).mockResolvedValue({ ...status, supports_reasoning_effort: effort, supports_thinking_toggle: toggle })
    await renderSection(<ModelsSection />)
    await waitFor(() => expect(fetchReasoning).toHaveBeenCalledWith(undefined, undefined, undefined))
    await waitFor(() => expect(!!effortRow() || !!thinkingRow() || (!effort && !toggle)).toBe(true))
    expect(!!effortRow()).toBe(effort)
    expect(!!thinkingRow()).toBe(toggle)
  })

  it('offers exactly the server\'s efforts with the provider default side by side and saves the profile default without a chat (TAL-2137)', async () => {
    vi.mocked(fetchReasoning).mockResolvedValue(status)
    vi.mocked(setReasoningEffort).mockImplementation((effort) => {
      vi.mocked(fetchReasoning).mockResolvedValue({ ...status, reasoning_effort: effort })
      return Promise.resolve({ ...status, reasoning_effort: effort })
    })
    await renderSection(<ModelsSection />)
    const group = within(await screen.findByRole('radiogroup', { name: 'Reasoning effort' }))
    expect(group.getAllByRole('radio').map((o) => o.textContent)).toEqual(['Default', 'Low', 'Medium', 'High'])
    expect(group.getByRole('radio', { name: 'Medium' })).toBeChecked()
    await userEvent.click(group.getByRole('radio', { name: 'High' }))
    expect(setReasoningEffort).toHaveBeenCalledWith('high', null, null, undefined)
    await waitFor(() => expect(group.getByRole('radio', { name: 'High' })).toBeChecked())
  })

  it('offers more than three server efforts in a select (TAL-2137)', async () => {
    vi.mocked(fetchReasoning).mockResolvedValue({ ...status, supported_efforts: ['minimal', 'low', 'medium', 'high'] })
    vi.mocked(setReasoningEffort).mockResolvedValue({ ...status, reasoning_effort: 'minimal' })
    await renderSection(<ModelsSection />)
    const select = await screen.findByRole('combobox', { name: 'Reasoning effort' })
    expect(screen.queryByRole('radiogroup', { name: 'Reasoning effort' })).not.toBeInTheDocument()
    await userEvent.click(select)
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Default', 'Minimal', 'Low', 'Medium', 'High'])
    await userEvent.click(screen.getByRole('option', { name: 'Minimal' }))
    expect(setReasoningEffort).toHaveBeenCalledWith('minimal', null, null, undefined)
  })

  it('shows a saved effort the model does not list and lets Default clear it (TAL-2137)', async () => {
    vi.mocked(fetchReasoning).mockResolvedValue({ ...status, reasoning_effort: 'none' })
    vi.mocked(setReasoningEffort).mockResolvedValue({ ...status, reasoning_effort: null })
    await renderSection(<ModelsSection />)
    const select = await screen.findByRole('combobox', { name: 'Reasoning effort' })
    expect(select).toHaveTextContent('None')
    await userEvent.click(select)
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Default', 'Low', 'Medium', 'High', 'None'])
    await userEvent.click(screen.getByRole('option', { name: 'Default' }))
    expect(setReasoningEffort).toHaveBeenCalledWith('', null, null, undefined)
  })

  it('moves the effort at once and rolls it back with the error toast when the server refuses', async () => {
    vi.mocked(fetchReasoning).mockResolvedValue(status)
    const write = held()
    vi.mocked(setReasoningEffort).mockReturnValue(write.promise)
    await renderSection(<ModelsSection />)
    const group = within(await screen.findByRole('radiogroup', { name: 'Reasoning effort' }))
    await userEvent.click(group.getByRole('radio', { name: 'Default' }))
    expect(setReasoningEffort).toHaveBeenLastCalledWith('', null, null, undefined)
    expect(group.getByRole('radio', { name: 'Default' })).toBeChecked()
    write.reject(refusal())
    await waitFor(() => expect(group.getByRole('radio', { name: 'Medium' })).toBeChecked())
    expect(showToast).toHaveBeenCalledWith('config.yaml is package-managed.', 4000, 'error')
  })

  it('moves Show thinking at once and rolls it back with the error toast when the server refuses', async () => {
    vi.mocked(fetchReasoning).mockResolvedValue(status)
    const write = held()
    vi.mocked(setReasoningDisplay).mockReturnValue(write.promise)
    await renderSection(<ModelsSection />)
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

it('plays the selected completion sound from the Sound row (TAL-2146)', async () => {
  localStorage.setItem(AUDIO_KEY, JSON.stringify({ ...DEFAULT_AUDIO, sound: 'bell' }))
  await renderSection(<NotificationsSection />)
  await screen.findByRole('combobox', { name: 'Sound' })
  await userEvent.click(screen.getByRole('button', { name: 'Preview sound' }))
  expect(previewSound).toHaveBeenCalledWith(expect.objectContaining({ sound: 'bell' }))
  localStorage.removeItem(AUDIO_KEY)
})

it('shows the saved quiet period range beside its switch and opens to its times when on (TAL-2146)', async () => {
  localStorage.setItem(AUDIO_KEY, JSON.stringify({ ...DEFAULT_AUDIO, start: '22:00', end: '07:00' }))
  const view = await renderSection(<NotificationsSection />)
  const quiet = await screen.findByRole('switch', { name: 'Quiet period' })
  expect(view.container.querySelector('[data-quiet-range]')).toBeNull()
  expect(screen.queryByLabelText('Quiet period starts')).toBeNull()
  await userEvent.click(quiet)
  expect(view.container.querySelector('[data-quiet-range]')).toHaveTextContent('10:00 PM to 7:00 AM')
  expect(screen.getByLabelText('Quiet period starts')).toHaveValue('22:00')
  expect(screen.getByLabelText('Quiet period ends')).toHaveValue('07:00')
  localStorage.removeItem(AUDIO_KEY)
})

describe('the browser notification permission (TAL-2146)', () => {
  it.each([
    ['granted', 'ok', 'Allowed by this browser'],
    ['denied', 'warning', "Blocked in this browser's settings"],
    ['default', 'idle', 'Not asked yet'],
  ] as const)('reads %s as a %s dot with its words', async (permission, state, words) => {
    vi.stubGlobal('Notification', { permission, requestPermission: vi.fn() })
    await renderSection(<NotificationsSection />)
    const status = (await screen.findByText(words)).closest('[data-status]')
    expect(status).toHaveAttribute('data-status', state)
    expect(screen.getByRole('switch', { name: 'Browser notifications' })).not.toHaveAttribute('data-disabled')
    vi.unstubAllGlobals()
  })

  it.each([['granted', true, 'Allowed by this browser'], ['denied', false, "Blocked in this browser's settings"]] as const)('asks once when switched on before the browser was asked; %s leaves it on: %s (TAL-2157)', async (answer, on, words) => {
    const stub: { permission: NotificationPermission; requestPermission: () => Promise<NotificationPermission> } = { permission: 'default', requestPermission: vi.fn(() => { stub.permission = answer; return Promise.resolve(answer) }) }
    vi.stubGlobal('Notification', stub)
    vi.mocked(saveSettings).mockClear()
    await renderSection(<NotificationsSection />)
    const toggle = await screen.findByRole('switch', { name: 'Browser notifications' })
    await userEvent.click(toggle)
    expect(stub.requestPermission).toHaveBeenCalledOnce()
    await screen.findByText(words)
    if (on) await waitFor(() => { expect(saveSettings).toHaveBeenLastCalledWith({ notifications_enabled: true }) })
    else {
      expect(toggle).not.toBeChecked()
      expect(saveSettings).not.toHaveBeenCalled()
    }
    vi.unstubAllGlobals()
  })

  it('says the browser has no notifications and disables the switch', async () => {
    const saved = Object.getOwnPropertyDescriptor(window, 'Notification')
    Reflect.deleteProperty(window, 'Notification')
    await renderSection(<NotificationsSection />)
    expect((await screen.findByText('Not supported by this browser')).closest('[data-status]')).toHaveAttribute('data-status', 'idle')
    expect(screen.getByRole('switch', { name: 'Browser notifications' })).toHaveAttribute('data-disabled')
    if (saved) Object.defineProperty(window, 'Notification', saved)
  })
})

it('plays a sample through the read-aloud function and stops it on a second press (TAL-2146)', async () => {
  await renderSection(<SettingsSection section="speech" />)
  await userEvent.click(await screen.findByRole('button', { name: 'Play a sample' }))
  expect(speak).toHaveBeenCalledExactlyOnceWith('This is how replies will sound.', expect.any(Function))
  await userEvent.click(screen.getByRole('button', { name: 'Stop the sample' }))
  expect(stopSpeaking).toHaveBeenCalledOnce()
  // A sample that finishes on its own puts the button back.
  await userEvent.click(screen.getByRole('button', { name: 'Play a sample' }))
  const finished = vi.mocked(speak).mock.calls[1]![1]!
  act(() => { finished() })
  expect(screen.getByRole('button', { name: 'Play a sample' })).toBeInTheDocument()
  expect(stopSpeaking).toHaveBeenCalledOnce()
})

it('groups the Notifications and Speech rows and shows every slider value (TAL-2079)', async () => {
  const group = (view: HTMLElement, id: string) => {
    const element = view.querySelector<HTMLElement>(`[data-group="${id}"]`)
    expect(element, `group ${id}`).toBeInstanceOf(HTMLElement)
    return within(element!)
  }
  const notifications = await renderSection(<NotificationsSection />)
  await screen.findByRole('combobox', { name: 'Sound' })
  const completion = group(notifications.container, 'reply-finishes')
  const open = group(notifications.container, 'while-open')
  for (const name of ['Browser notifications', 'Notification sound']) expect(open.getByRole('switch', { name })).toBeInTheDocument()
  expect(completion.getByRole('combobox', { name: 'Sound' })).toBeInTheDocument()
  expect(completion.getByRole('slider', { name: 'Volume' }).nextElementSibling).toHaveTextContent('50%')
  notifications.unmount()
  const speech = await renderSection(<SpeechSection />)
  await screen.findByRole('slider', { name: 'Speed' })
  const device = group(speech.container, 'voice-device')
  const server = group(speech.container, 'read-aloud')
  for (const name of ['Read replies aloud', 'Start reading automatically']) expect(server.getByRole('switch', { name })).toBeInTheDocument()
  expect(device.getByRole('radiogroup', { name: 'Engine' })).toBeInTheDocument()
  expect(device.getByRole('slider', { name: 'Speed' }).nextElementSibling).toHaveTextContent('1.0×')
  expect(device.getByRole('slider', { name: 'Pitch' }).nextElementSibling).toHaveTextContent('1.0')
})

it('shows a failed connectors gate with a retry on the Connectors tab instead of loading forever (TAL-1691)', async () => {
  vi.mocked(fetchConnectorsAvailable).mockRejectedValueOnce(new Error('gate down'))
  await renderSection(<ToolsSection tab="connectors" />)
  expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'Plugins' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.queryByRole('tab', { name: 'Connectors' })).toBeNull()
})
