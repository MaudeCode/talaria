import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TabStrip } from './TabStrip'

const TABS = [{ id: 'usage', label: () => 'Usage' }, { id: 'quotas', label: () => 'Quotas' }] as const

describe('TabStrip', () => {
  it('keeps its tab roles and wiring and underlines the selected tab (TAL-2131)', async () => {
    const onChange = vi.fn()
    render(<TabStrip label="Views" tabs={TABS} value="usage" onChange={onChange} panelPrefix="insights" />)
    const list = screen.getByRole('tablist', { name: 'Views' })
    expect(list).toHaveClass('border-b', 'overflow-x-auto')
    const usage = screen.getByRole('tab', { name: 'Usage' })
    const quotas = screen.getByRole('tab', { name: 'Quotas' })
    expect(usage).toHaveAttribute('aria-selected', 'true')
    expect(usage).toHaveAttribute('aria-controls', 'insights-usage')
    expect(usage).toHaveClass('border-b-2', 'border-accent', 'text-strong')
    expect(usage.className).not.toMatch(/bg-accent/)
    expect(quotas).toHaveAttribute('aria-selected', 'false')
    expect(quotas).toHaveClass('border-transparent', 'text-muted')
    await userEvent.click(quotas)
    expect(onChange).toHaveBeenCalledExactlyOnceWith('quotas')
  })
})
