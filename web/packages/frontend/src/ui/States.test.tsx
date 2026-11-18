import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EmptyState, LoadingState } from './States'

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

})

describe('EmptyState', () => {
  it('keeps its dashed frame by default and is one muted line with a trailing action when compact (TAL-2131)', () => {
    const { rerender } = render(<EmptyState>Nothing here</EmptyState>)
    expect(screen.getByText('Nothing here')).toHaveClass('border-dashed')
    rerender(<EmptyState compact action={<button type="button">Add</button>}>Nothing here</EmptyState>)
    const line = screen.getByText('Nothing here').parentElement!
    expect(line).toHaveAttribute('data-empty')
    expect(line).toHaveClass('text-muted')
    expect(line.className).not.toMatch(/border/)
    expect(line.lastElementChild).toBe(screen.getByRole('button', { name: 'Add' }))
  })
})
