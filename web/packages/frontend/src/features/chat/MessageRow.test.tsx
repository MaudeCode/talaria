import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AssistantMessageRow, BackgroundUpdateRow, UserMessageRow } from './MessageRow'
import { Transcript } from './Transcript'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Message } from '../../contracts'
import { groupAssistantTurns } from './turnActivity'
import { projectMessages } from './useTranscript'
import { LiveStatusPill } from './LiveTurnView'
import type { LiveTurn } from '../../stream/reducer'

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

describe('background updates (TAL-460)', () => {
  const fixture = (): Message[] => (JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../contracts/fixtures/web-session.json'), 'utf8')) as { background_update_session: { messages: Message[] } }).background_update_session.messages

  it('shows a wakeup as one completion line per result, and the full notification when expanded', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const message = fixture().find((m) => m.message_id === 'wakeup-mixed-user')!
    const view = render(<BackgroundUpdateRow row={{ index: 2, key: 'w', message }} />)
    const disclosure = view.container.querySelector('details')!
    expect(disclosure.open).toBe(false)
    const lines = [...disclosure.querySelectorAll('summary li')].map((li) => li.textContent)
    expect(lines).toEqual(['Agent “Audit the PVC backups” completed', 'Background command make test failed (exit 1)'])
    expect(disclosure.querySelector('summary code')?.textContent).toBe('make test')
    fireEvent.click(disclosure.querySelector('summary')!)
    expect(disclosure.open).toBe(true)
    expect(disclosure.querySelector('.msg-body')?.textContent).toBe(message.content)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith(message.content)
  })

  it('puts each reply under its lines, shows nothing of a silent reply, and leaves a user turn as written', () => {
    const messages = fixture()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
    const view = render(<Transcript rows={projectMessages(messages)} live={null} assistantName="Assistant" mode="compact_worklog" renderUserMarkdown={false} autoFollow={false} sessionId="s" actions={{}} tts={false} truncated={false} loadedFrom={0} onLoadOlder={() => undefined} loadingOlder={false} emptyState={null} showJumpButtons={false} virtualizeLongTranscripts={false} />)
    const order = [...view.container.querySelectorAll('[data-message-key]')].map((el) => `${el.getAttribute('data-role') ?? ''}:${el.getAttribute('data-message-key') ?? ''}`)
    const key = (id: string) => String(messages.findIndex((m) => m.message_id === id))
    const keyOf = (id: string) => projectMessages(messages).find((r) => r.message.message_id === id)?.key ?? key(id)
    expect(order).toEqual([
      `user:${keyOf('typed-marker-user')}`, `assistant:${keyOf('typed-marker-reply')}`,
      `background:${keyOf('wakeup-mixed-user')}`, `assistant:${keyOf('wakeup-mixed-reply')}`,
      `background:${keyOf('wakeup-legacy-user')}`, `assistant:${keyOf('wakeup-legacy-reply')}`,
      `background:${keyOf('wakeup-silent-user')}`,
      `user:${keyOf('user-no-reply')}`, `assistant:${keyOf('user-no-reply-answer')}`,
    ])
    expect(view.container.querySelector(`[data-message-key="${keyOf('wakeup-silent-user')}"] summary`)).toHaveTextContent('Background command ./backup.sh finished')
    expect(view.container.textContent).not.toContain('[SILENT]')
    expect(view.container.querySelector(`[data-message-key="${keyOf('user-no-reply-answer')}"]`)).toHaveTextContent('NO_REPLY')
  })

  it('says the run is working on background results only while the server says a background result started it', () => {
    const turn = { status: 'streaming', tps: null } as unknown as LiveTurn
    const { rerender } = render(<LiveStatusPill turn={turn} background />)
    expect(screen.getByRole('status')).toHaveTextContent('Working on background results')
    rerender(<LiveStatusPill turn={turn} />)
    expect(screen.getByRole('status')).toHaveTextContent('Responding…')
  })
})

describe('compaction markers (TAL-305)', () => {
  const fixture = (): Message[] => (JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../contracts/fixtures/web-session.json'), 'utf8')) as { marker_session: { messages: Message[] } }).marker_session.messages
  const transcript = (messages: Message[]) => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
    return render(<Transcript rows={projectMessages(messages)} live={null} assistantName="Assistant" mode="compact_worklog" renderUserMarkdown={false} autoFollow={false} sessionId="s" actions={{}} tts={false} truncated={false} loadedFrom={0} onLoadOlder={() => undefined} loadingOlder={false} emptyState={null} showJumpButtons={false} virtualizeLongTranscripts={false} />)
  }

  it('shows each server-marked row as a collapsed card, never a user bubble, and prose about compaction as prose', () => {
    const messages = fixture()
    const view = transcript(messages)
    const keyOf = (id: string) => projectMessages(messages).find((r) => r.message.message_id === id)!.key
    const order = [...view.container.querySelectorAll('[data-message-key]')].map((el) => `${el.getAttribute('data-role') ?? ''}:${el.getAttribute('data-message-key') ?? ''}`)
    expect(order).toEqual([
      `user:${keyOf('marker-prompt')}`, `assistant:${keyOf('marker-reply')}`,
      `marker:${keyOf('marker-compaction')}`, `marker:${keyOf('marker-task-list')}`,
      `user:${keyOf('marker-question')}`, `assistant:${keyOf('marker-prose')}`,
    ])
    const card = (id: string) => view.container.querySelector<HTMLDetailsElement>(`[data-message-key="${keyOf(id)}"] details`)!
    const compaction = card('marker-compaction')
    expect(compaction.open).toBe(false)
    expect(compaction.querySelector('summary')).toHaveTextContent('Context compaction')
    fireEvent.click(compaction.querySelector('summary')!)
    expect(compaction.querySelector('.msg-body')?.textContent).toBe(messages.find((m) => m.message_id === 'marker-compaction')?.content)
    const tasks = card('marker-task-list')
    expect(tasks.querySelector('summary')).toHaveTextContent('Preserved task list')
    expect(tasks.querySelector('.msg-body')?.textContent).toBe('- [x] Draft the plan\n- [ ] Review the plan')
    expect(view.container.querySelector(`[data-message-key="${keyOf('marker-prose')}"]`)).toHaveTextContent('Context compaction is how the Agent')
  })

  it('keeps an assistant marker out of the turn around it', () => {
    const rows = groupAssistantTurns(projectMessages([
      { role: 'user', content: 'Go', _turn_id: 't' },
      { role: 'assistant', id: 1, content: 'One', _turn_id: 't' },
      { role: 'assistant', id: 2, content: '[context compaction] summary', _turn_id: 't', _marker_kind: 'context_compaction' },
      { role: 'assistant', id: 3, content: 'Two', _turn_id: 't' },
    ]))
    expect(rows.map((row) => [row.message._marker_kind ?? row.message.role, (row.assistantRows ?? []).length])).toEqual([['user', 0], ['assistant', 1], ['context_compaction', 0], ['assistant', 1]])
  })
})
