/** TAL-2157: a finished reply as a system notification while this tab is hidden. The server composes what it says. */
import type { WebAudioCompletion } from '@maudecode/talaria-web-contracts'
import { appUrl } from '../../lib/appRoot'

/** TAL-2478: this browser's Web Push endpoint, which the session list stream sends so the server can say `push_delivers`. */
export async function pushEndpoint(): Promise<string | undefined> {
  try { return (await (await navigator.serviceWorker?.getRegistration())?.pushManager?.getSubscription())?.endpoint } catch { return undefined }
}

export async function notifyCompletion(completion: WebAudioCompletion, enabled: () => boolean): Promise<void> {
  const shown = completion.notification
  const ready = () => enabled() && completion.expires_at > Date.now() && document.visibilityState !== 'visible' && Notification.permission === 'granted'
  // TAL-2478: the server says when Web Push already shows this completion in this browser.
  if (!shown || !completion.eligible || completion.push_delivers || !('Notification' in window) || !ready()) return
  try {
    const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined
    if (!ready()) return
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
