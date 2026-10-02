import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AssistantMessageRow, BackgroundUpdateRow, UserMessageRow } from './MessageRow'
import { Transcript } from './Transcript'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Message } from '../../contracts'
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

describe('background updates (TAL-371)', () => {
  const fixture = (): Message[] => (JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../contracts/fixtures/web-session.json'), 'utf8')) as { background_update_session: { messages: Message[] } }).background_update_session.messages

  it('shows a wakeup as a collapsed update with its warning, and the full notification when expanded', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const message = fixture().find((m) => m.message_id === 'wakeup-mixed-user')!
    const view = render(<BackgroundUpdateRow row={{ index: 2, key: 'w', message }} />)
    const disclosure = view.container.querySelector('details')!
    expect(disclosure.open).toBe(false)
    const summary = disclosure.querySelector('summary')!
    expect(summary).toHaveTextContent('Background updates (2)')
    expect(summary).toHaveTextContent('Needs attention')
    expect(summary).toHaveTextContent('ASYNC DELEGATION BATCH COMPLETE — deleg_contract')
    fireEvent.click(summary)
    expect(disclosure.open).toBe(true)
    expect(disclosure.querySelector('.msg-body')?.textContent).toBe(message.content)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith(message.content)
  })

  it('renders the transcript\'s wakeups as updates and a typed marker as the user\'s own message', () => {
    const messages = fixture()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
    const view = render(<Transcript rows={projectMessages(messages)} live={null} assistantName="Assistant" mode="compact_worklog" renderUserMarkdown={false} autoFollow={false} sessionId="s" actions={{}} tts={false} truncated={false} loadedFrom={0} onLoadOlder={() => undefined} loadingOlder={false} emptyState={null} showJumpButtons={false} virtualizeLongTranscripts={false} />)
    const role = (key: string) => view.container.querySelector(`[data-message-key="${key}"]`)?.getAttribute('data-role')
    const keyOf = (id: string) => projectMessages(messages).find((r) => r.message.message_id === id)!.key
    expect(role(keyOf('typed-marker-user'))).toBe('user')
    expect(role(keyOf('wakeup-mixed-user'))).toBe('background')
    expect(role(keyOf('wakeup-legacy-user'))).toBe('background')
    expect(view.container.querySelectorAll('details.background-update')).toHaveLength(2)
    expect(view.container.querySelector(`[data-message-key="${keyOf('wakeup-legacy-user')}"] summary`)).toHaveTextContent('Background update')
  })
})
