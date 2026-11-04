import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { showToast } from '../features/toast/toast'
import { m } from '../paraglide/messages.js'
import { copyText, copyWithToast } from './clipboard'

vi.mock('../features/toast/toast', () => ({ showToast: vi.fn() }))

// jsdom implements neither API, so each test installs the ones its browser would have.
const execCommand = vi.fn<(command: string) => boolean>()
const setClipboard = (value: unknown) => Object.defineProperty(navigator, 'clipboard', { configurable: true, value })

beforeEach(() => {
  execCommand.mockReset()
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
})

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard')
  Reflect.deleteProperty(document, 'execCommand')
})

it('copies through a selected textarea without the Clipboard API, then cleans up and restores focus', async () => {
  const input = document.body.appendChild(document.createElement('input'))
  input.focus()
  let selected = ''
  execCommand.mockImplementation((command) => {
    const field = document.activeElement as HTMLTextAreaElement
    selected = command === 'copy' ? field.value.slice(field.selectionStart, field.selectionEnd) : ''
    return true
  })
  await expect(copyText('hello')).resolves.toBe(true)
  expect(selected).toBe('hello')
  expect(document.querySelector('textarea')).toBeNull()
  expect(document.activeElement).toBe(input)
  input.remove()
})

it('falls back when the Clipboard API rejects', async () => {
  setClipboard({ writeText: vi.fn(() => Promise.reject(new Error('denied'))) })
  execCommand.mockReturnValue(true)
  await expect(copyText('hello')).resolves.toBe(true)
  expect(execCommand).toHaveBeenCalledWith('copy')
})

it.each([
  ['refuses', () => false],
  ['throws', () => { throw new Error('blocked') }],
])('reports failure when the fallback %s', async (_name, refuse) => {
  execCommand.mockImplementation(refuse)
  await expect(copyText('hello')).resolves.toBe(false)
  expect(document.querySelector('textarea')).toBeNull()
})

it('turns a refused copy into an error toast instead of silence', async () => {
  execCommand.mockReturnValue(false)
  copyWithToast('hello')
  await vi.waitFor(() => { expect(showToast).toHaveBeenCalledWith(m.copy_failed(), 3000, 'error') })
})
