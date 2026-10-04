import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock(import('../../api/endpoints'), async (importOriginal) => ({
  ...(await importOriginal()),
  fetchProfiles: vi.fn(() => Promise.resolve({ profiles: [{ name: 'default', is_default: true }], active: 'default', single_profile_mode: false })),
}))
import { ProfilesPage } from './ProfilesPage'

describe('ProfilesPage', () => {
  it('keeps the profiles-vs-workspaces explanation behind the title help button', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><ProfilesPage /></QueryClientProvider>)
    expect(await screen.findByText('default')).toBeVisible()
    expect(screen.queryByText(/Use profiles for how the agent works/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'About Profiles' }))
    expect(await screen.findByText(/Use profiles for how the agent works/)).toBeVisible()
    expect(screen.getByText(/Project or product folders on disk/)).toBeVisible()
  })
})
