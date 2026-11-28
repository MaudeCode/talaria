import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { configureClient, resetClientForTests } from '../../api/client'
import { createMemoryAdapter } from '../../contracts/adapters/memory'
import { m } from '../../paraglide/messages.js'
import { SharePage } from './SharePage'

const token = 'sample-share'
const path = `GET /api/share/${token}`

function renderShare() {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })
  render(<QueryClientProvider client={client}><SharePage token={token} /></QueryClientProvider>)
}

afterEach(resetClientForTests)

it.each(['network', 'server-marked'])('retries a %s failure and shows the recovered transcript', async (failure) => {
  let available = false
  const message = 'The shared transcript is back.'
  configureClient({ transport: createMemoryAdapter({ routes: {
    [path]: () => {
      if (available) return [200, { share: { title: 'Shared conversation', message_count: 1, messages: [{ role: 'user', content: message }] } }]
      if (failure === 'network') throw new TypeError('Failed to fetch')
      return [500, { error: 'Could not load shared conversation', retryable: true }]
    },
  } }) })
  renderShare()

  const alert = await screen.findByRole('alert')
  const retry = within(alert).getByRole('button', { name: m.retry() })
  expect(screen.queryByText(m.share_error_detail())).not.toBeInTheDocument()
  available = true
  fireEvent.click(retry)

  expect(await screen.findByText(message)).toBeVisible()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('shows a load error without Retry when an HTTP response supplies no retry decision', async () => {
  configureClient({ transport: createMemoryAdapter({ routes: {
    [path]: () => [503, { error: 'Service unavailable' }],
  } }) })
  renderShare()

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent(m.share_error_title())
  expect(screen.queryByText(m.share_error_detail())).not.toBeInTheDocument()
  expect(within(alert).queryByRole('button', { name: m.retry() })).not.toBeInTheDocument()
})

it('explains a missing share without offering Retry', async () => {
  configureClient({ transport: createMemoryAdapter({ routes: {
    [path]: () => [404, { error: 'Shared conversation not found' }],
  } }) })
  renderShare()

  const alert = await screen.findByRole('alert')
  expect(screen.getByRole('heading', { name: m.share_unavailable_title() })).toBeVisible()
  expect(alert).toHaveTextContent(m.share_error_detail())
  expect(within(alert).queryByRole('button', { name: m.retry() })).not.toBeInTheDocument()
})
