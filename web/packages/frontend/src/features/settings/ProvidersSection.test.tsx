import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useParams } from '@tanstack/react-router'
import { ProviderQuotasSchema } from '../../contracts'

/** The server's real `/api/provider/cost-history` response (pinned by the server test). */
const costHistory = (JSON.parse(readFileSync(join(import.meta.dirname, '../../contracts/__fixtures__/live/provider_cost_history.json'), 'utf8')) as { body: unknown }).body
/** The server's real `/api/provider/quotas` response (pinned by the TAL-409 server test): Anthropic's Session, Weekly (the pace window) and Monthly windows. */
const quotas = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../../contracts/fixtures/provider-quotas.json'), 'utf8')) as { sources: { source_id: string; windows: { pace: unknown; forecast: unknown }[] }[]; summary?: unknown; sidebar_source_ids?: string[]; sidebar_can_pin?: boolean }
const ANTHROPIC_SOURCE = quotas.sources[0]!.source_id
const noPace = structuredClone(quotas)
Object.assign(noPace.sources[0]!.windows[1]!, { pace: null, forecast: null })
const quotaResponse = vi.hoisted((): { current: unknown } => ({ current: null }))
// A test sets one server answer, or one per filter (`q`); an answer without `groups` gets the server's grouping by `configured`.
const providersResponse = vi.hoisted(() => {
  interface Answer { active_provider?: string; providers: { id: string; display_name?: string; has_key?: boolean; configured?: boolean }[]; groups?: unknown }
  const fallback: Answer = { active_provider: 'openrouter', providers: [{ id: 'openrouter', display_name: 'OpenRouter', has_key: true }, { id: 'zai', display_name: 'Z.AI', has_key: true }, { id: 'anthropic', display_name: 'Anthropic', has_key: true }] }
  const state = { current: null as unknown, serve: (q = '') => {
    const body = ((typeof state.current === 'function' ? (state.current as (q: string) => unknown)(q) : state.current) ?? fallback) as Answer
    const ids = (configured: boolean) => body.providers.filter((p) => (p.configured === true) === configured).map((p) => p.id)
    return Promise.resolve(body.groups ? body : { ...body, groups: [{ id: 'configured', provider_ids: ids(true) }, { id: 'available', provider_ids: ids(false) }].filter((g) => g.provider_ids.length) })
  } }
  return state
})
vi.mock('../../api/endpoints', async (original) => ({
  ...await original<typeof import('../../api/endpoints')>(),
  fetchOpenRouterCostHistory: vi.fn(() => Promise.resolve({ ...(costHistory as object), latest_day: { date: '2026-09-27', spend: 0.02 } })), saveSettings: vi.fn(), fetchSettings: vi.fn(() => Promise.resolve({})), setDefaultModel: vi.fn(),
  onboardingOauthStart: vi.fn(), onboardingOauthPoll: vi.fn(), onboardingOauthCancel: vi.fn(),
  saveSelfHostedProvider: vi.fn(), refreshModels: vi.fn(), installPlugin: vi.fn(),
  fetchModels: vi.fn(() => Promise.resolve({ groups: [] })), fetchAuxiliaryModels: vi.fn(() => Promise.resolve({ main: {}, tasks: [] })),
  fetchProviders: vi.fn((q?: string) => providersResponse.serve(q)),
  fetchProviderQuotas: vi.fn(() => Promise.resolve(quotaResponse.current ?? { version: 1, computed_at: '2026-09-28T08:00:00Z', scope_id: 's', profile_id: 'default', active_provider: 'openrouter', requested_source_id: null, missing_source: false, sources: [] })),
}))
vi.mock('../../api/client', async (original) => ({ ...await original<typeof import('../../api/client')>(), post: vi.fn(() => Promise.resolve({ ok: true })) }))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
import * as api from '../../api/endpoints'
import { post } from '../../api/client'
import { ProvidersPage, ProvidersSection } from './ProvidersSection'
import { ProviderDetail } from './ProviderDetail'
import { QuotaAlertsPage } from './QuotaAlerts'

