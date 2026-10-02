import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AssistantMessageRow, UserMessageRow } from './MessageRow'
import { groupAssistantTurns } from './turnActivity'
import { projectMessages } from './useTranscript'

afterEach(cleanup)

describe('UserMessageRow attachments', () => {
  it('renders a filename-only attachment as a plain chip and links one with a stored path (TAL-277)', () => {
    const row = { index: 0, key: 'u0', message: { role: 'user', content: 'look', attachments: [{ name: 'example.png', filename: 'example.png' }, { name: 'upload.txt', path: '/uploads/upload.txt' }] } }
    render(<UserMessageRow row={row} renderMarkdown={false} sessionId="abc123def456" actions={{}} />)
    const legacy = screen.getByText('example.png')
    expect(legacy.tagName).toBe('SPAN')
    expect(legacy.closest('a')).toBeNull()
    expect(screen.queryByRole('img', { name: 'example.png' })).toBeNull()
    expect(screen.getByRole('link', { name: 'upload.txt' }).getAttribute('href')).toContain('upload.txt')
  })
})

describe('server-collapsed bodies (TAL-456)', () => {
  const full = `${'Opening line.\n'.repeat(3)}${'tail '.repeat(900)}`

  it('shows a long user message as its excerpt until the reader expands it, and copies the whole text', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const row = { index: 0, key: 'u0', message: { role: 'user', content: full, _display_truncated: true, _display_excerpt: 'Opening line.' } }
    const view = render(<UserMessageRow row={row} renderMarkdown={false} sessionId={undefined} actions={{}} />)
    const body = () => view.container.querySelector('.msg-body')?.textContent
    expect(body()).toBe('Opening line.')
    fireEvent.click(screen.getByRole('button', { name: 'Show full message' }))
    expect(body()).toBe(full)
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(body()).toBe('Opening line.')
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith(full)
  })

  it('leaves a message the server did not collapse whole, with no toggle', () => {
    const view = render(<UserMessageRow row={{ index: 0, key: 'u0', message: { role: 'user', content: 'short' } }} renderMarkdown={false} sessionId={undefined} actions={{}} />)
    expect(view.container.querySelector('.msg-body')?.textContent).toBe('short')
    expect(screen.queryByRole('button', { name: 'Show full message' })).toBeNull()
  })

  it('shows a long final answer as the scene excerpt until expanded', () => {
    const scene = { version: 'activity_scene_v1' as const, activity_rows: [], final_answer: full, final_answer_excerpt: 'Opening line.', terminal_state: 'completed' }
    const row = groupAssistantTurns(projectMessages([{ role: 'assistant', id: 1, content: full, _anchor_activity_scene: scene }]))[0]!
    const view = render(<AssistantMessageRow row={row} name="Assistant" mode="compact_worklog" actions={{}} tts={false} isLast />)
    const answer = () => view.container.querySelector('[data-final-answer="1"]')?.textContent?.trim()
    expect(answer()).toBe('Opening line.')
    fireEvent.click(screen.getByRole('button', { name: 'Show full message' }))
    expect(answer()).toContain('tail tail')
  })
})
