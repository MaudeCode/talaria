import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { FeedbackSubmitSchema } from '@maudecode/talaria-web-contracts'
import { deferred } from '../../test/fixtures'

vi.mock('../../api/endpoints', () => ({ submitFeedback: vi.fn(), fetchFeedbackDiagnostics: vi.fn() }))
vi.mock('../toast/toast', () => ({ showToast: vi.fn(), showRichToast: vi.fn(), dismissToast: vi.fn() }))

// The component's ApiError class comes from the same fresh module graph.
let ApiError: typeof import('../../contracts/common').ApiError
// The draft and open state live at module scope (a send outlives the section), so each case loads fresh modules.
async function setup() {
  const api = await import('../../api/endpoints')
  const toasts = await import('../toast/toast')
  const { HelpSection } = await import('./HelpSection')
  ;({ ApiError } = await import('../../contracts/common'))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={qc}><HelpSection /></QueryClientProvider>)
  return { submit: vi.mocked(api.submitFeedback), diagnostics: vi.mocked(api.fetchFeedbackDiagnostics), toast: vi.mocked(toasts.showToast), sentToast: vi.mocked(toasts.showRichToast), dismiss: vi.mocked(toasts.dismissToast), ...view }
}
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }))
const title = () => screen.getByRole('textbox', { name: 'Title' })
const details = () => screen.getByRole('textbox', { name: 'Details' })
const send = () => screen.getByRole('button', { name: 'Send' })
function fill(kind = 'Feature request') {
  fireEvent.click(screen.getByRole('button', { name: kind }))
  fireEvent.change(title(), { target: { value: 'Composer loses text' } })
  fireEvent.change(details(), { target: { value: 'After reconnecting the composer is empty.' } })
}
const closed = () => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
const limited = () => new ApiError({ kind: 'http', status: 429, body: { error: 'rate_limited', retryAfterSeconds: 42 }, path: 'api/feedback/submit', message: 'rate_limited' })
const unreachable = () => new ApiError({ kind: 'http', status: 502, body: { error: 'relay_unreachable' }, path: 'api/feedback/submit', message: 'relay_unreachable' })
const lost = () => new ApiError({ kind: 'network', path: 'api/feedback/submit', message: 'Failed to fetch' })

// Transform the module graph once; every case then re-evaluates it cheaply.
beforeAll(async () => { await import('./HelpSection') }, 60_000)

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  localStorage.clear()
})

