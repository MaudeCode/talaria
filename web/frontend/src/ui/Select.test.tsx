import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Select } from './Select'

describe('Select', () => {
  it('shows the selected option label and reports a new value', async () => {
    const onValueChange = vi.fn()
    render(
      <Select value="b" onValueChange={onValueChange} aria-label="Pick">
        <option value="a">Alpha</option>
        <optgroup label="More">
          <option value="b">Beta</option>
          <option value="c" disabled>Gamma</option>
        </optgroup>
      </Select>,
    )
    const trigger = screen.getByRole('combobox', { name: 'Pick' })
    expect(trigger).toHaveTextContent('Beta')
    await userEvent.click(trigger)
    await userEvent.click(await screen.findByRole('option', { name: 'Alpha' }))
    expect(onValueChange).toHaveBeenCalledWith('a')
  })

  it('renders the placeholder when the value matches no option', () => {
    render(<Select value="" onValueChange={vi.fn()} aria-label="Pick" placeholder="Choose"><option value="a">Alpha</option></Select>)
    expect(screen.getByRole('combobox', { name: 'Pick' })).toHaveTextContent('Choose')
  })
})
