import { render as renderUi, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '../../api/endpoints'
import { WebPushSection } from './NotificationsSection'
import { showErrorToast } from '../toast/errorToast'

vi.mock('../../api/endpoints', () => ({ fetchWebPushStatus: vi.fn(), subscribeWebPush: vi.fn(), updateWebPush: vi.fn(), unsubscribeWebPush: vi.fn() }))
vi.mock('../toast/errorToast', () => ({ showErrorToast: vi.fn() }))
let canManage = true
vi.mock('../../app/bootstrap', () => ({ useBootstrap: () => ({ auth: { can_manage_server: canManage } }) }))

const ALL = { notify_on_approval: true, notify_on_input: true, notify_on_completion: true, notify_on_failure: true, notify_on_update_available: false }
const KEY = 'BPublicKeyOnlyForTheTest'
const ENDPOINT = 'https://push.example/send/browser-1'

interface FakeSubscription { endpoint: string; toJSON: () => PushSubscriptionJSON; unsubscribe: ReturnType<typeof vi.fn> }
let current: FakeSubscription | null
const manager = { getSubscription: vi.fn(() => Promise.resolve(current)), subscribe: vi.fn() }
const fakeSubscription = (endpoint: string): FakeSubscription => ({ endpoint, toJSON: () => ({ endpoint, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } }), unsubscribe: vi.fn(() => { current = null; return Promise.resolve(true) }) })

beforeEach(() => {
  vi.resetAllMocks()
  canManage = true
  current = null
  manager.getSubscription.mockImplementation(() => Promise.resolve(current))
  manager.subscribe.mockImplementation(() => { current = fakeSubscription(ENDPOINT); return Promise.resolve(current) })
  vi.stubGlobal('PushManager', {})
  vi.stubGlobal('Notification', { requestPermission: vi.fn(() => Promise.resolve('granted')) })
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve({ pushManager: manager }) } })
})
afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'serviceWorker')
})

const render = (ui: ReactElement) => renderUi(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)
const main = () => screen.getByRole('switch', { name: 'Push to this browser' })

it('is hidden when the browser has no Push API', () => {
  vi.stubGlobal('PushManager', undefined)
  Reflect.deleteProperty(window, 'PushManager')
  const { container } = render(<WebPushSection />)
  expect(container).toBeEmptyDOMElement()
  expect(api.fetchWebPushStatus).not.toHaveBeenCalled()
})

it('subscribes this browser with the server key, then shows the four alert kinds', async () => {
  vi.mocked(api.fetchWebPushStatus).mockResolvedValue({ public_key: KEY, subscription: null })
  vi.mocked(api.subscribeWebPush).mockResolvedValue({ ok: true, preferences: ALL })
  render(<WebPushSection />)
  expect(await screen.findByRole('switch', { name: 'Push to this browser' })).not.toBeChecked()
  expect(main().closest('[data-group="web-push"]')).toHaveAccessibleName('Push')
  expect(screen.queryByRole('switch', { name: 'Approval requests' })).toBeNull()
  await userEvent.click(main())
  expect(main()).toBeChecked()
  await waitFor(() => { expect(api.subscribeWebPush).toHaveBeenCalledWith(ENDPOINT, { p256dh: 'p256dh-key', auth: 'auth-key' }) })
  const options = manager.subscribe.mock.calls[0]![0] as PushSubscriptionOptionsInit
  expect(options.userVisibleOnly).toBe(true)
  expect(Array.from(options.applicationServerKey as Uint8Array)).toEqual(Array.from(atob(KEY), (c) => c.charCodeAt(0)))
  for (const name of ['Approval requests', 'Input requests', 'Completed runs', 'Failed runs']) expect(await screen.findByRole('switch', { name })).toBeChecked()
})

it('rolls the switch back when notification permission is refused', async () => {
  vi.mocked(api.fetchWebPushStatus).mockResolvedValue({ public_key: KEY, subscription: null })
  vi.stubGlobal('Notification', { requestPermission: vi.fn(() => Promise.resolve('denied')) })
  render(<WebPushSection />)
  await userEvent.click(await screen.findByRole('switch', { name: 'Push to this browser' }))
  await waitFor(() => { expect(main()).not.toBeChecked() })
  expect(showErrorToast).toHaveBeenCalled()
  expect(manager.subscribe).not.toHaveBeenCalled()
  expect(api.subscribeWebPush).not.toHaveBeenCalled()
})