it('opens from Help with kind, title, details and diagnostics; Send needs a title and details within their limits', async () => {
  await setup()
  open()
  expect(screen.getByRole('dialog', { name: 'Send feedback' })).toBeVisible()
  expect(screen.getByRole('group', { name: 'Type' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Bug' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('checkbox', { name: 'Include diagnostics' })).toBeChecked()
  expect(title()).toHaveAttribute('maxLength', '120')
  expect(details()).toHaveAttribute('maxLength', '8000')
  expect(send()).toBeDisabled()
  fireEvent.change(title(), { target: { value: 'Only a title' } })
  expect(send()).toBeDisabled()
  fireEvent.change(details(), { target: { value: '   ' } })
  expect(send()).toBeDisabled()
  fireEvent.change(details(), { target: { value: 'And details' } })
  expect(send()).toBeEnabled()
})

it('fetches the diagnostics only when the disclosure opens and shows the server text verbatim', async () => {
  const { diagnostics } = await setup()
  diagnostics.mockResolvedValue({ text: 'Web: 1.4.0\nRelay registered: no', bytes: 31 })
  open()
  expect(diagnostics).not.toHaveBeenCalled()
  const disclosure = screen.getByText('Show diagnostics').closest('details')!
  disclosure.open = true
  fireEvent(disclosure, new Event('toggle'))
  await waitFor(() => expect(document.querySelector('[data-feedback-diagnostics]')?.textContent).toBe('Web: 1.4.0\nRelay registered: no'))
  expect(diagnostics).toHaveBeenCalledTimes(1)
})

it('closes and confirms before the response, then clears the draft once the server accepts it', async () => {
  const { submit, sentToast, dismiss } = await setup()
  const held = deferred<{ status: 'sent'; reportId: string }>()
  submit.mockReturnValue(held.promise)
  open()
  fill()
  fireEvent.click(send())
  await closed()
  expect(sentToast).toHaveBeenCalledWith(expect.objectContaining({ id: 'feedback-sent', text: 'Feedback sent', kind: 'info' }))
  expect(submit).toHaveBeenCalledWith({ requestId: expect.any(String) as string, kind: 'feature', title: 'Composer loses text', body: 'After reconnecting the composer is empty.', includeDiagnostics: true, client: { platform: 'web' } })
  expect(FeedbackSubmitSchema.safeParse(submit.mock.calls[0]![0]).success).toBe(true)
  expect(localStorage.getItem('hermes-feedback-draft')).toContain('Composer loses text')
  held.resolve({ status: 'sent', reportId: 'synthetic-report-1' })
  await waitFor(() => expect(localStorage.getItem('hermes-feedback-draft')).toBeNull())
  expect(dismiss).not.toHaveBeenCalled()
  open()
  expect(title()).toHaveValue('')
  expect(details()).toHaveValue('')
})

it('reopens with the same draft and the error when a held send is rate limited; a retry reuses its requestId', async () => {
  const { submit, toast, dismiss } = await setup()
  const held = deferred<never>()
  submit.mockReturnValueOnce(held.promise)
  open()
  fill('Other')
  fireEvent.click(send())
  await closed()
  held.reject(limited())
  await screen.findByRole('dialog', { name: 'Send feedback' })
  expect(title()).toHaveValue('Composer loses text')
  expect(details()).toHaveValue('After reconnecting the composer is empty.')
  expect(screen.getByRole('button', { name: 'Other' })).toHaveAttribute('aria-pressed', 'true')
  expect(dismiss).toHaveBeenCalledWith('feedback-sent')
  expect(toast).toHaveBeenLastCalledWith(expect.stringMatching(/^Feedback limit reached\. Try again in 42\s?s\.$/), 4000, 'error')
  expect(submit).toHaveBeenCalledTimes(1)
  submit.mockResolvedValueOnce({ status: 'sent', reportId: 'synthetic-report-1' })
  fireEvent.click(send())
  await closed()
  expect(submit).toHaveBeenCalledTimes(2)
  expect(submit.mock.calls[1]![0].requestId).toBe(submit.mock.calls[0]![0].requestId)
})

it.each([['a lost connection', lost], ['Relay unreachable', unreachable]])('retries %s once with the same requestId, then rolls back', async (_name, failure) => {
  const { submit, toast } = await setup()
  submit.mockRejectedValue(failure())
  open()
  fill()
  fireEvent.click(send())
  await screen.findByRole('dialog', { name: 'Send feedback' })
  expect(submit).toHaveBeenCalledTimes(2)
  expect(submit.mock.calls[1]![0].requestId).toBe(submit.mock.calls[0]![0].requestId)
  expect(title()).toHaveValue('Composer loses text')
  expect(toast).toHaveBeenLastCalledWith("Couldn't reach the feedback service.", 4000, 'error')
})

it('sends includeDiagnostics false when unchecked and keeps the draft across a reload', async () => {
  const first = await setup()
  open()
  fill('Bug')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include diagnostics' }))
  first.unmount()
  vi.resetModules()
  const { submit } = await setup()
  submit.mockResolvedValue({ status: 'sent', reportId: 'synthetic-report-1' })
  open()
  expect(title()).toHaveValue('Composer loses text')
  expect(screen.getByRole('checkbox', { name: 'Include diagnostics' })).not.toBeChecked()
  fireEvent.click(send())
  await closed()
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'bug', includeDiagnostics: false }))
})
