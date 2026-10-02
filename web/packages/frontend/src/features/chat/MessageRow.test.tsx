import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { UserMessageRow } from './MessageRow'

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
