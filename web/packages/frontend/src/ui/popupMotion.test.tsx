import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConfirmDialog, Dialog } from './Dialog'
import { Menu, MenuItem } from './Menu'

/** TAL-1784: every floating surface shares one motion. The real transitions run in `e2e/popup-motion.spec.ts`. */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const components = readdirSync(root, { recursive: true }).map(String).filter((file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx'))
// `POPUP` and `BACKDROP` are `ui/Menu.tsx`'s and `ui/Dialog.tsx`'s shared classes, which carry the motion.
const SHARED = { Popup: /\b(POPUP|POPUP_MOTION|TOOLTIP_MOTION|DIALOG_MOTION)\b/, Backdrop: /\bBACKDROP(_MOTION)?\b/ }

function baseUiParts() {
  return components.flatMap((file) => [...readFileSync(join(root, file), 'utf8').matchAll(/<(?:\w+)\.(Popup|Backdrop)\b((?:=>|[^>])*)>/g)]
    .map(([, part, attributes]) => ({ file, part: part as keyof typeof SHARED, attributes: attributes ?? '' })))
}

afterEach(() => {
  vi.restoreAllMocks()
  delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations
})

describe('popup motion', () => {
  it('is shared by every Base UI popup and backdrop in the frontend', () => {
    const parts = baseUiParts()
    expect(parts.filter(({ part }) => part === 'Popup').length).toBeGreaterThan(0)
    expect(parts.filter(({ part }) => part === 'Backdrop').length).toBeGreaterThan(0)
    expect(parts.filter(({ part, attributes }) => !SHARED[part].test(attributes)).map(({ file, part }) => `${file}: ${part}`)).toEqual([])
  })

  it('asks each surface for its entrance and its shorter exit', async () => {
    render(<>
      <Menu label="Actions" open trigger={<button type="button">Open</button>}><MenuItem>Rename</MenuItem></Menu>
      <Dialog open onOpenChange={() => undefined} title="Rename" />
    </>)
    const menu = await screen.findByRole('menu', { hidden: true })
    expect(menu.className).toContain('origin-(--transform-origin)')
    expect(menu.className).toContain('data-starting-style:scale-[.96]')
    expect(menu.className).toContain('duration-[160ms]')
    expect(menu.className).toContain('data-ending-style:duration-[110ms]')
    const dialog = screen.getByRole('dialog', { hidden: true })
    expect(dialog.className).toContain('data-starting-style:[transform:translateY(8px)_scale(.97)]')
    expect(dialog.className).toContain('duration-[260ms]')
    expect(dialog.className).toContain('data-ending-style:duration-[150ms]')
    expect(document.querySelector('[role="presentation"][class*="bg-black"]')?.className).toContain('data-ending-style:duration-[160ms]')
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
