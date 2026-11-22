import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { AttachControl, TOUCH_QUERY } from './AttachControl'

/** TAL-1124: touch devices choose between the camera and files from the shared menu; a mouse opens the file picker. */

const listeners = new Set<() => void>()
let coarse = false
/** A pointer whose kind the test sets, telling `TOUCH_QUERY` listeners when it changes. */
function pointer(touch: boolean) {
  coarse = touch
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return query === TOUCH_QUERY && coarse },
    media: query,
    addEventListener: (_: string, on: () => void) => { listeners.add(on) },
    removeEventListener: (_: string, on: () => void) => { listeners.delete(on) },
  }))
}
const switchPointer = (touch: boolean) => { act(() => { coarse = touch; listeners.forEach((on) => { on() }) }) }

afterEach(() => { vi.unstubAllGlobals(); listeners.clear() })

const fallback = createRef<HTMLTextAreaElement>()
function renderControl(owner = 'chat-a') {
  const onFiles = vi.fn()
  const tree = (who: string, shown = true) => <><textarea ref={fallback} aria-label="Message" />{shown && <AttachControl owner={who} onFiles={onFiles} fallbackFocus={fallback} />}</>
  const view = render(tree(owner))
  const picks = { files: vi.fn(), camera: vi.fn() }
  // jsdom opens no picker; a click on an input is the picker opening.
  const watch = () => {
    document.querySelector('#fileInput')?.addEventListener('click', picks.files)
    document.querySelector('#cameraInput')?.addEventListener('click', picks.camera)
  }
  watch()
  return { onFiles, picks, rerender: (who: string, shown = true) => { view.rerender(tree(who, shown)); watch() } }
}
const trigger = () => screen.getByRole('button', { name: 'Attach files' })

describe('AttachControl', () => {
  it('opens the file picker directly under a mouse, with no menu or camera input', async () => {
    pointer(false)
    const { picks } = renderControl()
    await userEvent.click(trigger())
    expect(picks.files).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.querySelector('#cameraInput')).toBeNull()
  })

  it('offers Take photo with the rear camera and Choose files on a touch device, returning focus to the button', async () => {
    pointer(true)
    const { picks } = renderControl()
    await userEvent.click(trigger())
    const photo = await screen.findByRole('menuitem', { name: 'Take photo' })
    // The button keeps its name while its menu is open.
    expect(trigger()).toHaveAttribute('data-popup-open')
    await userEvent.click(photo)
    expect(picks.camera).toHaveBeenCalledOnce()
    expect(picks.files).not.toHaveBeenCalled()
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(trigger()).toHaveFocus()
    const camera = document.querySelector<HTMLInputElement>('#cameraInput')!
    expect([camera.accept, camera.getAttribute('capture'), camera.multiple]).toEqual(['image/*', 'environment', false])
    expect(document.querySelector<HTMLInputElement>('#fileInput')!.multiple).toBe(true)
  })

  it('moves through the menu by keyboard, picks files with Enter and closes on Escape and a second press', async () => {
    pointer(true)
    const { picks } = renderControl()
    trigger().focus()
    await userEvent.keyboard('{Enter}')
    await screen.findByRole('menu')
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(picks.files).toHaveBeenCalledOnce()
    expect(picks.camera).not.toHaveBeenCalled()
    await waitFor(() => { expect(trigger()).toHaveFocus() })
    await userEvent.keyboard('{Enter}')
    await screen.findByRole('menu')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(trigger()).toHaveFocus()
    // A tap opens it and a second tap on the same button closes it.
    await userEvent.pointer({ keys: '[TouchA]', target: trigger() })
    await screen.findByRole('menu')
    await userEvent.pointer({ keys: '[TouchA]', target: trigger() })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
  })

  it('adds nothing when a picker is cancelled and keeps focus on the button', async () => {
    pointer(true)
    const { onFiles } = renderControl()
    await userEvent.click(trigger())
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Choose files' }))
    await waitFor(() => { expect(trigger()).toHaveFocus() })
    fireEvent.change(document.querySelector<HTMLInputElement>('#fileInput')!, { target: { files: [] } })
    expect(onFiles).not.toHaveBeenCalled()
    expect(trigger()).toHaveFocus()
  })

  it.each([
    ['the control is hidden', (r: ReturnType<typeof renderControl>) => { r.rerender('chat-a', false) }],
    ['a mouse takes over', () => { switchPointer(false) }],
  ])('closes and hands focus back to the composer when %s while open', async (_, change) => {
    pointer(true)
    const control = renderControl()
    trigger().focus()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => { expect(screen.getAllByRole('menuitem')[0]).toHaveFocus() })
    change(control)
    await waitFor(() => { expect(fallback.current).toHaveFocus() })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
