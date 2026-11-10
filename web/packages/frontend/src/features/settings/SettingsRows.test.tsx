import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { keys } from '../../api/queryKeys'
import { deferred } from '../../test/fixtures'
import * as api from '../../api/endpoints'
import { ApiError } from '../../contracts/common'
import { showToast } from '../toast/toast'
import { Bell } from 'lucide-react'
import { SettingAction, SettingLink, SettingNumber, SettingRow, SettingSegmented, SettingSelect, SettingsStats, SettingText, SettingToggle } from './SettingsRows'

vi.mock('../../api/endpoints', () => ({ fetchSettings: vi.fn(), saveSettings: vi.fn() }))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
const initial = { mode: 'a', limit: 3, name: 'Hermes', hosts: ['one.example'], hide_thing: false, quota: { warn: 20, crit: 5 } }
const options = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]
const user = userEvent.setup({ delay: null })

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.fetchSettings).mockResolvedValue(initial)
})

function setup(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(keys.settings, initial)
  render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

it('SettingSelect writes the picked option', async () => {
  vi.mocked(api.saveSettings).mockResolvedValue({ ...initial, mode: 'b' })
  setup(<SettingSelect label="Mode" settingKey="mode" fallback="a" options={options} />)
  await user.click(screen.getByRole('combobox', { name: 'Mode' }))
  await user.click(await screen.findByRole('option', { name: 'Beta' }))
  await waitFor(() => expect(api.saveSettings).toHaveBeenCalledExactlyOnceWith({ mode: 'b' }))
})

it('SettingToggle with inverted shows on while the stored key is false and writes the inverse (TAL-2076)', async () => {
  vi.mocked(api.saveSettings).mockResolvedValue({ ...initial, hide_thing: true })
  setup(<SettingToggle label="Thing" settingKey="hide_thing" inverted />)
  const toggle = screen.getByRole('switch', { name: 'Thing' })
  expect(toggle).toBeChecked()
  await user.click(toggle)
  await waitFor(() => expect(api.saveSettings).toHaveBeenCalledExactlyOnceWith({ hide_thing: true }))
})

it.each([
  ['an in-range integer', '7', { limit: 7 }],
  ['an integer above max, clamped to it (TAL-2160)', '51', { limit: 50 }],
  ['an integer below min', '0', null],
  ['a fraction', '2.5', null],
  ['an empty field without allowEmpty', '', null],
])('SettingNumber given %s writes only a valid value', async (_, typed, written) => {
  vi.mocked(api.saveSettings).mockResolvedValue(initial)
  setup(<SettingNumber label="Limit" settingKey="limit" max={50} />)
  fireEvent.change(screen.getByLabelText('Limit'), { target: { value: typed } })
  if (written) await waitFor(() => expect(api.saveSettings).toHaveBeenCalledExactlyOnceWith(written))
  else expect(api.saveSettings).not.toHaveBeenCalled()
})

it('SettingNumber with a field saves only its key on blur, then shows the server answer, and writes nothing else (TAL-2136)', async () => {
  // The server merges the key and owns its range (here, at most 50).
  let stored: Record<string, unknown> = initial
  vi.mocked(api.saveSettings).mockImplementation((patch) => {
    const quota = { ...(stored.quota as object), ...(patch.quota as object) } as { warn: number; crit: number }
    stored = { ...stored, quota: { ...quota, warn: Math.min(50, quota.warn) } }
    return Promise.resolve(stored)
  })
  vi.mocked(api.fetchSettings).mockImplementation(() => Promise.resolve(stored))
  setup(<SettingNumber label="Warn" settingKey="quota" field="warn" min={1} max={50} unit="%" />)
  const input = screen.getByRole('spinbutton', { name: 'Warn' })
  expect(input).toHaveValue(20)
  expect(input.parentElement?.nextElementSibling).toHaveTextContent('%')
  await user.clear(input)
  await user.type(input, '75')
  expect(api.saveSettings).not.toHaveBeenCalled()
  await user.tab()
  await waitFor(() => expect(api.saveSettings).toHaveBeenCalledExactlyOnceWith({ quota: { warn: 75 } }))
  await waitFor(() => expect(input).toHaveValue(50))
  vi.mocked(api.saveSettings).mockClear()
  // Emptied, or left unchanged, the field puts the value back and writes nothing.
  await user.clear(input)
  await user.tab()
  await user.click(input)
  await user.tab()
  expect(input).toHaveValue(50)
  expect(api.saveSettings).not.toHaveBeenCalled()
})

it("SettingNumber with a field never sends another key's unconfirmed edit, so a refused edit rolls back alone (TAL-2136)", async () => {
  const first = deferred<typeof initial>()
  const second = deferred<typeof initial>()
  vi.mocked(api.saveSettings).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  setup(<><SettingNumber id="warn" label="Warn" settingKey="quota" field="warn" /><SettingNumber id="crit" label="Crit" settingKey="quota" field="crit" /></>)
  const warn = screen.getByRole('spinbutton', { name: 'Warn' })
  const crit = screen.getByRole('spinbutton', { name: 'Crit' })
  await user.clear(warn)
  await user.type(warn, '30{Enter}')
  await user.clear(crit)
  await user.type(crit, '7{Enter}')
  await waitFor(() => { expect(warn).toHaveValue(30); expect(crit).toHaveValue(7) })
  first.reject(new ApiError({ kind: 'http', status: 409, path: 'api/settings', message: 'Refused', body: { error: 'Refused' } }))
  await waitFor(() => expect(warn).toHaveValue(20))
  expect(crit).toHaveValue(7)
  await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(2))
  expect(vi.mocked(api.saveSettings).mock.calls).toEqual([[{ quota: { warn: 30 } }], [{ quota: { crit: 7 } }]])
  second.resolve({ ...initial, quota: { warn: 20, crit: 7 } })
  await waitFor(() => expect(crit).toHaveValue(7))
  expect(warn).toHaveValue(20)
})

