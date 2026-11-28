/** Find the next item in a wrapping keyboard focus group. */
export function rovingIndex(key: string, current: number, count: number, { vertical = false, rtl = false } = {}): number | null {
  if (count === 0) return null
  if (key === 'Home') return 0
  if (key === 'End') return count - 1

  const forward = key === (rtl ? 'ArrowLeft' : 'ArrowRight') || (vertical && key === 'ArrowDown')
  const backward = key === (rtl ? 'ArrowRight' : 'ArrowLeft') || (vertical && key === 'ArrowUp')
  if (forward) return (current + 1) % count
  if (backward) return (current - 1 + count) % count
  return null
}
