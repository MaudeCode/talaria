import { describe, expect, it } from 'vitest'
import { modifierKey } from './Keys'

describe('Keys (TAL-2146)', () => {
  it.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15', '⌘'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)', '⌘'],
    ['Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X)', '⌘'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Ctrl'],
    ['Mozilla/5.0 (X11; Linux x86_64)', 'Ctrl'],
    ['Mozilla/5.0 (Linux; Android 16; Pixel 10)', 'Ctrl'],
  ])('the modifier for %s is %s', (userAgent, key) => {
    expect(modifierKey(userAgent)).toBe(key)
  })

})
