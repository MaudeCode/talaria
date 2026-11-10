import { render, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import fixture from '../../../../../../contracts/fixtures/web-native-todos.json'
import { TodosPage } from './TodosPage'
import { useTranscript } from '../chat/useTranscript'

vi.mock('../chat/useTranscript', () => ({ useTranscript: vi.fn() }))
vi.mock('../../shell/AppShell', () => ({ HubPage: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }))
vi.mock(import('@tanstack/react-router'), async (original) => ({
  ...await original(),
  Link: (({ to, params, children, className }: { to: string; params?: { sessionId: string }; children: React.ReactNode; className?: string }) => <a href={to.replace('$sessionId', params?.sessionId ?? '')} className={className}>{children}</a>) as never,
}))

const loaded = (session: unknown) => vi.mocked(useTranscript).mockReturnValue({ session, query: { isError: false, isPending: false } } as unknown as ReturnType<typeof useTranscript>)

// TAL-2090: the page names the chat its list comes from, and says what to do when there is none.
it('names the chat whose server display items it lists, in server order', () => {
  loaded({ session_id: 'native', title: 'Owner plan', todo_state: { ...fixture.owner, ...fixture.public, todos: [{ id: 'wrong', content: 'Private raw variant', status: 'pending' }] } })
  render(<TodosPage sessionId="native" />)
  expect(screen.getByRole('link', { name: 'Owner plan' })).toHaveAttribute('href', '/session/native')
  const rows = within(screen.getByRole('list', { name: 'Current task list' })).getAllByRole('listitem')
  expect(rows.map((r) => r.textContent)).toEqual(['Owner taskWorking', '✓Finished taskDone'])
  expect(screen.getByText('Finished task')).toHaveClass('line-through')
  expect(screen.queryByText('Private raw variant')).not.toBeInTheDocument()
})

it('names the chat and says it has no list when the server sends no display items', () => {
  loaded({ session_id: 'native', title: 'Owner plan', todo_state: { ...fixture.public, display_items: [], total_count: 0 } })
  render(<TodosPage sessionId="native" />)
  expect(screen.getByRole('link', { name: 'Owner plan' })).toHaveAttribute('href', '/session/native')
  expect(screen.getByText('This chat has no task list yet.')).toBeVisible()
  expect(screen.queryByRole('list')).not.toBeInTheDocument()
})

it('points to the chat page when no chat is stored', () => {
  vi.mocked(useTranscript).mockReturnValue({ session: undefined, query: { isError: false, isPending: true } } as unknown as ReturnType<typeof useTranscript>)
  render(<TodosPage sessionId={null} />)
  expect(screen.getByRole('link', { name: 'Open a chat to see its task list.' })).toHaveAttribute('href', '/')
})
