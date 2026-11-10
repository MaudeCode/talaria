/** TAL-2146: the shortcut modifier, ⌘ on Apple platforms and Ctrl elsewhere. */
export const modifierKey = (userAgent: string = navigator.userAgent): string => /Mac|iPhone|iPad/.test(userAgent) ? '⌘' : 'Ctrl'

/** TAL-2146: a key combination as keycaps, one nested `<kbd>` per key; the caps take the surrounding text colour. */
export function Keys({ keys }: { keys: readonly string[] }) {
  return (
    <kbd className="inline-flex items-center gap-1">
      {keys.map((key) => <kbd key={key} className="inline-flex h-5 min-w-5 font-sans items-center justify-center rounded border border-current/30 px-1 text-xs leading-none">{key}</kbd>)}
    </kbd>
  )
}
