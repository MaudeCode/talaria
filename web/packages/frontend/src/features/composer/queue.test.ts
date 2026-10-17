import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useQueuedTurns, type QueuedTurn } from './queue'

const turn = (id: string): QueuedTurn => ({ id, text: id, attachments: [], request: { profile: 'default' } })

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