it('SettingNumber with allowEmpty writes null for an empty field and shows an unset value empty', async () => {
  vi.mocked(api.saveSettings).mockResolvedValue(initial)
  setup(<SettingNumber label="Cap" settingKey="cap" allowEmpty />)
  const input = screen.getByLabelText('Cap')
  expect(input).toHaveValue(null)
  fireEvent.change(input, { target: { value: '5' } })
  fireEvent.change(input, { target: { value: '' } })
  await waitFor(() => expect(api.saveSettings).toHaveBeenLastCalledWith({ cap: null }))
})

it('SettingText enables Save only while the draft differs, and writes the parsed draft', async () => {
  vi.mocked(api.saveSettings).mockResolvedValue({ ...initial, hosts: ['one.example', 'two.example'] })
  setup(<SettingText label="Hosts" settingKey="hosts" multiline parse={(d) => d.split('\n')} format={(v) => (Array.isArray(v) ? v : []).join('\n')} />)
  const field = screen.getByLabelText('Hosts')
  const save = screen.getByRole('button', { name: 'Save' })
  expect(field).toHaveValue('one.example')
  expect(save).toBeDisabled()
  await user.type(field, 'x')
  expect(save).toBeEnabled()
  await user.type(field, '{Backspace}')
  expect(save).toBeDisabled()
  await user.type(field, '\ntwo.example')
  await user.click(save)
  await waitFor(() => expect(api.saveSettings).toHaveBeenCalledExactlyOnceWith({ hosts: ['one.example', 'two.example'] }))
  await waitFor(() => expect(save).toBeDisabled())
})

it('SettingSegmented shows every option and writes the picked one like SettingSelect (TAL-2131)', async () => {
  vi.mocked(api.saveSettings).mockResolvedValue({ ...initial, mode: 'b' })
  setup(<SettingSegmented label="Mode" settingKey="mode" fallback="a" options={options} />)
  expect(screen.getByRole('radiogroup', { name: 'Mode' })).toHaveAttribute('id', 'settings-mode')
  expect(screen.getByRole('radio', { name: 'Alpha' })).toHaveAttribute('aria-checked', 'true')
  await user.click(screen.getByRole('radio', { name: 'Beta' }))
  await waitFor(() => expect(api.saveSettings).toHaveBeenCalledExactlyOnceWith({ mode: 'b' }))
})


it('every kit row draws its optional icon 18px muted before the label, and none without one (TAL-2131)', () => {
  setup(<>
    <SettingToggle icon={Bell} label="Toggle" settingKey="hide_thing" />
    <SettingSelect icon={Bell} label="Select" settingKey="mode" fallback="a" options={options} />
    <SettingSegmented icon={Bell} label="Segmented" settingKey="mode" fallback="a" options={options} />
    <SettingNumber icon={Bell} label="Number" settingKey="limit" />
    <SettingText icon={Bell} label="Text" settingKey="name" />
    <SettingRow icon={Bell} label="Row">x</SettingRow>
    <SettingAction icon={Bell} label="Action">y</SettingAction>
    <SettingLink icon={Bell} label="Link" onClick={() => undefined} />
    <SettingRow label="Plain">z</SettingRow>
  </>)
  const icons = document.querySelectorAll('[data-row-icon]')
  expect(icons).toHaveLength(8)
  for (const icon of icons) {
    expect(icon).toHaveAttribute('aria-hidden', 'true')
    expect(icon).toHaveAttribute('width', '18')
    expect(icon).toHaveClass('text-muted')
  }
  expect(screen.getByText('Plain').parentElement?.querySelector('[data-row-icon]')).toBeNull()
})

