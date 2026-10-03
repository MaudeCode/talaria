import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { PanelPageHost, type PanelPage } from './PanelPageHost'

/** A page with its own state, to prove a hidden page keeps it, and that reports whether it is active. */
function Notes({ name, active }: { name: string; active: boolean }) {
  const [text, setText] = useState('')
  return <label>{name} <input aria-label={`${name} notes`} value={text} onChange={(e) => setText(e.target.value)} /> <span>{active ? `${name} active` : `${name} idle`}</span></label>
}

// Files, Agents and a synthetic third page register the same way: an entry each, no page-specific panel code.
const pages: PanelPage[] = ['Files', 'Agents', 'Terminal'].map((name) => ({ id: name.toLowerCase(), label: name, render: (active) => <Notes name={name} active={active} /> }))

function Host({ initial = 'files', open = true }: { initial?: string; open?: boolean }) {
  const [active, setActive] = useState(initial)
  return <PanelPageHost open={open} onToggle={() => undefined} onClose={() => undefined} label="Side panel" pages={pages} activeId={active} onSelect={setActive} />
}

beforeEach(() => {
  document.body.innerHTML = '<div id="rightpanelSlot"></div>'
})

describe('right panel page host (TAL-373)', () => {
  it('selects every page, including a third, and returns to each with its state intact', async () => {
    render(<Host />)
    const tabs = await screen.findAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Files', 'Agents', 'Terminal'])
    expect(screen.getByRole('tablist', { name: 'Side panel' })).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Files notes'), 'draft')
    for (const name of ['Agents', 'Terminal', 'Files']) {
      await userEvent.click(screen.getByRole('tab', { name }))
      expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('tabpanel')).toHaveAccessibleName(name)
      expect(screen.getByText(`${name} active`)).toBeInTheDocument()
    }
    // Hidden pages stay mounted and idle; the Files draft survived two switches.
    expect(screen.getByLabelText('Files notes')).toHaveValue('draft')
    expect(screen.getByText('Agents idle', { selector: 'span' })).toBeInTheDocument()
  })

  it('moves between tabs with the arrow keys, Home and End, keeping one tab in the tab order', async () => {
    render(<Host />)
    const files = await screen.findByRole('tab', { name: 'Files' })
    files.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Agents' })).toHaveFocus()
    expect(screen.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{End}')
    expect(screen.getByRole('tab', { name: 'Terminal' })).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveFocus()
    await userEvent.keyboard('{ArrowLeft}{Home}')
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('tab').map((t) => t.tabIndex)).toEqual([0, -1, -1])
  })

  it('falls back to the first page when the chosen one does not exist, and no page is active while closed', async () => {
    const { unmount } = render(<Host initial="gone" />)
    expect(await screen.findByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
    unmount()
    render(<Host open={false} />)
    await waitFor(() => { expect(screen.getByText('Files idle', { selector: 'span' })).toBeInTheDocument() })
  })
})
