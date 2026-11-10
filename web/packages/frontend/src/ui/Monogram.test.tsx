import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Monogram } from './Monogram'

describe('Monogram (TAL-2131)', () => {
  it('is the first letter of the name on a decorative square, 30px or 24px when small', () => {
    const { container, rerender } = render(<Monogram name="  openrouter" />)
    const square = container.querySelector('[data-monogram]')!
    expect(square).toHaveTextContent('o')
    expect(square).toHaveAttribute('aria-hidden', 'true')
    expect(square).toHaveClass('size-[30px]', 'bg-hover', 'uppercase')
    rerender(<Monogram name="Éclair" sm />)
    expect(container.querySelector('[data-monogram]')).toHaveTextContent('É')
    expect(container.querySelector('[data-monogram]')).toHaveClass('size-6')
    rerender(<Monogram name="" />)
    expect(container.querySelector('[data-monogram]')).toHaveTextContent('?')
  })
})
