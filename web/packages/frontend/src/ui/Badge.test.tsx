import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Mark, StatusDot } from './Badge'

describe('Mark (TAL-2131)', () => {
  it('is a check and its words in the accent, with no border or fill', () => {
    render(<Mark title="The active provider">Active</Mark>)
    const mark = screen.getByText('Active')
    expect(mark).toHaveAttribute('title', 'The active provider')
    expect(mark).toHaveClass('text-accent-text')
    expect(mark.className).not.toMatch(/\bborder\b|\bbg-|rounded-full/)
    expect(mark.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('StatusDot (TAL-2131)', () => {
  it.each([['ok', 'bg-success'], ['warning', 'bg-warning'], ['error', 'bg-error'], ['idle', 'bg-muted']] as const)('a %s state is a 7px %s dot before muted words', (state, fill) => {
    render(<StatusDot state={state} title="full text">Words</StatusDot>)
    const status = screen.getByText('Words').closest('[data-status]')!
    expect(status).toHaveAttribute('data-status', state)
    expect(status).toHaveAttribute('title', 'full text')
    expect(status).toHaveClass('text-muted')
    const dot = status.querySelector('[aria-hidden="true"]')!
    expect(dot).toHaveClass('size-[7px]', 'rounded-full', fill)
  })

  it('truncates its words to one line unless they wrap (TAL-2142)', () => {
    render(<><StatusDot state="warning">One line</StatusDot><StatusDot state="warning" wrap>Read whole</StatusDot></>)
    expect(screen.getByText('One line')).toHaveClass('truncate')
    expect(screen.getByText('Read whole')).not.toHaveClass('truncate')
  })
})
