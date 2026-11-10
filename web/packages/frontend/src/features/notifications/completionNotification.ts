/** TAL-2157: a finished reply as a system notification while this tab is hidden. The server composes what it says. */
import type { WebAudioCompletion } from '@maudecode/talaria-web-contracts'
import { appUrl } from '../../lib/appRoot'

export async function notifyCompletion(completion: WebAudioCompletion, enabled: () => boolean): Promise<void> {
  const shown = completion.notification
  const ready = () => enabled() && completion.expires_at > Date.now() && document.visibilityState !== 'visible' && Notification.permission === 'granted'
  if (!shown || !completion.eligible || !('Notification' in window) || !ready()) return
  try {
    const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined
    // This browser's push subscription delivers the same completion; one notification is enough.
    if (await registration?.pushManager?.getSubscription() || !ready()) return
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
