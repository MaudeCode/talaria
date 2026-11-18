import { expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { Transcript } from './Transcript'

// The renderer chunk resolves only when the test releases it, as a slow network would.
const chunk = vi.hoisted(() => Promise.withResolvers<undefined>())
vi.mock('./render/MarkdownRenderer', async () => {
  await chunk.promise
  return { default: ({ text }: { text: string }) => <p>{text}</p> }
})

Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })

it('holds the history until the renderer loads and shows the message the user sends meanwhile (TAL-2410)', async () => {
  render(<Transcript rows={[{ key: '1', index: 0, message: { role: 'user', content: 'Earlier question' } }, { key: '2', index: 1, message: { role: 'assistant', content: 'Earlier answer' } }]}
    pendingUserText="Sent while loading" live={null} assistantName="Assistant" mode="compact_worklog" renderUserMarkdown={false} autoFollow
    sessionId="s" actions={{}} tts={false} truncated={false} loadedFrom={0} onLoadOlder={vi.fn()} loadingOlder={false} emptyState={null}
    showJumpButtons={false} virtualizeLongTranscripts={false} />)
  expect(screen.getByText('Sent while loading')).toBeInTheDocument()
  expect(screen.getByTestId('transcript-skeleton')).toBeInTheDocument()
  expect(screen.queryByText('Earlier question')).toBeNull()

  await act(async () => { chunk.resolve(undefined); await vi.dynamicImportSettled() })
  expect(await screen.findByText('Earlier answer')).toBeInTheDocument()
  expect(screen.queryByTestId('transcript-skeleton')).toBeNull()
})
