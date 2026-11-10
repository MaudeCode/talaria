import { useEffect, useRef, useState } from 'react'
import { AppWindow, RefreshCw, Smartphone, Volume2 } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { WebPushPreferences } from '@maudecode/talaria-web-contracts'
import { webPushSupported } from '../../app/pwa'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { m } from '../../paraglide/messages.js'
import { Switch } from '../../ui/Field'
import { IconButton } from '../../ui/Button'
import { StatusDot, type DotState } from '../../ui/Badge'
import { ErrorState, LoadingState, errorText } from '../../ui/States'
import { showErrorToast } from '../toast/errorToast'
import { CompletionAudioSettings } from './CompletionAudioSettings'
import { useSettingField } from './useSettingField'
import { SettingRow, SettingToggle, SettingsGroup, SETTINGS_PAGE } from './SettingsRows'

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

type Permission = NotificationPermission | 'unsupported'
const PERMISSION: Record<Permission, { state: DotState; text: () => string }> = {
  granted: { state: 'ok', text: m.settings_notifications_allowed },
  denied: { state: 'warning', text: m.settings_notifications_blocked },
  default: { state: 'idle', text: m.settings_notifications_not_asked },
  unsupported: { state: 'idle', text: m.settings_notifications_unsupported },
}

const readPermission = (): Permission => 'Notification' in window ? Notification.permission : 'unsupported'

/** TAL-2146: this browser's notification permission (platform state), following a change made in the browser's settings. */
function useNotificationPermission(): Permission {
  const [permission, setPermission] = useState(readPermission)
  useEffect(() => {
    let status: PermissionStatus | undefined
    let live = true
    const update = () => setPermission(readPermission())
    void navigator.permissions?.query({ name: 'notifications' }).then((s) => { if (!live) return; status = s; s.addEventListener('change', update) }, () => undefined)
    return () => { live = false; status?.removeEventListener('change', update) }
  }, [])
  return permission
}

/** TAL-1691, TAL-2086, TAL-2146: Settings > Notifications, in-app alerts with the browser's permission, the reply sound on this device, then this browser's push subscription. */
export function NotificationsSection() {
  const { settings } = useSettingField(['notifications_enabled', 'sound_enabled'])
  const permission = useNotificationPermission()
  if (settings.isPending) return <LoadingState />
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => { void settings.refetch() }} />
  const shown = PERMISSION[permission] ?? PERMISSION.default
  return (
    <div className={SETTINGS_PAGE} data-section="notifications">
      <SettingsGroup id="while-open" title={m.settings_group_while_open()}>
        <SettingToggle label={m.settings_label_notifications()} settingKey="notifications_enabled" icon={AppWindow} disabled={permission === 'unsupported'}
          detail={<StatusDot state={shown.state}>{shown.text()}</StatusDot>} />
        <SettingToggle label={m.settings_label_sound()} settingKey="sound_enabled" icon={Volume2} />
      </SettingsGroup>
      <SettingsGroup id="reply-finishes" title={m.settings_group_reply_finishes()}><CompletionAudioSettings /></SettingsGroup>
      <WebPushSection />
    </div>
  )
}

export function WebPushSection() {
  return webPushSupported() ? <SettingsGroup id="web-push" title={m.settings_group_web_push()}><WebPushSettings /></SettingsGroup> : null
}

interface Shown { enabled: boolean; preferences: WebPushPreferences | null }

/**
 * Optimistic: each switch moves at once. Writes run one at a time against the latest confirmed state, so the last
 * choice wins; a failed write reconciles with the server, else falls back to the last confirmed state.
 */
function WebPushSettings() {
  const qc = useQueryClient()
  const status = useQuery({ queryKey: keys.webPush, queryFn: readConfirmed })
  const [overlay, setOverlay] = useState<Shown | null>(null)
  const queue = useRef({ tail: Promise.resolve(), pending: 0 })
  if (status.isPending) return <LoadingState />
  // A failed reconcile keeps showing the last confirmed state.
  if (!status.data) return (
    <SettingRow label={m.settings_label_web_push()} htmlFor="settings-web_push" icon={Smartphone} detail={<StatusDot state="error" title={errorText(status.error)}>{errorText(status.error)}</StatusDot>}>
      <IconButton variant="default" label={m.retry()} onClick={() => { void status.refetch() }}><RefreshCw aria-hidden="true" /></IconButton>
    </SettingRow>
  )
  const shown: Shown = overlay ?? { enabled: status.data.endpoint !== null, preferences: status.data.preferences }

  const latest = (): Confirmed => qc.getQueryData<Confirmed>(keys.webPush) ?? status.data
  const confirm = (next: Confirmed) => { qc.setQueryData(keys.webPush, next) }
  const fail = async (e: unknown) => {
    showErrorToast(e)
    await status.refetch().catch(() => undefined)
  }
  /** The overlay stays until every queued write settles, so an earlier write never flips the switch back. */
  const run = (write: () => Promise<void>) => {
    const q = queue.current
    q.pending += 1
    q.tail = q.tail.then(write).catch(fail).finally(() => { q.pending -= 1; if (!q.pending) setOverlay(null) })
  }

  const enable = async () => {
    if ((await Notification.requestPermission()) !== 'granted') throw new Error(m.settings_web_push_blocked())
    const manager = await pushManager()
    // A subscription the server does not know may carry an old application key; replace it.
    await (await manager.getSubscription())?.unsubscribe()
    const subscription = await manager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(latest().publicKey) })
    const { keys: subscriptionKeys } = subscription.toJSON()
    const saved = await api.subscribeWebPush(subscription.endpoint, { p256dh: subscriptionKeys?.p256dh ?? '', auth: subscriptionKeys?.auth ?? '' })
    confirm({ ...latest(), endpoint: subscription.endpoint, preferences: saved.preferences })
  }

  const disable = async () => {
    const subscription = await (await pushManager()).getSubscription()
    const { endpoint } = latest()
    if (endpoint) await api.unsubscribeWebPush(endpoint)
    await subscription?.unsubscribe()
    confirm({ ...latest(), endpoint: null, preferences: null })
  }

  const toggle = (enabled: boolean) => {
    setOverlay({ enabled, preferences: enabled ? shown.preferences : null })
    run(enabled ? enable : disable)
  }

  const setKind = (current: WebPushPreferences, key: keyof WebPushPreferences, value: boolean) => {
    const preferences = { ...current, [key]: value }
    setOverlay({ enabled: true, preferences })
    run(async () => {
      const { endpoint } = latest()
      if (!endpoint) return
      const saved = await api.updateWebPush(endpoint, preferences)
      confirm({ ...latest(), preferences: saved.preferences })
    })
  }

  const preferences = shown.enabled ? shown.preferences : null
  return (
    <>
      <SettingRow label={m.settings_label_web_push()} htmlFor="settings-web_push" icon={Smartphone}
        detail={<StatusDot state={shown.enabled ? 'ok' : 'idle'}>{shown.enabled ? m.settings_web_push_subscribed() : m.settings_web_push_not_subscribed()}</StatusDot>}>
        <Switch id="settings-web_push" checked={shown.enabled} onCheckedChange={toggle} />
      </SettingRow>
      {preferences && KINDS.map(({ key, label }) => (
        <SettingRow key={key} label={label()} htmlFor={`settings-${key}`}>
          <Switch id={`settings-${key}`} checked={preferences[key]} onCheckedChange={(checked) => { setKind(preferences, key, checked) }} />
        </SettingRow>
      ))}
    </>
  )
}