it('updates one alert kind at once and unsubscribes on the server and in the browser', async () => {
  current = fakeSubscription(ENDPOINT)
  const subscription = current
  vi.mocked(api.fetchWebPushStatus).mockResolvedValue({ public_key: KEY, subscription: { preferences: ALL } })
  const update = Promise.withResolvers<{ ok: true; preferences: typeof ALL }>()
  vi.mocked(api.updateWebPush).mockReturnValue(update.promise)
  vi.mocked(api.unsubscribeWebPush).mockResolvedValue({ ok: true })
  render(<WebPushSection />)
  const completed = await screen.findByRole('switch', { name: 'Completed runs' })
  expect(api.fetchWebPushStatus).toHaveBeenCalledWith(ENDPOINT)
  await userEvent.click(completed)
  expect(completed).not.toBeChecked()
  expect(api.updateWebPush).toHaveBeenCalledWith(ENDPOINT, { ...ALL, notify_on_completion: false })
  update.resolve({ ok: true, preferences: { ...ALL, notify_on_completion: false } })

  await userEvent.click(main())
  expect(main()).not.toBeChecked()
  expect(screen.queryByRole('switch', { name: 'Completed runs' })).toBeNull()
  await waitFor(() => { expect(api.unsubscribeWebPush).toHaveBeenCalledWith(ENDPOINT) })
  await waitFor(() => { expect(subscription.unsubscribe).toHaveBeenCalled() })
})

it('reconciles with the server when a preference write fails', async () => {
  current = fakeSubscription(ENDPOINT)
  vi.mocked(api.fetchWebPushStatus).mockResolvedValue({ public_key: KEY, subscription: { preferences: ALL } })
  vi.mocked(api.updateWebPush).mockRejectedValue(new Error('Connection lost'))
  render(<WebPushSection />)
  const failed = await screen.findByRole('switch', { name: 'Failed runs' })
  await userEvent.click(failed)
  await waitFor(() => { expect(screen.getByRole('switch', { name: 'Failed runs' })).toBeChecked() })
  expect(showErrorToast).toHaveBeenCalled()
  expect(api.fetchWebPushStatus).toHaveBeenCalledTimes(2)
})

it.each([
  { outcome: 'refused', approval: true },
  { outcome: 'accepted', approval: false },
])('keeps only confirmed edits when the first queued preference is $outcome', async ({ outcome, approval }) => {
  current = fakeSubscription(ENDPOINT)
  let stored = ALL
  const first = Promise.withResolvers<undefined>()
  vi.mocked(api.fetchWebPushStatus).mockImplementation(() => Promise.resolve({ public_key: KEY, subscription: { preferences: stored } }))
  const save = (_endpoint: string, preferences: typeof ALL) => {
    stored = preferences
    return Promise.resolve({ ok: true as const, preferences: stored })
  }
  vi.mocked(api.updateWebPush).mockImplementationOnce(async (endpoint, preferences) => {
    await first.promise
    return save(endpoint, preferences)
  }).mockImplementation(save)

  render(<WebPushSection />)
  const approvals = await screen.findByRole('switch', { name: 'Approval requests' })
  const input = screen.getByRole('switch', { name: 'Input requests' })
  await userEvent.click(approvals)
  await userEvent.click(input)
  expect(approvals).not.toBeChecked()
  expect(input).not.toBeChecked()
  expect(api.updateWebPush).toHaveBeenCalledTimes(1)

  if (outcome === 'refused') first.reject(new Error('Preference update refused'))
  else first.resolve(undefined)

  await waitFor(() => { expect(api.updateWebPush).toHaveBeenCalledTimes(2) })
  expect(stored).toEqual({ ...ALL, notify_on_approval: approval, notify_on_input: false })
  await waitFor(() => { expect(approvals).toHaveAttribute('aria-checked', String(approval)) })
  expect(input).not.toBeChecked()
})

