import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, it, vi } from 'vitest'
import { SessionSkillsSchema } from '@maudecode/talaria-web-contracts'
import fixture from '../../../../../../contracts/fixtures/session-skills.json'

vi.mock('../../api/endpoints', () => ({ fetchSessionSkills: vi.fn(), fetchSkillContent: vi.fn() }))
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { SessionSkillsPage } from './SessionSkillsPage'

const used = SessionSkillsSchema.parse(fixture.used)
let client: QueryClient

function Page({ sessionId = used.session_id, active = true }: { sessionId?: string; active?: boolean }) {
  return <QueryClientProvider client={client}><SessionSkillsPage sessionId={sessionId} active={active} /></QueryClientProvider>
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(api.fetchSessionSkills).mockReset().mockResolvedValue(used)
  vi.mocked(api.fetchSkillContent).mockReset().mockImplementation((name) => Promise.resolve({ success: true, name, content: `# ${name} body`, linked_files: {} }))
})

it('keeps loaded content when a refresh fails, and says so when the skill is gone', async () => {
  render(<Page />)
  await userEvent.click(await screen.findByRole('button', { name: /deploy/ }))
  expect(await screen.findByText('# deploy body')).toBeVisible()
  vi.mocked(api.fetchSkillContent).mockRejectedValue(new Error('offline'))
  await act(() => client.refetchQueries({ queryKey: keys.skills.content('deploy') }))
  expect(screen.getByText('# deploy body')).toBeVisible()
  vi.mocked(api.fetchSkillContent).mockResolvedValue({ success: false, message: 'not found' })
  await act(() => client.refetchQueries({ queryKey: keys.skills.content('deploy') }))
  expect(await screen.findByText('This skill is no longer in the library.')).toBeVisible()
})

it('belongs to one session: another session starts closed and reads its own list', async () => {
  const { rerender } = render(<Page />)
  await userEvent.click(await screen.findByRole('button', { name: /review/ }))
  vi.mocked(api.fetchSessionSkills).mockResolvedValue({ session_id: 'other0session', skills: [{ name: 'review', description: 'Code review', count: 1, detail_available: true }] })
  rerender(<Page sessionId="other0session" />)
  await waitFor(() => { expect(screen.getAllByRole('listitem')).toHaveLength(1) })
  expect(screen.getByRole('button', { name: /review/ })).toHaveAttribute('aria-expanded', 'false')
  expect(api.fetchSessionSkills).toHaveBeenLastCalledWith('other0session')
})

it('does not read while hidden', () => {
  render(<Page active={false} />)
  expect(api.fetchSessionSkills).not.toHaveBeenCalled()
})
