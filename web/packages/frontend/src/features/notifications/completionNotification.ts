/** TAL-2157: a finished reply as a system notification while this tab is hidden. The server composes what it says. */
import type { WebAudioCompletion } from '@maudecode/talaria-web-contracts'
import * as api from '../../api/endpoints'
import { appUrl } from '../../lib/appRoot'

/** The server holds this browser's subscription for the current profile and login with completions on, so Web Push sends it. */
async function pushDelivers(registration: ServiceWorkerRegistration | undefined): Promise<boolean> {
  const endpoint = (await registration?.pushManager?.getSubscription())?.endpoint
  if (!endpoint) return false
  // An unreachable server cannot confirm the push; show this one, and the chat's tag folds any duplicate.
  return (await api.fetchWebPushStatus(endpoint).catch(() => null))?.subscription?.preferences.notify_on_completion === true
}

export async function notifyCompletion(completion: WebAudioCompletion, enabled: () => boolean): Promise<void> {
  const shown = completion.notification
  const ready = () => enabled() && completion.expires_at > Date.now() && document.visibilityState !== 'visible' && Notification.permission === 'granted'
  if (!shown || !completion.eligible || !('Notification' in window) || !ready()) return
  try {
    const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined
    if (await pushDelivers(registration) || !ready()) return
    // The chat's tag makes the next completion of that chat replace this one, here and from Web Push alike.
    const options = { body: shown.body, tag: shown.tag, data: { url: shown.url } }
    // The worker's click handler focuses this tab and opens the chat, as it does for a push.
    if (registration?.active) { await registration.showNotification(shown.title, options); return }
    const notification = new Notification(shown.title, options)
    notification.onclick = () => {
      notification.close()
      window.focus()
      window.location.assign(appUrl(shown.url).href)
    }
  } catch { /* A failed notification is never replayed. */ }
}
