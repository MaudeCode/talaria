import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

vi.mock('../../api/endpoints', () => ({ newSession: vi.fn(() => Promise.resolve({ session: { session_id: 'created', title: 'Untitled' } })) }))
import { newSession } from '../../api/endpoints'
import { createSessionNow, useCreationId } from './useNewChat'

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

describe('useCreationId (TAL-1040)', () => {
  it('sends the creation id with a diagnostic chat only', async () => {
    await createSessionNow({ execution_mode: 'safe', request_id: 'abc' })
    expect(newSession).toHaveBeenLastCalledWith({ worktree: false, execution_mode: 'safe', request_id: 'abc' })
    await createSessionNow({ request_id: 'abc' })
    expect(newSession).toHaveBeenLastCalledWith({ worktree: false })
  })

  it('keeps one id across retries until the chat is created or its choices change', () => {
    const { result, rerender } = renderHook(({ choices }) => useCreationId(choices), { initialProps: { choices: { execution_mode: 'safe' } } })
    const first = result.current.next()
    expect(result.current.next()).toBe(first)
    rerender({ choices: { execution_mode: 'ignore_config' } })
    const changed = result.current.next()
    expect(changed).not.toBe(first)
    result.current.settle()
    expect(result.current.next()).not.toBe(changed)
  })
})
