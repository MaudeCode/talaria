import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ToolResultView } from '@maudecode/talaria-web-contracts'
import { ToolCard, type ToolCardData } from './ToolCard'

const call: ToolCardData = { id: 'c1', name: 'terminal', kind: 'shell', target: 'make', args: {}, preview: 'flat preview', done: true, isError: false, duration: null, costUsd: null, resultView: null }

/** The result block the expanded card shows, as text. */
async function shownResult(resultView: ToolResultView | null): Promise<string | null | undefined> {
  const { container, unmount } = render(<ToolCard call={{ ...call, resultView }} />)
  await userEvent.click(screen.getByRole('button'))
  const text = container.querySelector('.tool-card-result pre')?.textContent
  unmount()
  return text
}

describe('ToolCard result (TAL-315)', () => {
  it('renders the server result view sections in order, with localized error and exit code labels', async () => {
    expect(await shownResult({ stdout: 'a\nb', stderr: 'warn', error: 'boom', exit_code: 1 })).toBe('a\nb\nwarn\nError: boom\nExit code: 1')
    expect(await shownResult({ stdout: 'only output' })).toBe('only output')
    expect(await shownResult({ stderr: 'only stderr', exit_code: 2 })).toBe('only stderr\nExit code: 2')
    expect(await shownResult({ exit_code: 0 })).toBe('Exit code: 0')
    expect(await shownResult({ error: 'denied' })).toBe('Error: denied')
    expect(await shownResult({ text: '{\n  "a": 1\n}' })).toBe('{\n  "a": 1\n}')
  })

  it('shows the preview only when the server sent no result view, and nothing for an empty one', async () => {
    expect(await shownResult(null)).toBe('flat preview')
    expect(await shownResult({})).toBeUndefined()
  })
})

it('shows server progress only on the running tool row (TAL-1268)', () => {
  const progress = { percent: 42, message: 'indexing files' }
  const { rerender } = render(<ToolCard call={{ ...call, done: false, progress }} />)
  expect(screen.getByText('42% · indexing files')).toBeVisible()
  rerender(<ToolCard call={{ ...call, done: true, progress }} />)
  expect(screen.queryByText('42% · indexing files')).not.toBeInTheDocument()
})

it('gives a running tool one animation class and removes its dot on completion (TAL-1393)', () => {
  const { container, rerender } = render(<ToolCard call={{ ...call, done: false }} />)
  const dot = container.querySelector('.tool-card-running-dot')!
  expect([...dot.classList].filter((name) => name === 'tool-card-running-dot' || name.startsWith('animate-'))).toEqual(['tool-card-running-dot'])
  rerender(<ToolCard call={call} />)
  expect(container.querySelector('.tool-card-running-dot')).toBeNull()
})
