import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { WebPushPreferences } from '@maudecode/talaria-web-contracts'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { m } from '../../paraglide/messages.js'
import { FieldRow, Switch } from '../../ui/Field'
import { ErrorState, LoadingState } from '../../ui/States'
import { showErrorToast } from '../toast/errorToast'

/** Browser push needs a service worker and the Push API; without them the section is not offered. */
export function webPushSupported(): boolean {
  return typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window && 'serviceWorker' in navigator
}

const KINDS: { key: keyof WebPushPreferences; label: () => string }[] = [
  { key: 'notify_on_approval', label: () => m.settings_label_notify_approval() },
  { key: 'notify_on_input', label: () => m.settings_label_notify_input() },
  { key: 'notify_on_completion', label: () => m.settings_label_notify_completion() },
  { key: 'notify_on_failure', label: () => m.settings_label_notify_failure() },
]

interface Confirmed { publicKey: string; endpoint: string | null; preferences: WebPushPreferences | null }

async function pushManager(): Promise<PushManager> { return (await navigator.serviceWorker.ready).pushManager }

/** The server's view of this browser's endpoint: its public key and, when subscribed, the alert preferences. */
async function readConfirmed(): Promise<Confirmed> {
  const endpoint = (await (await pushManager()).getSubscription())?.endpoint ?? null
  const status = await api.fetchWebPushStatus(endpoint ?? undefined)
  return { publicKey: status.public_key, endpoint: status.subscription ? endpoint : null, preferences: status.subscription?.preferences ?? null }
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const raw = atob(base64url.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

export function NotificationsSection() {
  return webPushSupported() ? <WebPushSettings /> : null
}

interface Shown { enabled: boolean; preferences: WebPushPreferences | null }

/** Optimistic: each switch moves at once; a failed write reconciles with the server, else falls back to the last confirmed state. */
function WebPushSettings() {
  const qc = useQueryClient()
  const status = useQuery({ queryKey: keys.webPush, queryFn: readConfirmed })
  const [overlay, setOverlay] = useState<Shown | null>(null)
  if (status.isPending) return <LoadingState />
  // A failed reconcile keeps showing the last confirmed state.
  if (!status.data) return <ErrorState error={status.error} onRetry={() => { void status.refetch() }} />
  const last = status.data
  const shown: Shown = overlay ?? { enabled: last.endpoint !== null, preferences: last.preferences }

  const confirm = (next: Confirmed) => { qc.setQueryData(keys.webPush, next); setOverlay(null) }
  const fail = (e: unknown) => {
    showErrorToast(e)
    void status.refetch().finally(() => { setOverlay(null) })
  }

  const enable = async () => {
    if ((await Notification.requestPermission()) !== 'granted') throw new Error(m.settings_web_push_blocked())
    const manager = await pushManager()
    // A subscription the server does not know may carry an old application key; replace it.
    await (await manager.getSubscription())?.unsubscribe()
    const subscription = await manager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(last.publicKey) })
    const { keys: subscriptionKeys } = subscription.toJSON()
    const saved = await api.subscribeWebPush(subscription.endpoint, { p256dh: subscriptionKeys?.p256dh ?? '', auth: subscriptionKeys?.auth ?? '' })
    confirm({ ...last, endpoint: subscription.endpoint, preferences: saved.preferences })
  }

  const disable = async () => {
    const subscription = await (await pushManager()).getSubscription()
    if (last.endpoint) await api.unsubscribeWebPush(last.endpoint)
    await subscription?.unsubscribe()
    confirm({ ...last, endpoint: null, preferences: null })
  }

  const toggle = (enabled: boolean) => {
    setOverlay({ enabled, preferences: enabled ? shown.preferences : null })
    void (enabled ? enable() : disable()).catch(fail)
  }

  const setKind = (current: WebPushPreferences, key: keyof WebPushPreferences, value: boolean) => {
    if (!last.endpoint) return
    const preferences = { ...current, [key]: value }
    setOverlay({ enabled: true, preferences })
    api.updateWebPush(last.endpoint, preferences).then((saved) => { confirm({ ...last, preferences: saved.preferences }) }, fail)
  }

  const preferences = shown.enabled ? shown.preferences : null
  return (
    <div className="flex flex-col divide-y divide-border-subtle" data-section="notifications">
      <FieldRow label={m.settings_label_web_push()} htmlFor="settings-web_push" inline>
        <Switch id="settings-web_push" checked={shown.enabled} onCheckedChange={toggle} />
      </FieldRow>
      {preferences && KINDS.map(({ key, label }) => (
        <FieldRow key={key} label={label()} htmlFor={`settings-${key}`} inline>
          <Switch id={`settings-${key}`} checked={preferences[key]} onCheckedChange={(checked) => { setKind(preferences, key, checked) }} />
        </FieldRow>
      ))}
    </div>
  )
}