const renderSection = (ui = <ProvidersSection />) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}
/** Settings › Providers and each provider's own page under one router, as the app routes them. */
async function renderAt(path = '/settings/providers') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const root = createRootRoute({ component: () => <QueryClientProvider client={qc}><Outlet /></QueryClientProvider> })
  const list = createRoute({ getParentRoute: () => root, path: '/settings/$section', component: () => <ProvidersPage /> })
  const detail = createRoute({ getParentRoute: () => root, path: '/settings/providers/$providerId', component: function Detail() { return <ProviderDetail id={useParams({ strict: false }).providerId ?? ''} /> } })
  const alerts = createRoute({ getParentRoute: () => root, path: '/settings/providers/quota-alerts', component: QuotaAlertsPage })
  const router = createRouter({ routeTree: root.addChildren([list, alerts, detail]), history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  render(<RouterProvider router={router} />)
  return router
}
const DEFAULTS = { warning_remaining_percent: 25, critical_remaining_percent: 10, pace_tolerance_percent: 3, pace_warning_burn_rate_percent: 125, pace_critical_burn_rate_percent: 175, pace_minimum_elapsed_hours: 12 }
const quotasWith = (sources: Record<string, unknown>[]) => ProviderQuotasSchema.parse({ version: 1, computed_at: '2026-09-28T08:00:00Z', scope_id: 's', profile_id: 'default', active_provider: 'openrouter', requested_source_id: null, missing_source: false, sources })
const anthropic = { id: 'anthropic', display_name: 'Anthropic', has_key: true, configured: true, is_active: true, key_source: 'env_file', key_source_kind: 'env', removable: true, configurable: true, is_oauth: false }
const openrouter = { id: 'openrouter', display_name: 'OpenRouter', has_key: true, configured: true, key_source: 'env_file', key_source_kind: 'env' }
const block = (id: string) => document.querySelector<HTMLElement>(`[data-provider="${id}"]`)!
/** The row under a provider to add that holds its open form (TAL-2136). */
const setupRow = (id: string) => found(`[data-provider-setup="${id}"]`)
const group = (id: string) => document.querySelector<HTMLElement>(`[data-group="${id}"]`)
/** The element once it renders. */
const found = (selector: string) => waitFor(() => { const el = document.querySelector<HTMLElement>(selector); expect(el, selector).not.toBeNull(); return el! })

describe('ProvidersSection', () => {
  afterEach(() => { quotaResponse.current = null; providersResponse.current = null; vi.useRealTimers() })

  it('renders a recovery notice and never calls unknown providers unconfigured', async () => {
    providersResponse.current = { availability: { status: 'unavailable', authoritative: false, generation: 'test', unavailable_reason: 'Provider data is temporarily unavailable. Try again after Agent recovery finishes.' }, providers: [{ id: 'openai-codex', display_name: 'OpenAI Codex', has_key: false }], active_provider: 'openai-codex' }
    renderSection()
    expect(await screen.findByText('OpenAI Codex')).toBeInTheDocument()
    expect(screen.queryByText('Not configured')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Agent recovery')
    expect(screen.queryByText('Not configured')).toBeNull()
  })

  it("opens with the server's summary figures, hiding spend the server has none for (TAL-2135)", async () => {
    providersResponse.current = { active_provider: 'anthropic', providers: [anthropic, openrouter] }
    const summary = { connected: 2, lowest: { source_id: ANTHROPIC_SOURCE, percent_remaining: 21, level: 'warning' }, spend_month: 12.4, spend_currency: 'USD', default_provider_name: 'Anthropic' }
    quotaResponse.current = { ...quotas, summary }
    await renderAt()
    const stat = (id: string) => found(`[data-settings-stats] [data-stat="${id}"]`)
    expect(await stat('connected')).toHaveTextContent(/^Connected2$/)
    expect(await stat('lowest')).toHaveTextContent(/^Lowest quota21%left$/)
    expect((await stat('lowest')).querySelector('[data-figure-tone]')).toHaveAttribute('data-figure-tone', 'warning')
    expect(await stat('spend')).toHaveTextContent(/^Spend this month\$12\.40$/)
    expect(await stat('default')).toHaveTextContent(/^DefaultAnthropic$/)
    // The page shows the server's lowest window, not the 68% the client would find among Anthropic's own windows.
    expect(screen.queryByText('Active provider')).toBeNull()
  })

  it('leaves out spend and lowest quota when the server has neither (TAL-2135)', async () => {
    providersResponse.current = { active_provider: 'anthropic', providers: [anthropic] }
    quotaResponse.current = { ...quotas, sources: [], summary: { connected: 1, lowest: null, spend_month: null, spend_currency: null, default_provider_name: 'Anthropic' } }
    await renderAt()
    await waitFor(() => expect(document.querySelectorAll('[data-settings-stats] [data-stat]')).toHaveLength(2))
    expect([...document.querySelectorAll('[data-settings-stats] [data-stat]')].map((s) => s.getAttribute('data-stat'))).toEqual(['connected', 'default'])
  })

  it('shows a configured provider as one block with its headline window, and opens its page and back (TAL-2135)', async () => {
    providersResponse.current = { active_provider: 'anthropic', providers: [anthropic, openrouter, { id: 'deepseek', display_name: 'DeepSeek', has_key: false, configured: false }] }
    quotaResponse.current = { ...quotas, summary: { connected: 2, lowest: null, spend_month: 12.4, spend_currency: 'USD', default_provider_name: 'Anthropic' } }
    const router = await renderAt()
    await screen.findByText('Your providers')
    const a = await waitFor(() => { const el = block('anthropic'); expect(within(el).getByRole('meter')).toBeInTheDocument(); return el })
    expect(within(a).getByText('Default')).toBeInTheDocument()
    expect(within(a).getByText('Key from .env · max')).toBeInTheDocument()
    expect(within(a).getByText('68%')).toBeInTheDocument()
    expect(within(a).getByText('left · Weekly')).toBeInTheDocument()
    expect(within(a).getByRole('meter')).toHaveAttribute('aria-valuenow', '68')
    expect(within(a).getByRole('meter')).toHaveAccessibleName('Weekly: 68% Remaining')
    expect(within(a).getByText('Empty 18h early')).toHaveClass('text-warning')
    // No button, form or disclosure: the name is the block's one control.
    expect(within(a).queryAllByRole('button')).toEqual([])
    expect(within(a).queryAllByRole('textbox')).toEqual([])
    expect(a.querySelector('details')).toBeNull()
    // OpenRouter: the month's spend against the budget, and the daily spend with today's at the right.
    const o = await waitFor(() => { const el = block('openrouter'); expect(within(el).getByRole('img')).toBeInTheDocument(); return el })
    expect(within(o).getByText('$12.40')).toBeInTheDocument()
    expect(within(o).getByText(/^of \$\d+ budget$/)).toBeInTheDocument()
    // The day the server headlines, not the client's pick of the last bar.
    expect(within(o).getByText(/^Sep 27: \$0\.02$/)).toBeInTheDocument()
    expect(within(o).getByRole('img')).toHaveAccessibleName(/^Daily spend, last 7 days: /)
    expect(within(o).getByRole('table', { hidden: true })).toHaveTextContent('$0.50')
    await userEvent.click(within(a).getByRole('link', { name: 'Anthropic' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/providers/anthropic'))
    expect(await screen.findByRole('heading', { level: 1, name: 'Anthropic' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Providers' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/providers'))
    // Back returned through history, to the list entry the block was opened from.
    expect(router.state.location.state.__TSR_index).toBe(0)
  })

  it("headlines the source the server picks for a provider with several accounts, not the first listed (TAL-2135)", async () => {
    providersResponse.current = { active_provider: 'anthropic', providers: [anthropic] }
    const [first] = quotas.sources as Record<string, unknown>[]
    const work = structuredClone(first!) as { source_id: string; account_label: string; windows: Record<string, unknown>[] } & Record<string, unknown>
    Object.assign(work, { source_id: 'qsrc_work', account_label: 'Work', provider_headline: true })
    Object.assign(work.windows[1]!, { remaining_percent: 12, used_percent: 88 })
    quotaResponse.current = { ...quotas, sources: [{ ...first, provider_headline: false }, work] }
    await renderAt()
    const a = await waitFor(() => { const el = block('anthropic'); expect(within(el).getByRole('meter')).toBeInTheDocument(); return el })
    expect(within(a).getByText('12%')).toBeInTheDocument()
    expect(within(a).getByRole('meter')).toHaveAttribute('aria-valuenow', '12')
  })

  it('keeps Your providers while the filter narrows the providers to add, in server order (TAL-2077, TAL-2127, TAL-2135)', async () => {
    const openai = { id: 'openai', display_name: 'OpenAI', has_key: false, configured: false }
    const zai = { id: 'zai', display_name: 'Z.AI', has_key: true, configured: true }
    const unkeyed = { id: 'openrouter', display_name: 'OpenRouter', has_key: true, configured: false }
    const answers: Record<string, unknown> = {
      '': { active_provider: 'zai', providers: [openai, zai, unkeyed, anthropic], groups: [{ id: 'configured', provider_ids: ['anthropic', 'zai'] }, { id: 'available', provider_ids: ['openrouter', 'openai'] }] },
      OPEN: { active_provider: 'zai', providers: [openai, unkeyed], groups: [{ id: 'available', provider_ids: ['openai', 'openrouter'] }] },
      zzz: { active_provider: 'zai', providers: [], groups: [] },
    }
    providersResponse.current = (q: string) => answers[q]
    await renderAt()
    await screen.findByText('Z.AI')
    const section = (name: string) => document.querySelector<HTMLElement>(`[data-section="providers-${name}"]`)
    const ids = (name: string) => [...section(name)?.querySelectorAll('[data-provider]') ?? []].map((row) => row.getAttribute('data-provider'))
    const header = (name: string) => within(section(name)!).getByRole('heading').parentElement!
    expect(ids('configured')).toEqual(['anthropic', 'zai'])
    expect(ids('available')).toEqual(['openrouter', 'openai'])
    expect(header('configured')).toHaveTextContent(/^Your providers2$/)
    expect(header('available')).toHaveTextContent(/^Add a provider2$/)
    const filter = screen.getByRole('searchbox', { name: 'Filter providers' })
    await userEvent.type(filter, 'OPEN')
    await waitFor(() => expect(ids('available')).toEqual(['openai', 'openrouter']))
    expect(api.fetchProviders).toHaveBeenLastCalledWith('OPEN')
    expect(ids('configured')).toEqual(['anthropic', 'zai'])
    await userEvent.clear(filter)
    await userEvent.type(filter, 'zzz')
    expect(await screen.findByText('No providers match')).toBeInTheDocument()
    expect(ids('available')).toEqual([])
    expect(header('available')).toHaveTextContent(/^Add a provider0$/)
    await userEvent.clear(filter)
    await waitFor(() => expect(ids('available')).toEqual(['openrouter', 'openai']))
  })

  it('renders the server-offered device code and signed-in result (TAL-1827)', async () => {
    providersResponse.current = { active_provider: 'device-test', providers: [{ id: 'device-test', display_name: 'Device Test', configurable: false, is_plugin_provider: true, has_key: false, device_login: true }, { id: 'no-hooks', display_name: 'No Hooks', configurable: false, is_plugin_provider: true }] }
    vi.mocked(api.onboardingOauthStart).mockResolvedValue({ ok: true, provider: 'device-test', flow_id: 'flow-test', status: 'pending', user_code: 'TEST-1827', verification_url: 'https://device.example.test/login', expires_in: 90, interval: 1 })
    vi.mocked(api.onboardingOauthPoll).mockResolvedValue({ ok: true, provider: 'device-test', flow_id: 'flow-test', status: 'approved' })
    renderSection()
    await userEvent.click(within(await found('[data-provider="device-test"]')).getByRole('button', { name: 'Sign in' }))
    expect(within(block('no-hooks')).queryByRole('button')).toBeNull()
    const row = await setupRow('device-test')
    fireEvent.contextMenu(within(row).getByRole('button', { name: 'Sign in with Device Test' }), { clientX: 10, clientY: 10 })
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Sign in with Device Test' }))
    expect(await within(row).findByText('TEST-1827')).toBeInTheDocument()
    expect(within(row).getByRole('link')).toHaveAttribute('href', 'https://device.example.test/login')
    expect(api.onboardingOauthStart).toHaveBeenCalledWith('device-test')
    expect(await within(row).findByText('Signed in to Device Test.', {}, { timeout: 3000 })).toBeInTheDocument()
  })

  it('installs the plugin a card offers through the reviewed catalog flow and rereads the row (TAL-1812)', async () => {
    providersResponse.current = { active_provider: 'copilot', providers: [{ id: 'copilot', display_name: 'GitHub Copilot', has_key: false, is_plugin_provider: true, install_hint: 'github-copilot', auth_error: 'This provider is now a plugin. Install it, then sign in.' }, { id: 'openrouter', display_name: 'OpenRouter', has_key: true }] }
    vi.mocked(api.installPlugin).mockImplementation((_name, token) => {
      if (!token) return Promise.resolve({ name: 'github-copilot', status: 'needs_consent', findings: 'github-copilot · community', consent_token: 'preview' })
      providersResponse.current = { active_provider: 'copilot', providers: [{ id: 'copilot', display_name: 'GitHub Copilot', has_key: false, is_plugin_provider: true, auth_error: 'This provider is not set up yet.' }] }
      return Promise.resolve({ name: 'github-copilot', key: 'github-copilot', status: 'installed', enabled: false })
    })
    renderSection()
    const card = (await screen.findByText('GitHub Copilot')).closest<HTMLElement>('[data-provider="copilot"]')!
    await userEvent.click(within(card).getByRole('button', { name: 'Install plugin' }))
    expect(api.installPlugin).toHaveBeenCalledWith('github-copilot', undefined)
    // The Agent's review shows before anything installs.
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('github-copilot · community')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install disabled' }))
    await waitFor(() => expect(api.installPlugin).toHaveBeenLastCalledWith('github-copilot', 'preview'))
    // Installed, the provider offers the next step (an older server's derivation: a key) and no install.
    expect(await within(block('copilot')).findByRole('button', { name: 'Set key' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Install plugin' })).toBeNull()
  })

  it('opens the same actions as the visible controls on right-click (TAL-1812)', async () => {
    providersResponse.current = { active_provider: 'copilot', providers: [{ id: 'copilot', display_name: 'GitHub Copilot', has_key: false, is_plugin_provider: true, configurable: false, install_hint: 'github-copilot' }] }
    vi.mocked(api.installPlugin).mockClear().mockResolvedValue({ name: 'github-copilot', status: 'blocked', findings: 'Scan refused this plugin' })
    renderSection()
    const name = await screen.findByText('GitHub Copilot')
    const card = name.closest<HTMLElement>('[data-provider="copilot"]')!
    fireEvent.contextMenu(name, { clientX: 10, clientY: 10 })
    const menu = await screen.findByRole('menu', { name: 'Provider actions' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(within(card).getAllByRole('button', { hidden: true }).map((button) => button.getAttribute('aria-label') ?? button.textContent))
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Install plugin' }))
    expect(api.installPlugin).toHaveBeenCalledWith('github-copilot', undefined)
    expect(await within(await setupRow('copilot')).findByRole('alert')).toHaveTextContent('Scan refused this plugin')
  })

  it('sets up a self-hosted provider from its row, which then joins Your providers (TAL-570)', async () => {
    providersResponse.current = { active_provider: 'openrouter', providers: [{ id: 'openrouter', display_name: 'OpenRouter', has_key: true }, { id: 'ollama', display_name: 'Ollama', has_key: false, is_self_hosted: true, base_url: null, models: [], models_total: 0 }] }
    vi.mocked(api.saveSelfHostedProvider).mockImplementation(() => {
      providersResponse.current = { active_provider: 'ollama', providers: [{ id: 'ollama', display_name: 'Ollama', has_key: false, configured: true, is_active: true, is_self_hosted: true, base_url: 'http://gpu-box:11434/v1', models: [{ id: 'qwen3:32b', label: 'Qwen3 32B' }], models_total: 1 }, { id: 'openrouter', display_name: 'OpenRouter', has_key: true }] }
      return Promise.resolve({ ok: true, provider: 'ollama', base_url: 'http://gpu-box:11434/v1', model: 'qwen3:32b' })
    })
    await renderAt()
    const ollama = (await screen.findByText('Ollama')).closest<HTMLElement>('[data-provider="ollama"]')!
    expect(within(ollama).queryByRole('button', { name: 'Set key' })).toBeNull()
    await userEvent.click(within(ollama).getByRole('button', { name: 'Set up' }))
    const form = await setupRow('ollama')
    await userEvent.type(within(form).getByRole('textbox', { name: 'Base URL' }), 'http://gpu-box:11434/v1')
    await userEvent.type(within(form).getByLabelText('API key (optional)'), 'local-key')
    await userEvent.type(within(form).getByRole('textbox', { name: 'Default model' }), 'qwen3:32b')
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.saveSelfHostedProvider).toHaveBeenCalledWith({ provider: 'ollama', base_url: 'http://gpu-box:11434/v1', model: 'qwen3:32b', api_key: 'local-key' }))
    await waitFor(() => expect(document.querySelector('[data-section="providers-configured"] [data-provider="ollama"]')).not.toBeNull())
    const saved = block('ollama')
    expect(within(saved).getByText('http://gpu-box:11434/v1')).toBeInTheDocument()
    expect(within(saved).getByText('Default')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Base URL' })).toBeNull()
  })

  it("words each block's key source by the server's kind, else its own source, and marks only the default provider (TAL-603, TAL-2135)", async () => {
    providersResponse.current = { active_provider: ' ZAI ', providers: [
      { id: 'zai', display_name: 'Z.AI', has_key: true, configured: true, is_active: true, key_source: 'env_file', key_source_kind: 'env' },
      { id: 'vault', display_name: 'Vault', has_key: true, configured: true, is_active: false, key_source: 'keychain', key_source_kind: 'other' },
      { id: 'codex', display_name: 'Codex', has_key: true, configured: true, is_active: false, key_source: 'oauth', key_source_kind: 'oauth', auth_error: 'Sign-in expired' },
      { id: 'openai', display_name: 'OpenAI', has_key: false, is_active: false, key_source: 'oauth', key_source_kind: null },
    ] }
    await renderAt()
    await screen.findByText('Z.AI')
    expect(within(block('zai')).getByText('Default')).toBeInTheDocument()
    expect(within(block('zai')).getByText('Key from .env').closest('[data-status]')).toHaveAttribute('data-status', 'ok')
    expect(within(block('vault')).getByText('keychain')).toBeInTheDocument()
    expect(within(block('vault')).queryByText('Default')).toBeNull()
    expect(within(block('codex')).getByText('Sign-in expired').closest('[data-status]')).toHaveAttribute('data-status', 'error')
  })

  it('refetches quotas while open so a reset replaces the expired forecast with the server answer (TAL-410)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    providersResponse.current = { active_provider: 'anthropic', providers: [anthropic] }
    quotaResponse.current = quotas
    await renderAt()
    const a = await waitFor(() => { const el = block('anthropic'); expect(within(el).getByText('Empty 18h early')).toBeInTheDocument(); return el })
    // The window resets while the page stays open; the server's next answer has no pace or forecast for it.
    quotaResponse.current = noPace
    await vi.advanceTimersByTimeAsync(60_000)
    await waitFor(() => expect(within(a).queryByText('Empty 18h early')).toBeNull())
    expect(a.querySelector('[role="meter"] [aria-hidden]')).toBeNull()
  })

  it("gives each provider to add one line and the one control its server setup names, whatever its other fields say (TAL-2136)", async () => {
    // Each row's booleans contradict its `setup`, which alone decides the control.
    providersResponse.current = { active_provider: 'zai', providers: [
      { id: 'deepseek', display_name: 'DeepSeek', setup: 'key', is_oauth: true, configurable: false, models_total: 14 },
      { id: 'nous', display_name: 'Nous Portal', setup: 'oauth', configurable: true },
      { id: 'lmstudio', display_name: 'LM Studio', setup: 'self_hosted', is_self_hosted: false },
      { id: 'copilot', display_name: 'GitHub Copilot', setup: 'plugin', install_hint: 'github-copilot', is_self_hosted: true },
      { id: 'bedrock', display_name: 'AWS Bedrock', setup: 'cli', configurable: true, is_oauth: false },
    ] }
    renderSection()
    await screen.findByText('DeepSeek')
    const controls = (id: string) => within(block(id)).queryAllByRole('button').map((b) => b.getAttribute('aria-label'))
    expect(['deepseek', 'nous', 'lmstudio', 'copilot', 'bedrock'].map((id) => [id, controls(id)])).toEqual([
      ['deepseek', ['Set key']], ['nous', ['Sign in']], ['lmstudio', ['Set up']], ['copilot', ['Install plugin']], ['bedrock', []],
    ])
    expect(within(block('bedrock')).getByText('Agent CLI only')).toBeInTheDocument()
    const list = document.querySelector('[data-section="providers-available"]')!
    expect(list).not.toHaveTextContent(/Not configured|models|Refresh/)
    expect(within(block('deepseek')).getByText('D')).toHaveAttribute('data-monogram')
  })

  it('shows the first eight providers to add, then the rest behind a disclosure, and every match while filtering (TAL-2136)', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: `p${String(i)}`, display_name: `Provider ${String(i)}`, setup: 'key' }))
    providersResponse.current = (q: string) => ({ active_provider: 'p0', providers: q ? rows.filter((r) => r.display_name.includes(q)) : rows })
    renderSection()
    await screen.findByText('Provider 0')
    const shown = () => document.querySelectorAll('[data-section="providers-available"] [data-provider]').length
    expect(shown()).toBe(8)
    await userEvent.click(screen.getByRole('button', { name: '2 more' }))
    expect(shown()).toBe(10)
    await userEvent.click(screen.getByRole('button', { name: 'Show fewer' }))
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter providers' }), 'Provider')
    await waitFor(() => expect(api.fetchProviders).toHaveBeenLastCalledWith('Provider'))
    await waitFor(() => expect(shown()).toBe(10))
    expect(screen.queryByRole('button', { name: '2 more' })).toBeNull()
  })

  it("sets a key from Add a provider, then opens that provider's page with it under Your providers (TAL-2136)", async () => {
    const deepseek = { id: 'deepseek', display_name: 'DeepSeek', setup: 'key', has_key: false, configured: false }
    providersResponse.current = { active_provider: 'anthropic', providers: [anthropic, deepseek] }
    vi.mocked(post).mockImplementationOnce(() => {
      providersResponse.current = { active_provider: 'anthropic', providers: [anthropic, { ...deepseek, has_key: true, configured: true, key_source_kind: 'config' }] }
      return Promise.resolve({ ok: true })
    })
    const router = await renderAt()
    await userEvent.click(within(await found('[data-provider="deepseek"]')).getByRole('button', { name: 'Set key' }))
    await userEvent.type(within(await setupRow('deepseek')).getByLabelText('DeepSeek API key'), 'sk-test')
    await userEvent.click(within(await setupRow('deepseek')).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/providers/deepseek'))
    expect(post).toHaveBeenCalledWith('api/providers', { provider: 'deepseek', api_key: 'sk-test' }, expect.anything(), { retries: 0 })
    expect(await found('[data-provider-detail="deepseek"]')).toBeInTheDocument()
    // Back returns to the list, where it is now one of Your providers.
    await userEvent.click(screen.getByRole('button', { name: 'Providers' }))
    await waitFor(() => expect(document.querySelector('[data-section="providers-configured"] [data-provider="deepseek"]')).not.toBeNull())
  })

  it('links Your providers to Quota alerts, whose six thresholds each show their unit and save alone, with no Save button (TAL-2136)', async () => {
    providersResponse.current = { active_provider: 'anthropic', providers: [anthropic] }
    vi.mocked(api.fetchSettings).mockResolvedValue({ provider_quota_thresholds: DEFAULTS })
    vi.mocked(api.saveSettings).mockResolvedValue({ provider_quota_thresholds: { ...DEFAULTS, pace_minimum_elapsed_hours: 6 } })
    const router = await renderAt()
    const link = await within(await found('[data-section="providers-configured"]')).findByRole('link', { name: /Quota alerts/ })
    expect(link).toHaveTextContent('warn at 25% left')
    expect(screen.queryByRole('spinbutton')).toBeNull()
    await userEvent.click(link)
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/providers/quota-alerts'))
    await screen.findByRole('heading', { name: 'Quota alerts' })
    const fields = await waitFor(() => { const f = screen.getAllByRole('spinbutton'); expect(f).toHaveLength(6); return f })
    expect(fields.map((f) => [f.getAttribute('aria-label') ?? document.querySelector(`label[for="${f.id}"]`)?.textContent, (f as HTMLInputElement).value, f.parentElement?.nextElementSibling?.textContent]))
      .toEqual([['Warn below', '25', '%'], ['Critical below', '10', '%'], ['Allowed ahead of pace', '3', '%'], ['Warn at burn rate', '125', '%'], ['Critical at burn rate', '175', '%'], ['Start projecting after', '12', 'hours']])
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull()
    const before = vi.mocked(api.fetchProviderQuotas).mock.calls.length
    const hours = screen.getByRole('spinbutton', { name: 'Start projecting after' })
    await userEvent.clear(hours)
    await userEvent.type(hours, '6{Enter}')
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledExactlyOnceWith({ provider_quota_thresholds: { pace_minimum_elapsed_hours: 6 } }))
    // The saved thresholds reclassify the quotas, which the list rereads on the way back.
    await userEvent.click(screen.getByRole('button', { name: 'Providers' }))
    await waitFor(() => expect(vi.mocked(api.fetchProviderQuotas).mock.calls.length).toBeGreaterThan(before))
  })
})

describe('ProviderDetail (TAL-2135)', () => {
  afterEach(() => { quotaResponse.current = null; providersResponse.current = null; vi.mocked(api.saveSettings).mockReset() })

  it('shows figures, Quota, Sign-in and Models in that order, each window with its forecast', async () => {
    providersResponse.current = { active_provider: 'anthropic', providers: [{ ...anthropic, models: [{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }], models_total: 14 }] }
    quotaResponse.current = quotas
    await renderAt('/settings/providers/anthropic')
    expect(await screen.findByRole('heading', { level: 1, name: 'Anthropic' })).toBeInTheDocument()
    await waitFor(() => expect(document.querySelector('[data-group="quota"]')).not.toBeNull())
    const stats = [...document.querySelectorAll<HTMLElement>('[data-settings-stats] [data-stat]')].map((s) => s.textContent)
    expect(stats).toEqual(['Session90%left', 'Weekly68%left', 'Monthly95%left', 'Pace3.4% over', 'Models14'])
    expect(document.querySelector('[data-stat="pace"] [data-figure-tone]')).toHaveAttribute('data-figure-tone', 'warning')
    expect([...document.querySelectorAll('[data-provider-detail] [data-group]')].map((g) => g.getAttribute('data-group'))).toEqual(['quota', 'sign-in', 'models'])
    const weekly = document.querySelector<HTMLElement>('[data-group="quota"] [data-quota-window="Weekly"]')!
    expect(within(weekly).getByRole('meter')).toHaveAttribute('aria-valuenow', '68')
    expect(within(weekly).getByText('Empty 18h early')).toHaveClass('text-warning')
    expect(within(document.querySelector<HTMLElement>('[data-quota-window="Session"]')!).getByText('Lasts through reset')).not.toHaveClass('text-warning')
  })

  it('pins and unpins the quota to the sidebar at once, rolls back a refusal, and respects the pin limit', async () => {
    providersResponse.current = { active_provider: 'anthropic', providers: [anthropic] }
    quotaResponse.current = { ...quotas, sidebar_source_ids: [], sidebar_can_pin: true }
    let settle: (value: never) => void = () => undefined
    vi.mocked(api.saveSettings).mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
    await renderAt('/settings/providers/anthropic')
    const pin = await screen.findByRole('switch', { name: 'Show in sidebar' })
    expect(pin).not.toBeChecked()
    await userEvent.click(pin)
    // The switch reflects the choice before the server answers.
    expect(pin).toBeChecked()
    expect(api.saveSettings).toHaveBeenCalledWith({ sidebar_quota_sources: [ANTHROPIC_SOURCE] })
    quotaResponse.current = { ...quotas, sidebar_source_ids: [ANTHROPIC_SOURCE], sidebar_can_pin: true }
    settle({ sidebar_quota_sources: [ANTHROPIC_SOURCE], sidebar_source_ids: [ANTHROPIC_SOURCE], sidebar_can_pin: true } as never)
    await waitFor(() => expect(pin).toBeChecked())
    vi.mocked(api.saveSettings).mockRejectedValueOnce(Object.assign(new Error('Refused'), { status: 400 }))
    await userEvent.click(pin)
    await waitFor(() => expect(api.saveSettings).toHaveBeenLastCalledWith({ sidebar_quota_sources: [] }))
    // The refusal returns the switch to the server's pin.
    await waitFor(() => expect(pin).toBeChecked())
  })

  it('disables an unpinned source at the pin limit and says why', async () => {
    providersResponse.current = { active_provider: 'anthropic', providers: [anthropic] }
    quotaResponse.current = { ...quotas, sidebar_source_ids: ['qsrc_a', 'qsrc_b'], sidebar_can_pin: false }
    await renderAt('/settings/providers/anthropic')
    const pin = await screen.findByRole('switch', { name: 'Show in sidebar' })
    await waitFor(() => expect(pin).toHaveAttribute('aria-disabled', 'true'))
    expect(pin).toHaveAttribute('title', 'Pin up to two.')
  })

  it('replaces the key, and removes it only behind a confirm dialog when the server marks it removable', async () => {
    providersResponse.current = { active_provider: 'anthropic', providers: [anthropic] }
    await renderAt('/settings/providers/anthropic')
    const signIn = await found('[data-group=\"sign-in\"]')
    expect(within(signIn).getByText('API key')).toBeInTheDocument()
    expect(within(signIn).getByText('Key from .env')).toBeInTheDocument()
    await userEvent.click(within(signIn).getByRole('button', { name: 'Replace key' }))
    await userEvent.type(within(signIn).getByLabelText('Anthropic API key'), 'sk-ant-new')
    await userEvent.click(within(signIn).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(post).toHaveBeenCalledWith('api/providers', { provider: 'anthropic', api_key: 'sk-ant-new' }, expect.anything(), { retries: 0 }))
    vi.mocked(post).mockClear()
    await userEvent.click(within(signIn).getByRole('button', { name: 'Remove key' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(post).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove key' }))
    await waitFor(() => expect(post).toHaveBeenCalledWith('api/providers', { provider: 'anthropic', api_key: null }, expect.anything(), { retries: 0 }))
  })

  it('offers the credential actions from the Sign-in rows on right-click, the same as their buttons', async () => {
    providersResponse.current = { active_provider: 'anthropic', providers: [anthropic] }
    await renderAt('/settings/providers/anthropic')
    const signIn = await found('[data-group="sign-in"]')
    fireEvent.contextMenu(within(signIn).getByText('API key'), { clientX: 10, clientY: 10 })
    const menu = await screen.findByRole('menu', { name: 'Provider actions' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Replace key', 'Remove key'])
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Remove key' }))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Remove the Anthropic key?')
  })

  it.each([['deepseek', 'env_var'], ['zai', 'credential_pool']])('offers no Remove key for %s, whose key the server marks not removable (TAL-641)', async (id, source) => {
    providersResponse.current = { active_provider: id, providers: [{ id, display_name: id, has_key: true, configured: true, configurable: true, is_oauth: false, key_source: source, removable: false }] }
    await renderAt(`/settings/providers/${id}`)
    const signIn = await found('[data-group=\"sign-in\"]')
    expect(within(signIn).getByRole('button', { name: 'Replace key' })).toBeInTheDocument()
    expect(within(signIn).queryByRole('button', { name: 'Remove key' })).toBeNull()
  })

  it("marks the server's default model only on the provider serving it, with no control that sets the default (TAL-2131)", async () => {
    const shared = [{ id: 'shared-model', label: 'Shared model' }, { id: 'other-model', label: 'Other model' }]
    providersResponse.current = { active_provider: 'zai', providers: [{ id: 'openrouter', display_name: 'OpenRouter', has_key: true, configured: true, models: shared }, { id: 'zai', display_name: 'Z.AI', has_key: true, configured: true, models: shared }] }
    vi.mocked(api.fetchSettings).mockResolvedValue({ default_model: 'shared-model' })
    vi.mocked(api.fetchModels).mockResolvedValue({ groups: [], default_model: 'shared-model', default_provider_id: 'zai' })
    await renderAt('/settings/providers/zai')
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-provider-model="${id}"]`)!
    await waitFor(() => expect(within(row('shared-model')).getByText('Default')).toBeInTheDocument())
    expect(within(row('other-model')).queryByText('Default')).toBeNull()
    expect(within(group('models')!).queryByRole('button', { name: /default/i })).toBeNull()
    expect(api.setDefaultModel).not.toHaveBeenCalled()
  })

  it("refreshes the provider's models and shows the server's new count (TAL-570)", async () => {
    providersResponse.current = { active_provider: 'zai', providers: [{ id: 'zai', display_name: 'Z.AI', has_key: true, configured: true, models: [{ id: 'glm-5' }], models_total: 3 }] }
    vi.mocked(api.refreshModels).mockImplementation(() => {
      providersResponse.current = { active_provider: 'zai', providers: [{ id: 'zai', display_name: 'Z.AI', has_key: true, configured: true, models: [{ id: 'glm-5' }], models_total: 5 }] }
      return Promise.resolve({ ok: true, provider: 'zai', models: { active_provider: 'zai', default_model: 'glm-5', groups: [] } } as never)
    })
    await renderAt('/settings/providers/zai')
    const models = await found('[data-group=\"models\"]')
    expect(within(models).getByRole('heading').parentElement).toHaveTextContent(/^Models3/)
    await userEvent.click(within(models).getByRole('button', { name: 'Refresh models' }))
    expect(api.refreshModels).toHaveBeenCalledWith('zai')
    await waitFor(() => expect(within(group('models')!).getByRole('heading').parentElement).toHaveTextContent(/^Models5/))
  })

  it('refreshes quotas from the Quota header', async () => {
    providersResponse.current = { active_provider: 'anthropic', providers: [anthropic] }
    quotaResponse.current = quotas
    await renderAt('/settings/providers/anthropic')
    const quota = await found('[data-group=\"quota\"]')
    vi.mocked(api.fetchProviderQuotas).mockClear()
    await userEvent.click(within(quota).getByRole('button', { name: 'Refresh quotas' }))
    await waitFor(() => expect(api.fetchProviderQuotas).toHaveBeenCalledWith(true))
  })

  it('shows the OpenRouter spend chart, pace, budget standing and budget row under Spend (TAL-412)', async () => {
    providersResponse.current = { active_provider: 'openrouter', providers: [openrouter] }
    await renderAt('/settings/providers/openrouter')
    const spend = await found('[data-group=\"spend\"]')
    expect(await within(spend).findByText('Monthly pace: $33.90', { exact: false })).toBeInTheDocument()
    expect(within(spend).getByText('80% of $42.37 budget (monthly pace)')).toBeInTheDocument()
    expect(within(spend).getAllByRole('listitem').filter((li) => li.hasAttribute('title'))).toHaveLength(7)
    expect(within(spend).getByRole('spinbutton', { name: 'Monthly budget' })).toHaveValue(42.37)
  })

  it("colours a windowless source by the server urgency of both bases (TAL-411)", async () => {
    providersResponse.current = { active_provider: 'zai', providers: [{ id: 'zai', display_name: 'Z.AI', has_key: true, configured: true }] }
    quotaResponse.current = quotasWith([{ source_id: 'q1', provider_id: 'zai', status: 'available', urgency: { remaining: 'warning', pace: 'critical' } }])
    await renderAt('/settings/providers/zai')
    expect((await screen.findByText('Remaining: Warning', {}, { timeout: 2000 })).closest('[data-status]')).toHaveAttribute('data-status', 'warning')
    expect(screen.getByText('Pace: Critical').closest('[data-status]')).toHaveAttribute('data-status', 'error')
  })

  it("tones the pace figure by the window's display level, so a stale source's old warning stays stale", async () => {
    const stale = structuredClone(quotas) as unknown as { sources: ({ status: string; windows: Record<string, unknown>[] } & Record<string, unknown>)[] }
    Object.assign(stale.sources[0]!, { status: 'stale', display_level: 'stale' })
    for (const w of stale.sources[0]!.windows) w.display_level = 'stale'
    providersResponse.current = { active_provider: 'anthropic', providers: [anthropic] }
    quotaResponse.current = stale
    await renderAt('/settings/providers/anthropic')
    const pace = await found('[data-stat="pace"]')
    expect(pace).toHaveTextContent(/^Pace3\.4% over$/)
    // An untoned figure carries no tone attribute; the stale window's old warning would set one.
    expect(pace.querySelector('[data-figure-tone]')).toBeNull()
  })

  it("names a stale source's last-confirmed windows with the server's status text, on the page and in the list", async () => {
    const reason = 'Account usage refresh failed. Showing last-confirmed data.'
    const stale = structuredClone(quotas) as unknown as { sources: Record<string, unknown>[] }
    Object.assign(stale.sources[0]!, { status: 'stale', status_message: reason, display_level: 'stale' })
    providersResponse.current = { active_provider: 'anthropic', providers: [anthropic] }
    quotaResponse.current = stale
    const router = await renderAt('/settings/providers/anthropic')
    const quota = await found('[data-group="quota"]')
    await waitFor(() => expect(within(quota).getByText(reason).closest('[data-status]')).toHaveAttribute('data-status', 'warning'))
    await router.navigate({ to: '/settings/$section', params: { section: 'providers' } })
    const a = await found('[data-provider="anthropic"]')
    expect(within(a).getByText(reason).closest('[data-status]')).toHaveAttribute('data-status', 'warning')
  })

  it('words the pace figure by the server status', async () => {
    // A server with a 4% tolerance calls the fixture's 3.4-point deficit on pace.
    const onPace = structuredClone(quotas) as { sources: { windows: { pace: Record<string, unknown> | null }[] }[] }
    Object.assign(onPace.sources[0]!.windows[1]!.pace!, { status: 'on' })
    providersResponse.current = { active_provider: 'anthropic', providers: [anthropic] }
    quotaResponse.current = onPace
    await renderAt('/settings/providers/anthropic')
    await waitFor(() => expect(document.querySelector('[data-stat="pace"]')).toHaveTextContent(/^PaceOn pace$/))
  })

  it("keeps a configured provider's last-known row unverified while the server cannot confirm the catalog", async () => {
    const availability = { status: 'stale', authoritative: false, generation: 'test', unavailable_reason: 'Provider data is temporarily unavailable. Showing last-confirmed data.' }
    providersResponse.current = { availability, active_provider: 'anthropic', providers: [anthropic] }
    await renderAt()
    const a = await found('[data-provider="anthropic"]')
    expect(within(a).getByText('Temporarily unavailable').closest('[data-status]')).toHaveAttribute('data-status', 'warning')
    expect(within(a).queryByText('Key from .env')).toBeNull()
    await userEvent.click(within(a).getByRole('link', { name: 'Anthropic' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Showing last-confirmed data')
    const signIn = await found('[data-group="sign-in"]')
    expect(within(signIn).getByText('Temporarily unavailable').closest('[data-status]')).toHaveAttribute('data-status', 'warning')
  })

  it('words a provider whose key is gone as not configured, never ready', async () => {
    providersResponse.current = { active_provider: 'anthropic', providers: [{ ...anthropic, has_key: false, configured: false, key_source: 'none', key_source_kind: null, removable: false }] }
    await renderAt('/settings/providers/anthropic')
    const signIn = await found('[data-group="sign-in"]')
    expect(within(signIn).getByText('Not configured').closest('[data-status]')).toHaveAttribute('data-status', 'idle')
    expect(within(signIn).queryByText('Configured')).toBeNull()
  })

  it("keeps a plan's paused and credits status beside the windows its gauges became (TAL-2135)", async () => {
    providersResponse.current = { active_provider: 'nous', providers: [{ id: 'nous', display_name: 'Nous', has_key: true, configured: true, is_oauth: true }] }
    const plan = { kind: 'usage_window', plan: 'Pro', gauges: [{ label: 'week', title: 'Weekly', scope: 'all', left_fraction: 0.4, resets_at_ms: null, style: 'red' }], top_tier_model_ids: [], subscription_model_ids: [], featured_model_ids: [], paused_reason: 'allowance', credits_pay: true }
    quotaResponse.current = quotasWith([{ source_id: 'q-nous', provider_id: 'nous', status: 'available', plan_usage: plan, plan_stale: false, provider_headline: true, headline_window_index: 0, windows: [{ label: 'Weekly', used_percent: 60, remaining_percent: 40, reset_at: null, detail: null, window_seconds: 604800, pace: null, forecast: null, display_level: 'healthy' }] }])
    await renderAt('/settings/providers/nous')
    const quota = await found('[data-group="quota"]')
    await waitFor(() => expect(within(quota).getByText('Included usage paused')).toBeInTheDocument())
    expect(within(quota).getByText('Pro')).toBeInTheDocument()
    expect(within(quota).getByRole('meter')).toHaveAttribute('aria-valuenow', '40')
  })

  it('shows an unknown provider as an error with the way back', async () => {
    providersResponse.current = { active_provider: 'anthropic', providers: [anthropic] }
    const router = await renderAt('/settings/providers/nope')
    expect(await screen.findByText('No provider called nope')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Providers' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/providers'))
  })
})
