import { afterEach, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { Markdown } from './Markdown'

// The renderer chunk resolves only when the test releases it, as a slow network would.
const chunk = vi.hoisted(() => Promise.withResolvers<undefined>())
vi.mock('./MarkdownRenderer', async () => {
  await chunk.promise
  return { default: ({ text }: { text: string }) => <p data-testid="rendered">{text}</p> }
})

afterEach(() => { vi.useRealTimers() })

it('renders what mounted before the chunk a batch per task, newest first (TAL-1637)', async () => {
  vi.useFakeTimers()
  render(<>{Array.from({ length: 40 }, (_, i) => <Markdown key={i} text={`answer ${i}`} />)}</>)
  await act(async () => { chunk.resolve(undefined); await vi.dynamicImportSettled() })
  expect(screen.getAllByTestId('rendered').map((p) => p.textContent)).toEqual(Array.from({ length: 32 }, (_, i) => `answer ${i + 8}`))

  await act(() => vi.runAllTimersAsync())
  expect(screen.getAllByTestId('rendered')).toHaveLength(40)
})
