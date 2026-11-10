import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Every endpoint stays pending unless a section needs its answer to show every static row.
vi.mock('../../api/endpoints', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return {
    ...Object.fromEntries(Object.entries(real).map(([name, value]) => [name, typeof value === 'function' ? vi.fn(() => new Promise(() => undefined)) : value])),
    fetchModels: vi.fn(() => Promise.resolve({ groups: [] })),
    fetchAuxiliaryModels: vi.fn(() => Promise.resolve({ main: { model: 'gpt-6-astra', provider: 'openai-codex', supported_speed_tiers: [{ id: 'standard', service_tier: 'default' }] }, tasks: [] })),
    fetchReasoning: vi.fn(() => Promise.resolve({ show_reasoning: true, reasoning_effort: '', supported_efforts: ['low'], supports_reasoning_effort: true, supports_thinking_toggle: true })),
    fetchConnectorsAvailable: vi.fn(() => Promise.resolve({ available: false })),
    fetchPlugins: vi.fn(() => Promise.resolve({ read_only: false, total: 0, empty: true, plugins: [], auto_update: { auto_apply: false, check_hours: 24, inactive_reason: null } })),
    fetchWebPushStatus: vi.fn(() => Promise.resolve({ public_key: 'key', subscription: { preferences: { notify_on_approval: true, notify_on_input: true, notify_on_completion: true, notify_on_failure: true } } })),
  }
})
import { SETTINGS_SECTION_GROUPS, SettingsSectionSchema } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import { keys } from '../../api/queryKeys'
import { BootstrapContext } from '../../app/bootstrap'
import { DEFAULT_BOOTSTRAP } from '../../contracts/adapters/memory'
import { AUDIO_KEY, DEFAULT_AUDIO } from '../voice/completionAudio'
import { SettingsSection } from './SettingsSection'
import { SETTINGS_INDEX, searchSettings, type SettingScope } from './settingsIndex'

/** Rows whose settings fields the server sends, so each conditional row shows. */
const SETTINGS = {
  compression_prepare_ahead: false, group_discussion_max_rounds: 3, group_discussion_max_messages: 10, agent_approvals: false, hidden_tabs: [], trusted_link_hosts: [], auth_enabled: false,
  provider_quota_thresholds: { warning_remaining_percent: 20, critical_remaining_percent: 5, pace_tolerance_percent: 5, pace_warning_burn_rate_percent: 120, pace_critical_burn_rate_percent: 150, pace_minimum_elapsed_hours: 6 },
}
const GROUP_OF_SCOPE: Record<SettingScope, string> = { device: 'interface', interface: 'interface', profile: 'profile', server: 'server' }

beforeAll(() => {
  // jsdom has no matchMedia or Push API; a custom sound in quiet hours shows every completion sound row.
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
  vi.stubGlobal('PushManager', {})
  vi.stubGlobal('Notification', { requestPermission: vi.fn() })
  const subscription = { endpoint: 'https://push.example/browser' }
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve({ pushManager: { getSubscription: () => Promise.resolve(subscription) } }) } })
  localStorage.setItem(AUDIO_KEY, JSON.stringify({ ...DEFAULT_AUDIO, sound: 'custom', quiet: true }))
})
afterAll(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'serviceWorker')
  localStorage.removeItem(AUDIO_KEY)
})

/**
 * The id of every labelled control and picker grid inside a Settings group: the rows the page renders. A page with tabs
 * counts its tab panel's rows under that tab and the rest under the page.
 */
const renderedRows = (page: HTMLElement, tab: string | undefined) => {
  const rows = [
    ...[...page.querySelectorAll<HTMLLabelElement>('[data-group] label[for]')].map((label) => page.ownerDocument.getElementById(label.htmlFor)),
    ...page.querySelectorAll<HTMLElement>('[data-group] [id][aria-label]:is([role="group"], [role="combobox"], [role="switch"], input, select, textarea)'),
  ]
  return [...new Set(rows.filter((row): row is HTMLElement => !!row && !!row.closest('[role="tabpanel"]') === !!tab).map((row) => row.id))]
}

/** A row's group title: its `SettingsGroup`, else the Tools tab it sits on. */
const groupTitle = (row: HTMLElement) => row.closest('section[data-group]')?.getAttribute('aria-label') ?? (row.closest('[role="tabpanel"]') ? row.ownerDocument.querySelector('[role="tab"][aria-selected="true"]')?.textContent : null)

