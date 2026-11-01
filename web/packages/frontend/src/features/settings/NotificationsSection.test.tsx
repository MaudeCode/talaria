import { render as renderUi, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '../../api/endpoints'
import { NotificationsSection } from './NotificationsSection'
import { showErrorToast } from '../toast/errorToast'

vi.mock('../../api/endpoints', () => ({ fetchWebPushStatus: vi.fn(), subscribeWebPush: vi.fn(), updateWebPush: vi.fn(), unsubscribeWebPush: vi.fn() }))
vi.mock('../toast/errorToast', () => ({ showErrorToast: vi.fn() }))

const ALL = { notify_on_approval: true, notify_on_input: true, notify_on_completion: true, notify_on_failure: true }
const KEY = 'BPublicKeyOnlyForTheTest'
const ENDPOINT = 'https://push.example/send/browser-1'

interface FakeSubscription { endpoint: string; toJSON: () => PushSubscriptionJSON; unsubscribe: ReturnType<typeof vi.fn> }
let current: FakeSubscription | null
const manager = { getSubscription: vi.fn(() => Promise.resolve(current)), subscribe: vi.fn() }
const fakeSubscription = (endpoint: string): FakeSubscription => ({ endpoint, toJSON: () => ({ endpoint, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } }), unsubscribe: vi.fn(() => { current = null; return Promise.resolve(true) }) })

beforeEach(() => {
  vi.resetAllMocks()
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
const main = () => screen.getByRole('switch', { name: 'Notify this browser' })

it('is hidden when the browser has no Push API', () => {
  vi.stubGlobal('PushManager', undefined)
  Reflect.deleteProperty(window, 'PushManager')
  const { container } = render(<NotificationsSection />)
  expect(container).toBeEmptyDOMElement()
  expect(api.fetchWebPushStatus).not.toHaveBeenCalled()
})

it('subscribes this browser with the server key, then shows the four alert kinds', async () => {
  vi.mocked(api.fetchWebPushStatus).mockResolvedValue({ public_key: KEY, subscription: null })
  vi.mocked(api.subscribeWebPush).mockResolvedValue({ ok: true, preferences: ALL })
  render(<NotificationsSection />)
  expect(await screen.findByRole('switch', { name: 'Notify this browser' })).not.toBeChecked()
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
  render(<NotificationsSection />)
  await userEvent.click(await screen.findByRole('switch', { name: 'Notify this browser' }))
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
  render(<NotificationsSection />)
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
  render(<NotificationsSection />)
  const failed = await screen.findByRole('switch', { name: 'Failed runs' })
  await userEvent.click(failed)
  await waitFor(() => { expect(screen.getByRole('switch', { name: 'Failed runs' })).toBeChecked() })
  expect(showErrorToast).toHaveBeenCalled()
  expect(api.fetchWebPushStatus).toHaveBeenCalledTimes(2)
})
