import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConfirmDialog, Dialog } from './Dialog'
import { HelpTip } from './Field'
import { Menu, MenuItem } from './Menu'
import { BACKDROP_MOTION, DIALOG_MOTION, POPUP_MOTION, TOOLTIP_MOTION } from './popupMotion'
import { Select } from './Select'
import { Tooltip } from './Tooltip'

/**
 * TAL-1784: each shared surface renders its motion. `e2e/popup-motion.spec.ts` owns the transitions that actually run,
 * and the lint rule in `.oxlintrc.json` (`lint.test.ts`) owns every direct Base UI popup using these constants.
 */

const classes = (motion: string) => motion.split(' ')

afterEach(() => { delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations })

describe('popup motion', () => {
  it('renders on a menu, Select, popover and tooltip, each opened as a user opens it', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Menu label="Actions" trigger={<button type="button">Open</button>}><MenuItem>Rename</MenuItem></Menu>)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(await screen.findByRole('menu')).toHaveClass(...classes(POPUP_MOTION))
    await user.keyboard('{Escape}')

    rerender(<Select value="a" onValueChange={() => undefined} aria-label="Pick"><option value="a">A</option></Select>)
    await user.click(screen.getByRole('combobox', { name: 'Pick' }))
    expect((await screen.findByRole('option', { name: 'A' })).closest('[data-side]')).toHaveClass(...classes(POPUP_MOTION))
    await user.keyboard('{Escape}')

    rerender(<HelpTip label="Why">Because</HelpTip>)
    await user.click(screen.getByRole('button', { name: 'Why' }))
    expect((await screen.findByText('Because'))).toHaveClass(...classes(POPUP_MOTION))
    await user.keyboard('{Escape}')

    rerender(<Tooltip label="Hint"><button type="button">Hover</button></Tooltip>)
    await user.hover(screen.getByRole('button', { name: 'Hover' }))
    expect(await screen.findByText('Hint')).toHaveClass(...classes(TOOLTIP_MOTION))
  })

  it.each([
    ['dialog', <Dialog key="dialog" open onOpenChange={() => undefined} title="Rename" />],
    ['alertdialog', <ConfirmDialog key="confirm" open onOpenChange={() => undefined} title="Delete" confirmLabel="Delete" cancelLabel="Cancel" onConfirm={() => undefined} />],
  ])('renders on an %s and its backdrop', (role, surface) => {
    render(surface)
    expect(screen.getByRole(role)).toHaveClass(...classes(DIALOG_MOTION))
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