it('indexes every Settings row once, each where it renders, under its group, in the group its scope belongs to (TAL-2086)', async () => {
  const ids = SETTINGS_INDEX.map((entry) => entry.id)
  expect(ids.filter((id, i) => ids.indexOf(id) !== i), 'duplicate index ids').toEqual([])
  const pages = SettingsSectionSchema.options.flatMap((section) => [undefined, ...new Set(SETTINGS_INDEX.filter((e) => e.section === section && e.tab).map((e) => e.tab))].map((tab) => ({ section, tab })))
  const rendered: Record<string, string[]> = {}
  const placed: Record<string, string | null | undefined> = {}
  for (const { section, tab } of pages) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(keys.settings, SETTINGS)
    const view = render(<QueryClientProvider client={qc}><BootstrapContext.Provider value={DEFAULT_BOOTSTRAP}><SettingsSection section={section} tab={tab} /></BootstrapContext.Provider></QueryClientProvider>)
    const expected = SETTINGS_INDEX.filter((e) => e.section === section && e.tab === tab)
    // Each page's indexed rows load lazily and wait for their data.
    await waitFor(() => {
      expect(view.container.querySelector(`[data-section="${section}"]`)).not.toBeNull()
      for (const entry of expected) expect(document.getElementById(entry.id), `${section} ${entry.id}`).not.toBeNull()
    })
    rendered[tab ? `${section}?tab=${tab}` : section] = renderedRows(view.container, tab).sort()
    for (const entry of expected) placed[entry.id] = groupTitle(document.getElementById(entry.id)!)
    view.unmount()
  }
  const indexed = Object.fromEntries(Object.keys(rendered).map((page) => [page, SETTINGS_INDEX.filter((e) => (e.tab ? `${e.section}?tab=${e.tab}` : e.section) === page).map((e) => e.id).sort()]))
  // (a) Drift: a row on a page without an entry, or an entry for a row its page does not render.
  expect(indexed).toEqual(rendered)
  // Each entry's group is the title of the group its row renders in.
  expect(placed).toEqual(Object.fromEntries(SETTINGS_INDEX.map((e) => [e.id, e.group()])))
  // A hidden row lands on a row of its own page.
  expect(SETTINGS_INDEX.filter((e) => e.shownWith && !SETTINGS_INDEX.some((o) => o.id === e.shownWith && o.section === e.section && o.tab === e.tab)).map((e) => e.id)).toEqual([])
  // (b) Placement (design-system §11): a section's contract group matches the scope of every row on it.
  expect(SETTINGS_INDEX.filter((e) => SETTINGS_SECTION_GROUPS[e.section] !== GROUP_OF_SCOPE[e.scope]).map((e) => `${e.id}: ${e.scope} on ${e.section}`)).toEqual([])
  // (c) A setting stored only in this browser sits in a group titled This device.
  expect(SETTINGS_INDEX.filter((e) => e.scope === 'device' && e.group() !== m.settings_group_this_device()).map((e) => e.id)).toEqual([])
}, 30_000)

it('matches the localized label or group title, ignoring case and surrounding space (TAL-2086)', () => {
  expect(searchSettings('  ')).toEqual([])
  expect(searchSettings('SEND KEY').map((e) => e.id)).toEqual(['settingsSendKey'])
  expect(searchSettings('this device').map((e) => e.section)).toEqual(SETTINGS_INDEX.filter((e) => e.scope === 'device').map((e) => e.section))
  expect(searchSettings('no such setting')).toEqual([])
})

it('opens a hidden row at the control that shows it, then at the row once it appears (TAL-2086)', async () => {
  localStorage.setItem(AUDIO_KEY, JSON.stringify(DEFAULT_AUDIO))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(keys.settings, SETTINGS)
  render(<QueryClientProvider client={qc}><BootstrapContext.Provider value={DEFAULT_BOOTSTRAP}><SettingsSection section="notifications" row="completionStart" visit="1" /></BootstrapContext.Provider></QueryClientProvider>)
  const quiet = await screen.findByRole('switch', { name: 'Quiet period' })
  await waitFor(() => expect(quiet).toHaveFocus())
  await userEvent.keyboard(' ')
  await waitFor(() => expect(document.getElementById('completionStart')).toHaveFocus())
  localStorage.setItem(AUDIO_KEY, JSON.stringify({ ...DEFAULT_AUDIO, sound: 'custom', quiet: true }))
})
