import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
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

  it('uses one Tab stop and keeps keyboard focus on the tab for the active panel', async () => {
    const tabs = [...TABS, { id: 'activity', label: () => 'Activity' }] as const
    function Views() {
      const [value, setValue] = useState<(typeof tabs)[number]['id']>('quotas')
      return (
        <>
          <button type="button">Before</button>
          <TabStrip label="Views" tabs={tabs} value={value} onChange={setValue} panelPrefix="insights" />
          <div role="tabpanel" id={`insights-${value}`} />
          <button type="button">After</button>
        </>
      )
    }

    const user = userEvent.setup()
    render(<Views />)
    await user.click(screen.getByRole('button', { name: 'Before' }))
    await user.tab()
    expect(screen.getByRole('tab', { name: 'Quotas', selected: true })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus()
    await user.tab({ shift: true })

    const steps = [
      ['ArrowRight', 'Activity', 'insights-activity'],
      ['ArrowRight', 'Usage', 'insights-usage'],
      ['ArrowLeft', 'Activity', 'insights-activity'],
      ['Home', 'Usage', 'insights-usage'],
      ['End', 'Activity', 'insights-activity'],
      ['ArrowUp', 'Activity', 'insights-activity'],
    ] as const
    for (const [key, label, panelId] of steps) {
      await user.keyboard(`{${key}}`)
      const tab = screen.getByRole('tab', { name: label, selected: true })
      expect(tab).toHaveFocus()
      expect(tab).toHaveAttribute('aria-controls', panelId)
      expect(screen.getByRole('tabpanel')).toHaveAttribute('id', panelId)
    }

    await user.tab()
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus()
    await user.tab({ shift: true })
    expect(screen.getByRole('tab', { name: 'Activity', selected: true })).toHaveFocus()
  })
})