it('SettingsStats lays out labelled figures with mode words and server tones (TAL-2131)', () => {
  render(<SettingsStats label="Usage" stats={[
    { id: 'left', label: 'Left', value: '21%', mode: 'left', title: '21.4% left' },
    { id: 'spend', label: 'Spend', value: '$4.20', tone: 'warning' },
    { id: 'errors', label: 'Errors', value: '3', tone: 'error' },
  ]} />)
  const grid = screen.getByLabelText('Usage')
  expect(grid.tagName).toBe('DL')
  expect(grid).toHaveClass('grid-cols-2', '@min-[521px]:grid-cols-4')
  expect(screen.getByText('Left').tagName).toBe('DT')
  expect(screen.getByText('21%')).toHaveClass('text-lg', 'font-semibold', 'tabular-nums', 'text-strong')
  expect(screen.getByText('left')).toHaveClass('text-xs', 'text-muted')
  expect(screen.getByText('21%').closest('dd')).toHaveAttribute('title', '21.4% left')
  expect(screen.getByText('$4.20')).toHaveClass('text-warning')
  expect(screen.getByText('3')).toHaveClass('text-error')
})

it.each([
  ['SettingToggle with inverted', <SettingToggle label="Row" settingKey="hide_thing" inverted />, async () => {
    await user.click(screen.getByRole('switch', { name: 'Row' }))
  }, () => expect(screen.getByRole('switch', { name: 'Row' })).not.toBeChecked(), () => expect(screen.getByRole('switch', { name: 'Row' })).toBeChecked()],
  ['SettingSelect', <SettingSelect label="Row" settingKey="mode" fallback="a" options={options} />, async () => {
    await user.click(screen.getByRole('combobox', { name: 'Row' }))
    await user.click(await screen.findByRole('option', { name: 'Beta' }))
  }, () => expect(screen.getByRole('combobox', { name: 'Row' })).toHaveTextContent('Beta'), () => expect(screen.getByRole('combobox', { name: 'Row' })).toHaveTextContent('Alpha')],
  ['SettingSegmented', <SettingSegmented label="Row" settingKey="mode" fallback="a" options={options} />, async () => {
    await user.click(screen.getByRole('radio', { name: 'Beta' }))
  }, () => expect(screen.getByRole('radio', { name: 'Beta' })).toHaveAttribute('aria-checked', 'true'), () => expect(screen.getByRole('radio', { name: 'Alpha' })).toHaveAttribute('aria-checked', 'true')],
  ['SettingNumber', <SettingNumber label="Row" settingKey="limit" />, () => {

    fireEvent.change(screen.getByLabelText('Row'), { target: { value: '9' } })
  }, () => expect(screen.getByLabelText('Row')).toHaveValue(9), () => expect(screen.getByLabelText('Row')).toHaveValue(3)],
  ['SettingNumber with a field', <SettingNumber label="Row" settingKey="quota" field="warn" />, async () => {
    await user.clear(screen.getByLabelText('Row'))
    await user.type(screen.getByLabelText('Row'), '30{Enter}')
  }, () => expect(screen.getByLabelText('Row')).toHaveValue(30), () => expect(screen.getByLabelText('Row')).toHaveValue(20)],
  ['SettingText', <SettingText label="Row" settingKey="name" />, async () => {
    await user.clear(screen.getByLabelText('Row'))
    await user.type(screen.getByLabelText('Row'), 'Atlas')
    await user.click(screen.getByRole('button', { name: 'Save' }))
  }, () => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled(), () => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()],
] as const)('%s shows its write at once and rolls back with the error toast when the server refuses it', async (_, ui, write, shown, rolledBack) => {
  const held = deferred<typeof initial>()
  vi.mocked(api.saveSettings).mockReturnValue(held.promise)
  setup(ui)
  await write()
  shown()
  const message = 'config.yaml is package-managed. Update the declarative configuration instead.'
  held.reject(new ApiError({ kind: 'http', status: 409, path: 'api/settings', message, body: { error: message, condition: 'config_write_refused' } }))
  await waitFor(rolledBack)
  expect(showToast).toHaveBeenCalledWith(message, 4000, 'error')
})
