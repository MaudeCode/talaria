import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, it, vi } from 'vitest'
import { SkillRevisionsSchema } from '@maudecode/talaria-web-contracts'
import fixture from '../../../../../../contracts/fixtures/skill-revisions.json'

vi.mock('../../api/endpoints', () => ({ fetchSkills: vi.fn(), fetchSkillsUsage: vi.fn(), fetchSkillContent: vi.fn(), fetchSkillRevisions: vi.fn(), saveSkill: vi.fn(), deleteSkill: vi.fn(), toggleSkill: vi.fn(), fetchPendingWrites: vi.fn(() => Promise.resolve({ kind: 'skills', visible: false, enabled: false, items: [] })) }))
vi.mock('../../shell/AppShell', () => ({ HubPage: ({ actions, children }: { actions: React.ReactNode; children: React.ReactNode }) => <div>{actions}{children}</div> }))
import * as api from '../../api/endpoints'
import { teardownAll } from '../../stream/connection'
import { SkillsPage } from './SkillsPage'

beforeEach(() => {
  vi.mocked(api.fetchSkills).mockReset().mockResolvedValue({ skills: [{ name: 'demo', description: 'Example skill', category: null, disabled: false }] })
  vi.mocked(api.fetchSkillsUsage).mockReset().mockResolvedValue({ usage: {} })
  vi.mocked(api.fetchSkillContent).mockReset().mockResolvedValue({ success: true, content: 'Current editable content', linked_files: {} })
  vi.mocked(api.fetchSkillRevisions).mockReset().mockResolvedValue(SkillRevisionsSchema.parse(fixture))
})

async function openHistory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><SkillsPage /></QueryClientProvider>)
  await userEvent.click(await screen.findByRole('button', { name: /demo/ }))
  await screen.findByLabelText('Skill content')
  expect(api.fetchSkillRevisions).not.toHaveBeenCalled()
  await userEvent.click(screen.getByText('Saved revisions', { exact: true }))
}

it('renders server history and diff read-only while preserving the current editor', async () => {
  await openHistory()
  expect(await screen.findByLabelText('Saved revision content')).toHaveValue(fixture.selected.content)
  expect(screen.getByLabelText('Saved revision content')).toHaveAttribute('readonly')
  expect(screen.getByRole('region', { name: 'Saved revisions' }).querySelector('pre')?.textContent).toBe(fixture.comparison.diff)
  expect(screen.getByLabelText('Skill content')).toHaveValue('Current editable content')
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled()
  expect(screen.queryByRole('button', { name: /run|replay/i })).toBeNull()
})

it('shows explicit missing history without fabricating a revision from current content', async () => {
  vi.mocked(api.fetchSkillRevisions).mockResolvedValue({ state: 'missing', reason: 'history_unavailable', backend_revision: fixture.backend_revision, revisions: [], selected: null, comparison: null, replay_available: false })
  await openHistory()
  expect(await screen.findByText('No saved revisions are available for this skill.')).toBeInTheDocument()
  expect(screen.queryByLabelText('Saved revision content')).toBeNull()
})

it('discards history that finishes after the profile context changes', async () => {
  let finish!: (value: Awaited<ReturnType<typeof api.fetchSkillRevisions>>) => void
  vi.mocked(api.fetchSkillRevisions).mockReturnValue(new Promise((resolve) => { finish = resolve }))
  await openHistory()
  act(() => teardownAll())
  await act(async () => { finish(SkillRevisionsSchema.parse(fixture)); await Promise.resolve() })
  expect(screen.queryByLabelText('Saved revision content')).toBeNull()
  expect(screen.getByRole('region', { name: 'Saved revisions' }).querySelector('pre')).toBeNull()
})
