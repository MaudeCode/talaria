import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Plus } from 'lucide-react'
import { BackButton, IconButton, type IconVariant } from './Button'

describe('IconButton variants (TAL-2131)', () => {
  it.each([
    ['default', ['border-border', 'bg-surface']],
    ['primary', ['bg-accent', 'text-accent-fg']],
    ['ghost', ['bg-transparent', 'text-muted']],
    ['danger', ['bg-transparent', 'text-error']],
  ] as [IconVariant, string[]][])('%s is a 32px square named by its label, 44px under a coarse pointer', (variant, classes) => {
    const onClick = vi.fn()
    render(<IconButton variant={variant} label="Add provider" onClick={onClick}><Plus aria-hidden="true" /></IconButton>)
    const button = screen.getByRole('button', { name: 'Add provider' })
    expect(button).toHaveAttribute('data-icon-button', variant)
    expect(button).toHaveClass('size-8', 'pointer-coarse:size-11', ...classes)
    expect(button).toHaveTextContent('')
    button.click()
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('shows its label in the shared tooltip, not the browser title', async () => {
    render(<IconButton variant="ghost" label="Refresh">x</IconButton>)
    const button = screen.getByRole('button', { name: 'Refresh' })
    expect(button).not.toHaveAttribute('title')
    await userEvent.hover(button)
    expect(await screen.findByText('Refresh', { selector: '[data-side]' })).toBeInTheDocument()
  })

  it('an active symbol takes the accent in place of its variant colours, never both', () => {
    render(<IconButton variant="ghost" label="Catalog" active aria-expanded>x</IconButton>)
    const button = screen.getByRole('button', { name: 'Catalog' })
    expect(button).toHaveClass('bg-accent-bg', 'text-accent-text')
    expect(button).not.toHaveClass('bg-transparent')
    expect(button).not.toHaveClass('text-muted')
  })

  it('keeps the 34px toolbar look and title without a variant', () => {

    render(<IconButton label="Close">x</IconButton>)
    const button = screen.getByRole('button', { name: 'Close' })
    expect(button).toHaveAttribute('title', 'Close')
    expect(button).toHaveClass('h-[34px]', 'w-[34px]')
    expect(button).not.toHaveAttribute('data-icon-button')
  })

  it('BackButton iconOnly is a ghost symbol named Back', () => {
    render(<><BackButton iconOnly /><BackButton label="To list" /></>)
    expect(screen.getByRole('button', { name: 'Back' })).toHaveAttribute('data-icon-button', 'ghost')
    expect(screen.getByRole('button', { name: 'To list' })).toHaveTextContent('To list')
  })
})
