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
import { SettingNumber, SettingSelect, SettingText } from './SettingsRows'

vi.mock('../../api/endpoints', () => ({ fetchSettings: vi.fn(), saveSettings: vi.fn() }))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
const initial = { mode: 'a', limit: 3, name: 'Hermes', hosts: ['one.example'] }
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

it.each([
  ['an in-range integer', '7', { limit: 7 }],
  ['an integer above the stepper max, for the server to judge', '51', { limit: 51 }],
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

it.each([
  ['SettingSelect', <SettingSelect label="Row" settingKey="mode" fallback="a" options={options} />, async () => {
    await user.click(screen.getByRole('combobox', { name: 'Row' }))
    await user.click(await screen.findByRole('option', { name: 'Beta' }))
  }, () => expect(screen.getByRole('combobox', { name: 'Row' })).toHaveTextContent('Beta'), () => expect(screen.getByRole('combobox', { name: 'Row' })).toHaveTextContent('Alpha')],
  ['SettingNumber', <SettingNumber label="Row" settingKey="limit" />, () => {
    fireEvent.change(screen.getByLabelText('Row'), { target: { value: '9' } })
  }, () => expect(screen.getByLabelText('Row')).toHaveValue(9), () => expect(screen.getByLabelText('Row')).toHaveValue(3)],
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
