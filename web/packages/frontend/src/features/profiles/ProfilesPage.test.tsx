import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock(import('../../api/endpoints'), async (importOriginal) => ({
  ...(await importOriginal()),
  fetchProfiles: vi.fn(() => Promise.resolve({
    profiles: [
      { name: 'default', is_default: true, display_name: '', description: '', has_avatar: false, canonical_session: null },
      { name: 'scout', is_default: false, display_name: 'Research lead', description: 'Finds sources.', has_avatar: true, canonical_session: { session_id: 'scout-root', tip_session_id: 'scout-tip' } },
    ],
    active: 'default',
    single_profile_mode: false,
  })),
  switchProfile: vi.fn(() => Promise.resolve({ profiles: [{ name: 'scout', canonical_session: { session_id: 'scout-root', tip_session_id: 'scout-live' } }], active: 'scout', is_default: false, default_model: null, default_model_provider: null, default_workspace: null })),
}))
import * as api from '../../api/endpoints'
import { ProfilesPage } from './ProfilesPage'

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><ProfilesPage /></QueryClientProvider>)
}

describe('ProfilesPage', () => {
  it('keeps the profiles-vs-workspaces explanation behind the title help button', async () => {
    renderPage()
    expect(await screen.findByText('default')).toBeVisible()
    expect(screen.queryByText(/Use profiles for how the agent works/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'About Profiles' }))
    expect(await screen.findByText(/Use profiles for how the agent works/)).toBeVisible()
    expect(screen.getByText(/Project or product folders on disk/)).toBeVisible()
  })

  it('TAL-213: shows each bot identity and opens the canonical Bot Chat only where one exists', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { href: window.location.href, origin: window.location.origin, assign })
    try {
      renderPage()
      const scout = (await screen.findByText('Research lead')).closest('li')!
      expect(within(scout).getByText('scout')).toBeVisible()
      expect(within(scout).getByText('Finds sources.')).toBeVisible()
      const plain = screen.getByText('default').closest('li')!
      expect(within(plain).queryByRole('button', { name: 'Open Bot Chat' })).not.toBeInTheDocument()
      await userEvent.click(within(scout).getByRole('button', { name: 'Open Bot Chat' }))
      expect(api.switchProfile).toHaveBeenCalledWith('scout')
      // The chat opens from the row the switch resolved, not the cached listing.
      await vi.waitFor(() => { expect(assign).toHaveBeenCalledWith(expect.stringMatching(/\/session\/scout-live$/)) })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
