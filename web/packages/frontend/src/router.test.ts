import { createMemoryHistory } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, expect, it } from 'vitest'
import { configureClient, resetClientForTests } from './api/client'
import { createMemoryAdapter, DEFAULT_BOOTSTRAP, makeSession } from './contracts/adapters/memory'
import { getRouter } from './router'

afterEach(resetClientForTests)

it.each([
  ['000123', '/session/000123'],
  ['missing', '/?action=show-chats'],
])('replaces the Handoff URL for %s with its destination', async (session, destination) => {
  configureClient({ transport: createMemoryAdapter({ sessions: [makeSession(), makeSession({ session_id: '000123' })] }) })
  localStorage.setItem('hermes-webui-session', 'sess-1')
  const history = createMemoryHistory({ initialEntries: ['/settings', `/open?session=${session}`] })
  const router = getRouter({ queryClient: new QueryClient(), bootstrap: DEFAULT_BOOTSTRAP })
  router.update({ ...router.options, history })

  await router.load()

  expect(history.location.href).toBe(destination)
  expect(history.length).toBe(2)
})
