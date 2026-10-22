import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// Component tests own synthetic session data. Feed behavior is exercised by the
// transcript hook's explicit transport mock and the browser's real SSE tests.
vi.mock('../api/sse', async (original) => ({
  ...await original<object>(),
  openSessionStream: () => ({ close: () => undefined, readyState: () => 1 }),
}))

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  window.sessionStorage.clear()
})
