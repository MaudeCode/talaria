import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/**
 * TAL-1860: this keystroke belongs to an IME composition, such as the Enter that accepts a candidate, so the app must not act on it.
 * Safari reports that Enter after `compositionend`, with `isComposing` false and keyCode 229.
 */
export function isImeEnter(event: KeyboardEvent | ReactKeyboardEvent): boolean {
  const native = 'nativeEvent' in event ? event.nativeEvent : event
  // oxlint-disable-next-line typescript/no-deprecated -- keyCode 229 is Safari's only signal for this Enter.
  return native.isComposing || native.keyCode === 229
}
