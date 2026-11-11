import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// Component tests own synthetic session data. Feed behavior is exercised by the
// transcript hook's explicit transport mock and the browser's real SSE tests.
vi.mock('../api/sse', async (original) => ({
  ...await original<object>(),
  openSessionStream: () => ({ close: () => undefined, readyState: () => 1 }),
}))

// jsdom has no matchMedia: a page that reads a media query (Settings › Chat's phone rule, TAL-2160) renders as on a wide
// screen unless its test stubs one.
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false })) as unknown as typeof window.matchMedia

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  window.sessionStorage.clear()
})
