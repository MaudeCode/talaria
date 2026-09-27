/**
 * This tab's identity and the frontend build it loaded, sent with notification
 * checks so the server can decide when this tab runs a stale bundle (TAL-363).
 * The tab id lives in sessionStorage so a reload of the same tab keeps it and
 * the server can verify the reloaded build before clearing the refresh notice.
 */
const TAB_KEY = 'talaria-tab-id'

function readTabId(): string {
  // getRandomValues, unlike randomUUID, also works on plain-HTTP LAN installs.
  const fresh = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')
  try {
    const stored = sessionStorage.getItem(TAB_KEY)
    if (stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) return stored
    sessionStorage.setItem(TAB_KEY, fresh)
  } catch { /* storage unavailable: the id lasts for this page load only */ }
  return fresh
}

export const tabId = readTabId()
/** Stamped into the shell by `scripts/finalize-dist.mjs`; absent in dev, where no check runs. */
export const loadedBuild = document.querySelector<HTMLMetaElement>('meta[name="talaria-build"]')?.content || undefined
