import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QuotaMeter } from './QuotaMeter'

describe('QuotaMeter', () => {
  it('is a labelled meter of the server percent, the thin variant a 4px by 84px share (TAL-2131)', () => {
    const { rerender } = render(<QuotaMeter level="warning" percent={79.6} marker={50} label="79% used" />)
    const meter = screen.getByRole('meter', { name: '79% used' })
    expect(meter).toHaveAttribute('aria-valuenow', '80')
    expect(meter).toHaveClass('h-2')
    expect(meter).not.toHaveAttribute('data-meter')
    expect(meter.firstElementChild).toHaveClass('bg-warning')
    rerender(<QuotaMeter thin level="healthy" percent={21} marker={null} label="21% left" />)
    const thin = screen.getByRole('meter', { name: '21% left' })
    expect(thin).toHaveAttribute('data-meter', 'thin')
    expect(thin).toHaveClass('h-1', 'w-[84px]', 'shrink-0')
    expect(thin).not.toHaveClass('h-2')
    expect(thin.firstElementChild).toHaveStyle({ width: '21%' })
    expect(thin.children).toHaveLength(1)
  })
})
