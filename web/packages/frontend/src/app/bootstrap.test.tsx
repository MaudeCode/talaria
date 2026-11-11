import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { keys } from '../api/queryKeys'
import * as api from '../api/endpoints'
import { DEFAULT_BOOTSTRAP } from '../contracts/adapters/memory'
import type { Bootstrap } from '../contracts/bootstrap'
import { seedShellQueries } from './bootstrap'
import { useProfilesQuery, useProjectsQuery, useSettingsQuery, useWorkspacesQuery } from './queries'

vi.mock('../api/endpoints', () => ({ fetchSettings: vi.fn(), fetchProfiles: vi.fn(), fetchWorkspaces: vi.fn(), fetchProjects: vi.fn() }))

const shell = {
  settings: { bot_name: 'Seeded bot', send_key: 'enter' },
  profiles: { profiles: [{ name: 'default', is_active: true }], active: 'default' },
  workspaces: { workspaces: [{ name: 'Home', path: '/synthetic/home' }], last: '/synthetic/home' },
  projects: { projects: [{ project_id: 'p1', name: 'Seeded project' }], active_profile: 'default', all_profiles: false, other_profile_count: 0 },
} satisfies NonNullable<Bootstrap['shell']>
const withShell: Bootstrap = { ...DEFAULT_BOOTSTRAP, shell }

function mount(qc: QueryClient) {
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  return renderHook(() => ({ settings: useSettingsQuery(), profiles: useProfilesQuery(), workspaces: useWorkspacesQuery(), projects: useProjectsQuery() }), { wrapper }).result
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.fetchSettings).mockResolvedValue({ bot_name: 'Fetched bot' })
  vi.mocked(api.fetchProfiles).mockResolvedValue({ profiles: [], active: 'fetched' })
  vi.mocked(api.fetchWorkspaces).mockResolvedValue({ workspaces: [] })
  vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [], active_profile: 'fetched', all_profiles: false, other_profile_count: 0 })
})

describe('seedShellQueries', () => {
  it('seeds the four shell queries so their hooks mount fresh without a read', () => {
    const qc = new QueryClient()
    seedShellQueries(qc, { state: 'ready', data: withShell, requestedAt: Date.now() })
    const result = mount(qc)
    expect(result.current.settings.data).toMatchObject({ bot_name: 'Seeded bot' })
    expect(result.current.profiles.data).toEqual(shell.profiles)
    expect(result.current.workspaces.data).toEqual(shell.workspaces)
    expect(result.current.projects.data).toEqual(shell.projects)
    expect(qc.isFetching()).toBe(0)
    for (const read of [api.fetchSettings, api.fetchProfiles, api.fetchWorkspaces, api.fetchProjects]) expect(read).not.toHaveBeenCalled()
  })

  it('keeps a query the client read after the bootstrap request left', () => {
    const qc = new QueryClient()
    const requestedAt = Date.now() - 1_000
    qc.setQueryData(keys.projects, { projects: [], active_profile: 'newer', all_profiles: false, other_profile_count: 0 })
    qc.setQueryData(keys.settings, { bot_name: 'Older snapshot' }, { updatedAt: requestedAt - 1 })
    seedShellQueries(qc, { state: 'ready', data: withShell, requestedAt })
    expect(qc.getQueryData(keys.projects)).toMatchObject({ active_profile: 'newer' })
    expect(qc.getQueryData(keys.settings)).toEqual(shell.settings)
  })

  it('leaves the queries to their own reads without a shell', async () => {
    const qc = new QueryClient()
    seedShellQueries(qc, { state: 'ready', data: DEFAULT_BOOTSTRAP, requestedAt: Date.now() })
    seedShellQueries(qc, { state: 'error', error: new Error('offline') })
    const result = mount(qc)
    await waitFor(() => { expect(result.current.profiles.data).toMatchObject({ active: 'fetched' }) })
    expect(api.fetchSettings).toHaveBeenCalledTimes(1)
  })
})
