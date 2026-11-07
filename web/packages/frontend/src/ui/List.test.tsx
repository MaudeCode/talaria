import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Row, SectionHeader } from './List'

describe('Row', () => {
  it('uses the hairline row by default and the one-line row when compact', () => {
    render(<ul><Row>standard</Row><Row compact>small</Row></ul>)
    expect(screen.getByText('standard')).toHaveClass('flex-col', 'gap-4', 'border-border', 'py-4', 'first:border-t-0')
    const compact = screen.getByText('small')
    expect(compact).toHaveClass('flex-wrap', 'items-baseline', 'gap-x-2', 'border-border-subtle', 'py-2', 'text-xs')
    expect(compact).not.toHaveClass('py-4')
  })

  it('forwards data-* hooks and appends the caller class', () => {
    render(<ul><Row data-quota-source="qsrc_1" className="opacity-50">row</Row></ul>)
    const row = screen.getByRole('listitem')
    expect(row).toHaveAttribute('data-quota-source', 'qsrc_1')
    expect(row).toHaveClass('py-4', 'opacity-50')
  })
})

describe('SectionHeader', () => {
  it('stays a bare h3 with no slots and lays the detail and action out beside it', () => {
    const { rerender, container } = render(<SectionHeader className="px-2.5">Title</SectionHeader>)
    expect(container.firstElementChild).toBe(screen.getByRole('heading', { level: 3, name: 'Title' }))
    expect(container.firstElementChild).toHaveClass('px-2.5')

    rerender(<SectionHeader detail="12 peak" action={<button type="button">Act</button>}>Title</SectionHeader>)
    expect(screen.getByText('12 peak')).toHaveClass('text-xs', 'text-muted')
    expect(screen.getByRole('button', { name: 'Act' }).parentElement).toHaveClass('ml-auto')
    expect(container.firstElementChild).toContainElement(screen.getByRole('heading', { level: 3, name: 'Title' }))

    rerender(<SectionHeader detail={0}>Title</SectionHeader>)
    expect(screen.getByText('0')).toHaveClass('text-xs', 'text-muted')
  })
})
