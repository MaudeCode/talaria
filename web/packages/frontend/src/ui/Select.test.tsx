import { describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
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
  it('does not report a user change when a pending-only option is replaced by the server value', async () => {
    const onValueChange = vi.fn()
    const { rerender } = render(<Select value="running" onValueChange={onValueChange} aria-label="Column"><option value="running">Running</option><option value="ready">Ready</option></Select>)
    await userEvent.click(screen.getByRole('combobox', { name: 'Column' }))
    await userEvent.keyboard('{Escape}')
    rerender(<Select value="done" onValueChange={onValueChange} aria-label="Column"><option value="done">Done</option><option value="ready">Ready</option></Select>)
    rerender(<Select value="running" onValueChange={onValueChange} aria-label="Column"><option value="running">Running</option></Select>)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('combobox', { name: 'Column' })).toHaveTextContent('Running')
    expect(onValueChange).not.toHaveBeenCalled()
  })
})
