import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { KeyRound, Trash2 } from 'lucide-react'
import { RowContextMenu } from './Menu'
import { RowActionButtons } from './RowActionsMenu'

describe('RowActionButtons (TAL-2131)', () => {
  it('shows each row action as a symbol named by its words, the same words its context menu lists', async () => {
    const setKey = vi.fn()
    const remove = vi.fn()
    const actions = [
      { label: 'Set key', run: setKey, icon: KeyRound },
      { label: 'Remove key', run: remove, danger: true, icon: Trash2 },
      { label: 'Busy', run: vi.fn(), busy: true, icon: KeyRound },
    ]
    render(<RowContextMenu label="Provider actions" actions={actions} trigger={<div data-testid="row"><RowActionButtons actions={actions} /></div>} />)
    const set = screen.getByRole('button', { name: 'Set key' })
    expect(set).toHaveAttribute('data-icon-button', 'default')
    expect(set).toHaveTextContent('')
    expect(screen.getByRole('button', { name: 'Remove key' })).toHaveAttribute('data-icon-button', 'danger')
    expect(screen.getByRole('button', { name: 'Busy' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Busy' })).toHaveAttribute('aria-busy', 'true')
    await userEvent.click(set)
    expect(setKey).toHaveBeenCalledOnce()
    await userEvent.pointer({ keys: '[MouseRight]', target: screen.getByTestId('row') })
    const menu = await screen.findByRole('menu', { name: 'Provider actions' })
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(['Set key', 'Remove key', 'Busy'])
  })

  it('renders nothing for a row without actions', () => {
    const { container } = render(<RowActionButtons actions={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
