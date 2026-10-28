import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import fixture from '../../../../../../contracts/fixtures/web-native-todos.json'
import { TodosPage } from './TodosPage'
import { useTranscript } from '../chat/useTranscript'

vi.mock('../chat/useTranscript', () => ({ useTranscript: vi.fn() }))
vi.mock('../../shell/AppShell', () => ({ HubPage: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }))

it('renders the server display fields from session detail, then reflects replacement and clear', () => {
  const session = { session_id: 'native', todo_state: { ...fixture.owner, ...fixture.public } }
  vi.mocked(useTranscript).mockReturnValue({ session, query: { isError: false, isPending: false } } as unknown as ReturnType<typeof useTranscript>)
  const { rerender } = render(<TodosPage sessionId="native" />)
  expect(screen.getByText('Owner task')).toBeVisible()
  expect(screen.getByText('Finished task')).toHaveClass('line-through')
  // Raw variants deliberately disagree; rendering must use the server's display decision.
  session.todo_state = { ...session.todo_state, todos: [{ id: 'wrong', content: 'Private raw variant', status: 'pending' }] }
  rerender(<TodosPage sessionId="native" />)
  expect(screen.queryByText('Private raw variant')).not.toBeInTheDocument()
  session.todo_state = { ...session.todo_state, display_items: [], total_count: 0 }
  rerender(<TodosPage sessionId="native" />)
  expect(screen.queryByText('Owner task')).not.toBeInTheDocument()
})
