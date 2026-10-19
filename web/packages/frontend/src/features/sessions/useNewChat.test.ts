import { describe, expect, it, vi } from 'vitest'

vi.mock('../../api/endpoints', () => ({ newSession: vi.fn(() => Promise.resolve({ session: { session_id: 'created', title: 'Untitled' } })) }))
import { newSession } from '../../api/endpoints'
import { createSessionNow } from './useNewChat'

describe('createSessionNow (TAL-1040)', () => {
  it('sends a diagnostic worktree request so the server can refuse it instead of starting elsewhere', async () => {
    await createSessionNow({ worktree: true, execution_mode: 'safe' })
    expect(newSession).toHaveBeenLastCalledWith({ worktree: true, execution_mode: 'safe' })
  })

  it('omits the mode for a normal chat', async () => {
    await createSessionNow({ execution_mode: 'normal' })
    expect(newSession).toHaveBeenLastCalledWith({ worktree: false })
  })
})
