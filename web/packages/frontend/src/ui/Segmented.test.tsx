import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { Segmented } from './Segmented'

const OPTIONS = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }, { value: 'c', label: 'Gamma' }]

function Harness({ onChange }: { onChange: (value: string) => void }) {
  const [value, setValue] = useState('a')
  return <><button type="button">Before</button><Segmented label="Mode" options={OPTIONS} value={value} onChange={(v) => { onChange(v); setValue(v) }} /><button type="button">After</button></>
}

describe('Segmented (TAL-2131)', () => {
  it('is a radiogroup whose selected option is checked and the one Tab stop', async () => {
    render(<Harness onChange={vi.fn()} />)
    const group = screen.getByRole('radiogroup', { name: 'Mode' })
    expect(group).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Alpha' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Beta' })).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(screen.getByRole('button', { name: 'Before' }))
    await userEvent.tab()
    expect(screen.getByRole('radio', { name: 'Alpha' })).toHaveFocus()
    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus()
  })

  it('moves the selection and focus with the arrow keys, Home and End, wrapping at the ends', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.click(screen.getByRole('radio', { name: 'Alpha' }))
    expect(onChange).not.toHaveBeenCalled()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Beta' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Beta' })).toHaveFocus()
    await userEvent.keyboard('{End}')
    expect(screen.getByRole('radio', { name: 'Gamma' })).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Alpha' })).toHaveAttribute('aria-checked', 'true')
    await userEvent.keyboard('{ArrowLeft}{Home}')
    expect(onChange.mock.calls.map(([v]) => v)).toEqual(['b', 'c', 'a', 'c', 'a'])
  })

  it('selects a clicked option and ignores input while disabled', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<Segmented label="Mode" options={OPTIONS} value="a" onChange={onChange} />)
    await userEvent.click(screen.getByRole('radio', { name: 'Gamma' }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('c')
    rerender(<Segmented label="Mode" options={OPTIONS} value="a" onChange={onChange} disabled />)
    await userEvent.click(screen.getByRole('radio', { name: 'Beta' }))
    expect(screen.getByRole('radio', { name: 'Beta' })).toBeDisabled()
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
