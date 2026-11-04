import { showToast } from '../features/toast/toast'
import { m } from '../paraglide/messages.js'

/** Hidden-textarea copy, the only route on plain-HTTP origins, where the Clipboard API does not exist. */
function copyFromTextarea(text: string): boolean {
  const focused = document.activeElement
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  // 16px stops iOS zooming into the focused field.
  textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px'
  document.body.append(textarea)
  textarea.focus({ preventScroll: true })
  textarea.select()
  textarea.setSelectionRange(0, text.length)
  try {
    // oxlint-disable-next-line typescript/no-deprecated -- no replacement exists outside a secure context.
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true })
  }
}

/** Copies text and resolves false when the browser refuses. The one caller of `navigator.clipboard`. */
export async function copyText(text: string): Promise<boolean> {
  try {
    // oxlint-disable-next-line no-restricted-properties -- this helper owns the insecure-context fallback.
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return copyFromTextarea(text)
  }
}

/** Copies text and reports the outcome in a toast. */
export function copyWithToast(text: string, copied = m.copied(), failed = m.copy_failed()): void {
  void copyText(text).then((ok) => { if (ok) showToast(copied); else showToast(failed, 3000, 'error') })
}