it('skips a queued preference edit after reconciliation finds the subscription removed', async () => {
  current = fakeSubscription(ENDPOINT)
  vi.mocked(api.fetchWebPushStatus)
    .mockResolvedValueOnce({ public_key: KEY, subscription: { preferences: ALL } })
    .mockResolvedValue({ public_key: KEY, subscription: null })
  const first = Promise.withResolvers<never>()
  vi.mocked(api.updateWebPush).mockReturnValue(first.promise)

  render(<WebPushSection />)
  await userEvent.click(await screen.findByRole('switch', { name: 'Approval requests' }))
  await userEvent.click(screen.getByRole('switch', { name: 'Input requests' }))
  expect(main()).toBeChecked()
  expect(api.updateWebPush).toHaveBeenCalledTimes(1)
  first.reject(new Error('Push subscription not found'))

  await waitFor(() => { expect(main()).not.toBeChecked() })
  expect(screen.queryByRole('switch', { name: 'Input requests' })).toBeNull()
  expect(api.updateWebPush).toHaveBeenCalledTimes(1)
})

it('keeps the latest choice when the browser is switched off while turning on', async () => {
  vi.mocked(api.fetchWebPushStatus).mockResolvedValue({ public_key: KEY, subscription: null })
  vi.mocked(api.subscribeWebPush).mockResolvedValue({ ok: true, preferences: ALL })
  vi.mocked(api.unsubscribeWebPush).mockResolvedValue({ ok: true })
  const permission = Promise.withResolvers<NotificationPermission>()
  vi.stubGlobal('Notification', { requestPermission: vi.fn(() => permission.promise) })
  render(<WebPushSection />)
  await userEvent.click(await screen.findByRole('switch', { name: 'Push to this browser' }))
  await userEvent.click(main())
  expect(main()).not.toBeChecked()
  permission.resolve('granted')
  await waitFor(() => { expect(api.unsubscribeWebPush).toHaveBeenCalledWith(ENDPOINT) })
  await waitFor(() => { expect(current).toBeNull() })
  expect(main()).not.toBeChecked()
  expect(screen.queryByRole('switch', { name: 'Approval requests' })).toBeNull()
})

// TAL-2665: an owner opts in to update-available pushes beside the alert kinds; a login that cannot manage the server never sees it.
it('turns the owner-only update alert on at once and rolls it back when the server refuses', async () => {
  current = fakeSubscription(ENDPOINT)
  vi.mocked(api.fetchWebPushStatus).mockResolvedValue({ public_key: KEY, subscription: { preferences: ALL } })
  const refused = Promise.withResolvers<{ ok: true; preferences: typeof ALL }>()
  vi.mocked(api.updateWebPush).mockReturnValueOnce(refused.promise).mockResolvedValueOnce({ ok: true, preferences: { ...ALL, notify_on_update_available: true } })
  render(<WebPushSection />)
  const updates = await screen.findByRole('switch', { name: 'Update available' })
  expect(updates).not.toBeChecked()
  await userEvent.click(updates)
  expect(updates).toBeChecked()
  expect(api.updateWebPush).toHaveBeenCalledWith(ENDPOINT, { ...ALL, notify_on_update_available: true })
  refused.reject(new Error('Push subscription not found'))
  await waitFor(() => { expect(screen.getByRole('switch', { name: 'Update available' })).not.toBeChecked() })
  expect(showErrorToast).toHaveBeenCalled()

  await userEvent.click(screen.getByRole('switch', { name: 'Update available' }))
  await waitFor(() => { expect(api.updateWebPush).toHaveBeenCalledTimes(2) })
  expect(screen.getByRole('switch', { name: 'Update available' })).toBeChecked()
})

it('leaves the update alert out for a login that cannot manage the server', async () => {
  canManage = false
  current = fakeSubscription(ENDPOINT)
  vi.mocked(api.fetchWebPushStatus).mockResolvedValue({ public_key: KEY, subscription: { preferences: ALL } })
  render(<WebPushSection />)
  expect(await screen.findByRole('switch', { name: 'Failed runs' })).toBeChecked()
  expect(screen.queryByRole('switch', { name: 'Update available' })).toBeNull()
})
