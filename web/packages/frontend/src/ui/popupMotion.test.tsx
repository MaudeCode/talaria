import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConfirmDialog, Dialog } from './Dialog'
import { Menu, MenuItem } from './Menu'
import { BACKDROP_MOTION, DIALOG_MOTION, POPUP_MOTION, TOOLTIP_MOTION } from './popupMotion'
import { Tooltip } from './Tooltip'

/**
 * TAL-1784: each shared surface renders its motion. `e2e/popup-motion.spec.ts` owns the transitions that actually run,
 * and the lint rule in `.oxlintrc.json` (`lint.test.ts`) owns every direct Base UI popup using these constants.
 */

const classes = (motion: string) => motion.split(' ')

afterEach(() => { delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations })

describe('popup motion', () => {
  // e2e/popup-motion.spec.ts sees the Select and HelpTip popups run these transitions; this owns the dropdown Menu and Tooltip.
  it('renders on a dropdown menu and a tooltip, each opened as a user opens it', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Menu label="Actions" trigger={<button type="button">Open</button>}><MenuItem>Rename</MenuItem></Menu>)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(await screen.findByRole('menu')).toHaveClass(...classes(POPUP_MOTION))
    await user.keyboard('{Escape}')

    rerender(<Tooltip label="Hint"><button type="button">Hover</button></Tooltip>)
    await user.hover(screen.getByRole('button', { name: 'Hover' }))
    expect(await screen.findByText('Hint')).toHaveClass(...classes(TOOLTIP_MOTION))
  })

  // e2e/popup-motion.spec.ts sees the alertdialog and its backdrop run their transitions; the plain Dialog has no browser check.
  it('renders on a dialog and its backdrop', () => {
    render(<Dialog open onOpenChange={() => undefined} title="Rename" />)
    expect(screen.getByRole('dialog')).toHaveClass(...classes(DIALOG_MOTION))
    expect(document.querySelector('[role="presentation"][class*="bg-black"]')).toHaveClass(...classes(BACKDROP_MOTION))
  })

  it('keeps showing what a dialog showed while it closes, after its parent cleared the values', () => {
    // A running exit transition: Base UI keeps the popup mounted until this finishes.
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: () => [{ finished: new Promise(() => undefined), pending: true }] })
    const dialog = (name: string | null) => <ConfirmDialog open={name !== null} onOpenChange={() => undefined} title={name ?? ''} confirmLabel={name ? 'Remove' : ''} cancelLabel="Cancel" onConfirm={() => undefined} />
    const { rerender } = render(dialog('Old connector'))
    rerender(dialog(null))
    const closing = screen.getByRole('alertdialog', { hidden: true })
    expect(closing).toHaveAttribute('data-ending-style')
    expect(closing).toHaveTextContent('Old connector')
    expect(closing).toHaveTextContent('Remove')
  })
})
