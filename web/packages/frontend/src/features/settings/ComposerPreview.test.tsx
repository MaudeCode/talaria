import { expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Every endpoint but the settings read and write stays pending.
vi.mock('../../api/endpoints', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return { ...Object.fromEntries(Object.entries(real).map(([name, value]) => [name, typeof value === 'function' ? vi.fn(() => new Promise(() => undefined)) : value])), saveSettings: vi.fn(), fetchSettings: vi.fn() }
})
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
import { fetchSettings, saveSettings } from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { BootstrapContext } from '../../app/bootstrap'
import { useSettingsQuery } from '../../app/settings'
import { ApiError } from '../../contracts/common'
import { DEFAULT_BOOTSTRAP } from '../../contracts/adapters/memory'
import { renderRouted } from '../../test/router'
import { deferred } from '../../test/fixtures'
import { hideComposerControl } from '../composer/ComposerControls'
import { showToast } from '../toast/toast'
import { SettingsSection } from './SettingsSection'

/** The ten hideable controls in the composer's order, by the name each toggle in the drawing has. */
const CONTROLS = ['Attach button', 'Model', 'Reasoning', 'Profile', 'Workspace', 'Toolsets', 'Quota chip', 'Context ring', 'Microphone', 'YOLO mode notice']

/** What the real composer decides for its model chip from the same settings: hidden or shown. */
function ComposerModelChip() {
  const settings = useSettingsQuery(['hide_composer_model']).data
  return <output aria-label="composer model chip">{hideComposerControl(settings, false, 'hide_composer_model') ? 'hidden' : 'shown'}</output>
}

async function renderChat(settings: Record<string, unknown>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  qc.setQueryData(keys.settings, settings)
  // The server keeps what it accepts, so a reread after a write returns it.
  let stored = { ...settings }
  vi.mocked(fetchSettings).mockImplementation(() => Promise.resolve(stored))
  vi.mocked(saveSettings).mockImplementation((patch) => { stored = { ...stored, ...patch }; return Promise.resolve(stored) })
  await renderRouted(<QueryClientProvider client={qc}><BootstrapContext.Provider value={DEFAULT_BOOTSTRAP}><SettingsSection section="chat" /><ComposerModelChip /></BootstrapContext.Provider></QueryClientProvider>)
  return within(await screen.findByRole('region', { name: 'Composer' }))
}

it('draws each hideable composer control as a toggle in the composer\'s order, counted in the header (TAL-2138)', async () => {
  const composer = await renderChat({ hide_composer_profile: true, show_quota_chip: false })
  const toggles = composer.getAllByRole('button').filter((b) => b.hasAttribute('aria-pressed'))
  expect(toggles.map((b) => b.getAttribute('aria-label'))).toEqual(CONTROLS.map((c) => `Show ${c}`))
  expect(toggles.filter((b) => b.getAttribute('aria-pressed') === 'false').map((b) => b.getAttribute('aria-label'))).toEqual(['Show Profile', 'Show Quota chip'])
  expect(composer.getByText('8 of 10 controls shown')).toBeInTheDocument()
})

it('hides a control at once, saves its key and the composer follows; a refusal rolls it back with the error (TAL-2138)', async () => {
  const held = deferred<Record<string, unknown>>()
  const composer = await renderChat({})
  vi.mocked(saveSettings).mockReturnValue(held.promise)
  const model = composer.getByRole('button', { name: 'Show Model' })
  expect(model).toHaveAttribute('aria-pressed', 'true')
  await userEvent.click(model)
  expect(model).toHaveAttribute('aria-pressed', 'false')
  expect(composer.getByText('9 of 10 controls shown')).toBeInTheDocument()
  expect(screen.getByRole('status', { name: 'composer model chip' })).toHaveTextContent('hidden')
  expect(saveSettings).toHaveBeenCalledWith({ hide_composer_model: true })
  const message = 'config.yaml is package-managed. Update the declarative configuration instead.'
  held.reject(new ApiError({ kind: 'http', status: 409, path: 'api/settings', message, body: { error: message, condition: 'config_write_refused' } }))
  await waitFor(() => expect(model).toHaveAttribute('aria-pressed', 'true'))
  expect(screen.getByRole('status', { name: 'composer model chip' })).toHaveTextContent('shown')
  expect(composer.getByText('10 of 10 controls shown')).toBeInTheDocument()
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(message, 4000, 'error'))
})

it('reaches and toggles every control from the keyboard, the quota chip saving its shown key (TAL-2138)', async () => {
  const composer = await renderChat({})
  composer.getByRole('button', { name: 'Show Attach button' }).focus()
  for (const [i, name] of CONTROLS.entries()) {
    if (i > 0) await userEvent.tab()
    expect(composer.getByRole('button', { name: `Show ${name}` })).toHaveFocus()
  }
  await userEvent.keyboard('{Enter}')
  expect(saveSettings).toHaveBeenLastCalledWith({ hide_composer_yolo: true })
  await userEvent.tab({ shift: true })
  await userEvent.tab({ shift: true })
  await userEvent.tab({ shift: true })
  await userEvent.keyboard(' ')
  expect(composer.getByRole('button', { name: 'Show Quota chip' })).toHaveAttribute('aria-pressed', 'false')
  expect(saveSettings).toHaveBeenLastCalledWith({ show_quota_chip: false })
})
