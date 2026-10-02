/**
 * Browser presence (TAL-439): while this tab is in active use (visible,
 * focused, and touched within IDLE_MS) it holds the server's per-tab presence
 * lease, which marks relay snapshots alert-ineligible so the phone stays quiet
 * and starts no Live Activity. Going idle, hidden, unfocused, or away revokes
 * the lease so phone alerts resume. The server owns the lease and its effect.
 */
import { z } from 'zod'
import { post } from '../../api/client'
import { tabId } from '../../app/tabBuild'

export const IDLE_MS = 120_000
/** Well inside the server's 90 s lease. */
export const RENEW_MS = 30_000
const LeaseSchema = z.object({ ok: z.literal(true), lease_seconds: z.number() })
// Not `scroll`: a streaming transcript scrolls itself, and user scrolling arrives as wheel, touch, key, or pointer input.
const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']

export function startPresence(): () => void {
  // Seeded per page load so a reload never reuses an older sequence.
  let seq = Date.now()
  let lastInput = Date.now()
  let lastSent = 0
  let active = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const send = (next: boolean, keepalive = false): void => {
    active = next
    lastSent = Date.now()
    seq += 1
    void post('api/talaria/presence', { tab_id: tabId, active: next, seq }, LeaseSchema, { retries: 0, redirect401: false, keepalive }).catch(() => undefined)
  }
  const shown = (): boolean => document.visibilityState === 'visible' && document.hasFocus()
  const tick = (): void => {
    clearTimeout(timer)
    const now = Date.now()
    if (!shown() || now - lastInput >= IDLE_MS) {
      if (active) send(false)
      return
    }
    if (!active || now - lastSent >= RENEW_MS) send(true)
    timer = setTimeout(tick, Math.max(0, Math.min(lastSent + RENEW_MS, lastInput + IDLE_MS) - Date.now()))
  }
  const onInput = (): void => {
    if (!shown()) return
    lastInput = Date.now()
    if (!active) tick()
  }
  // Returning to the tab is itself a user action.
  const onShow = (): void => {
    if (shown()) lastInput = Date.now()
    tick()
  }
  const onPageHide = (): void => {
    clearTimeout(timer)
    if (active) send(false, true)
  }

  for (const event of INPUT_EVENTS) window.addEventListener(event, onInput, { capture: true, passive: true })
  window.addEventListener('focus', onShow)
  window.addEventListener('blur', tick)
  window.addEventListener('pagehide', onPageHide)
  document.addEventListener('visibilitychange', onShow)
  tick()

  return () => {
    for (const event of INPUT_EVENTS) window.removeEventListener(event, onInput, { capture: true })
    window.removeEventListener('focus', onShow)
    window.removeEventListener('blur', tick)
    window.removeEventListener('pagehide', onPageHide)
    document.removeEventListener('visibilitychange', onShow)
    onPageHide()
  }
}
