import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { composerStateId, useQueuedTurns, type QueuedTurn } from './queue'
import { sessionFixture } from '../../test/fixtures'

const turn = (id: string): QueuedTurn => ({ id, text: id, attachments: [], request: { profile: 'default' } })

it('keeps same-id owner queues separate and refreshes after an acknowledgement while another owner is selected', () => {
  const root = sessionFixture({ session_id: 'same-id', composer_state_key: 'owner-root' })
  const work = sessionFixture({ session_id: 'same-id', composer_state_key: 'owner-work' })
  const view = renderHook(({ session }) => useQueuedTurns(composerStateId(session)), { initialProps: { session: root } })
  act(() => view.result.current[1]([turn('root')]))
  const rootAck = view.result.current[1]
  view.rerender({ session: work })
  expect(view.result.current[0]).toEqual([])
  act(() => view.result.current[1]([turn('work')]))
  act(() => rootAck([]))
  expect(view.result.current[0].map((q) => q.id)).toEqual(['work'])
  view.rerender({ session: root })
  expect(view.result.current[0]).toEqual([])
})

it('commits an acknowledgement after unmount and notifies the replacement view without dropping newer items', () => {
  const original = renderHook(() => useQueuedTurns('queue-navigation'))
  act(() => original.result.current[1]([turn('admitting')]))
  const acknowledge = original.result.current[1]
  original.unmount()
  const replacement = renderHook(() => useQueuedTurns('queue-navigation'))
  act(() => replacement.result.current[1]((previous) => [...previous, turn('newer')]))
  act(() => acknowledge((previous) => previous.filter((item) => item.id !== 'admitting')))
  expect(replacement.result.current[0].map((item) => item.id)).toEqual(['newer'])
  expect(JSON.parse(localStorage.getItem('hermes-queue:queue-navigation')!)).toEqual([turn('newer')])
})
