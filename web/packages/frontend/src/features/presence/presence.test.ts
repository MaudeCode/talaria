import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock(import('../../api/client'), async (importOriginal) => ({ ...(await importOriginal()), post: vi.fn(() => Promise.resolve({ ok: true, lease_seconds: 90 }) as never) }))
import { post } from '../../api/client'
import { tabId } from '../../app/tabBuild'
import { IDLE_MS, RENEW_MS, startPresence } from './presence'

let visibility: DocumentVisibilityState = 'visible'
let focused = true
const sent = () => vi.mocked(post).mock.calls.map(([path, body, , opts]) => ({ path, ...(body as { tab_id: string; active: boolean; seq: number }), keepalive: !!opts?.keepalive }))
const actives = () => sent().map((call) => call.active)
let stop: () => void = () => undefined

beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  focused = true
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  vi.mocked(post).mockClear()
})
afterEach(() => { stop(); vi.useRealTimers(); vi.restoreAllMocks() })

it('holds a lease while the tab is in active use and renews it before it lapses', () => {
  stop = startPresence()
  expect(sent()).toEqual([{ path: 'api/talaria/presence', tab_id: tabId, active: true, seq: expect.any(Number), keepalive: false }])
  window.dispatchEvent(new Event('pointerdown'))
  vi.advanceTimersByTime(RENEW_MS)
  expect(actives()).toEqual([true, true])
  window.dispatchEvent(new Event('keydown'))
  vi.advanceTimersByTime(RENEW_MS)
  expect(actives()).toEqual([true, true, true])
  const seqs = sent().map((call) => call.seq)
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  expect(new Set(seqs).size).toBe(seqs.length)
})

it('revokes after two minutes without input and renews at once with a higher sequence on return', () => {
  stop = startPresence()
  vi.advanceTimersByTime(IDLE_MS)
  expect(actives().at(-1)).toBe(false)
  const revokes = actives().filter((active) => !active).length
  vi.advanceTimersByTime(IDLE_MS)
  expect(actives().filter((active) => !active).length).toBe(revokes)
  const before = sent().at(-1)!.seq
  window.dispatchEvent(new Event('pointermove'))
  expect(sent().at(-1)).toMatchObject({ active: true })
  expect(sent().at(-1)!.seq).toBeGreaterThan(before)
})

it('revokes when the tab is hidden or loses focus, and never counts input on a hidden tab', () => {
  stop = startPresence()
  visibility = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
  expect(actives()).toEqual([true, false])
  window.dispatchEvent(new Event('keydown'))
  vi.advanceTimersByTime(RENEW_MS)
  expect(actives()).toEqual([true, false])
  vi.advanceTimersByTime(IDLE_MS * 3)
  visibility = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
  expect(actives()).toEqual([true, false, true])
  focused = false
  window.dispatchEvent(new Event('blur'))
  expect(actives()).toEqual([true, false, true, false])
  focused = true
  window.dispatchEvent(new Event('focus'))
  expect(actives()).toEqual([true, false, true, false, true])
})

it('revokes with keepalive when the page goes away and ignores failed requests', async () => {
  vi.mocked(post).mockImplementation(() => Promise.reject(new Error('offline')))
  stop = startPresence()
  window.dispatchEvent(new Event('pagehide'))
  expect(sent().at(-1)).toMatchObject({ active: false, keepalive: true })
  await vi.runAllTimersAsync()
})

it('stops listening and releases the lease when stopped', () => {
  stop = startPresence()
  stop()
  stop = () => undefined
  expect(actives()).toEqual([true, false])
  window.dispatchEvent(new Event('pointerdown'))
  vi.advanceTimersByTime(IDLE_MS)
  expect(actives()).toEqual([true, false])
})
