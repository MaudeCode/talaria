import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { resetTodoStoreForTests, setTodoState, useTodoState } from './todoStore'

afterEach(resetTodoStoreForTests)

it('shows a session task list that arrives after mount', () => {
  const { result } = renderHook(() => useTodoState('s1'))
  expect(result.current).toBeNull()
  act(() => { setTodoState('s1', { todos: [{ id: 1, text: 'Ship it' }] }) })
  expect(result.current?.todos).toEqual([{ id: 1, text: 'Ship it' }])
})
