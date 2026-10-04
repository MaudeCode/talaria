import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock(import('../../api/endpoints'), async (importOriginal) => ({
  ...(await importOriginal()),
  fetchWorkspaces: vi.fn(() => Promise.resolve({ workspaces: [], last: null })),
}))
import { WorkspacesPage } from './WorkspacesPage'

describe('WorkspacesPage', () => {
  it('keeps the page explanation behind the title help button', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><WorkspacesPage /></QueryClientProvider>)
    expect(await screen.findByText('No workspaces yet')).toBeVisible()
    expect(screen.queryByText('Add and switch workspaces for your sessions.')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'About Spaces' }))
    expect(await screen.findByText('Add and switch workspaces for your sessions.')).toBeVisible()
  })
})
