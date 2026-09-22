import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LoadingState } from './States'
import { Transcript } from '../features/chat/Transcript'
import { TranscriptSkeleton } from '../features/chat/TranscriptSkeleton'

describe('LoadingState', () => {
  it('centers the activity dot beside the label inside a live status region', () => {
    render(<LoadingState label="Loading conversation…" />)
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Loading conversation…')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status.className).toMatch(/items-center/)
    expect(status.className).toMatch(/justify-center/)
    expect(status.querySelector('[aria-hidden="true"]')).not.toBeNull()
    // Growth is opt-in: shared callers (settings, extension panel) must not split their pane.
    expect(status.className).not.toMatch(/flex-1/)
  })

  it('renders the transcript skeleton inside the messages area while a session loads', () => {
    render(
      <Transcript
        rows={[]}
        live={null}
        assistantName="Hermes"
        mode="compact_worklog"
        renderUserMarkdown={false}
        autoFollow={false}
        sessionId="s1"
        actions={{ onRegenerate: vi.fn() }}
        tts={false}
        truncated={false}
        onLoadOlder={vi.fn()}
        loadingOlder={false}
        emptyState={<TranscriptSkeleton />}
        showJumpButtons={false}
        virtualizeLongTranscripts={false}
      />,
    )
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Loading conversation…')
    expect(status.closest('#messages')).not.toBeNull()
    expect(status.className).toMatch(/flex-1/)
    expect(screen.getByTestId('transcript-skeleton').querySelectorAll('.msg-row')).toHaveLength(3)
  })
})
