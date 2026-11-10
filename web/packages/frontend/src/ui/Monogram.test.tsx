import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
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

  it('TAL-2176: shows the image at the same size when given one, and the letter when it fails to load', () => {
    const { container, rerender } = render(<Monogram name="scout" src="./api/profile/avatar?name=scout" />)
    const image = container.querySelector('img[data-monogram]')!
    expect(image).toHaveAttribute('src', './api/profile/avatar?name=scout')
    expect(image).toHaveAttribute('alt', '')
    expect(image).toHaveClass('size-[30px]', 'rounded-md')
    fireEvent.error(image)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[data-monogram]')).toHaveTextContent('s')
    // A different image gets its own try.
    rerender(<Monogram name="scout" src="./api/profile/avatar?name=other" />)
    expect(container.querySelector('img[data-monogram]')).toHaveAttribute('src', './api/profile/avatar?name=other')
  })
})
