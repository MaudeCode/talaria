import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ContextMenu, Menu, MenuItem, MenuRadioGroup, MenuRadioItem } from './Menu'

/** TAL-1131: the shared menu pins an optional header and keeps the chosen or highlighted row inside its scrolling rows. */

const ROW_HEIGHT = 20
const VIEW = { top: 100, height: 100 }
const IDS = Array.from({ length: 25 }, (_, i) => `row-${String(i + 1)}`)

// jsdom has no layout: rows stack at ROW_HEIGHT inside a VIEW-tall scroller, and the observer runs when the test resizes it.
let resize: (() => void) | null = null
function layout() {
  // Floating UI observes the anchor too; only the menu's scroller drives the reveal under test.
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly callback: () => void) {}
    observe(el: Element) { if (el.classList.contains('overflow-y-auto')) { resize = this.callback; resize() } }
    unobserve = () => undefined
    disconnect = () => undefined
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const index = IDS.indexOf(this.textContent ?? '')
    if (this.getAttribute('role') === 'menuitemradio' && index >= 0) {
      const scroller = this.closest<HTMLElement>('.overflow-y-auto')!
      const top = VIEW.top + index * ROW_HEIGHT - scroller.scrollTop
      return { top, bottom: top + ROW_HEIGHT, height: ROW_HEIGHT, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }
    }
    return { top: VIEW.top, bottom: VIEW.top + VIEW.height, height: VIEW.height, left: 0, right: 100, width: 100, x: 0, y: VIEW.top, toJSON: () => ({}) }
  })
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resize = null })

function LongMenu({ value, header }: { value: string; header?: boolean }) {
  return <Menu label="Long" trigger={<button type="button">Open</button>} {...(header ? { header: <input aria-label="Filter" /> } : {})}>
    <MenuRadioGroup value={value}>{IDS.map((id) => <MenuRadioItem key={id} value={id}>{id}</MenuRadioItem>)}</MenuRadioGroup>
  </Menu>
}

describe('Menu', () => {
  it('keeps the header outside the scrolling rows and centres the checked row on open', async () => {
    layout()
    render(<LongMenu value="row-20" header />)
    await userEvent.click(screen.getByRole('button', { name: 'Open' }))
    const scroller = (await screen.findByRole('menuitemradio', { name: 'row-20' })).closest<HTMLElement>('.overflow-y-auto')!
    expect(scroller).not.toContainElement(screen.getByRole('textbox', { name: 'Filter' }))
    expect(screen.getByRole('menu')).toContainElement(screen.getByRole('textbox', { name: 'Filter' }))
    // row-20 starts 380 px into the list; centring it in a 100 px view scrolls to 380 - 40.
    expect(scroller.scrollTop).toBe(340)
  })

  it('scrolls a header-less menu itself and keeps the highlighted row in view when it resizes', async () => {
    layout()
    render(<LongMenu value="row-1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Open' }))
    const menu = await screen.findByRole('menu')
    expect(menu.scrollTop).toBe(0)
    const row = screen.getByRole('menuitemradio', { name: 'row-12' })
    act(() => { row.setAttribute('data-highlighted', ''); resize?.() })
    // row-12 ends at 240 px; the nearest edge puts it at the bottom of the view.
    expect(menu.scrollTop).toBe(140)
  })

  it('leaves the scroll alone with no checked row', async () => {
    layout()
    render(<LongMenu value="" header />)
    await userEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect((await screen.findByRole('menuitemradio', { name: 'row-1' })).closest<HTMLElement>('.overflow-y-auto')!.scrollTop).toBe(0)
  })
})

/** TAL-699: the custom menu replaces the browser's own except in text fields, on a selection, and on nested links. */
describe('ContextMenu', () => {
  function Row({ onClick }: { onClick?: () => void }) {
    return <ContextMenu label="Row actions" trigger={<a href="/row" onClick={onClick}>
      <span>Row title</span>
      <input aria-label="Field" />
      <textarea aria-label="Notes" />
      <select aria-label="Choice"><option>One</option></select>
      <span contentEditable suppressContentEditableWarning>Editable</span>
      <a href="/nested">Nested link</a>
    </a>}>
      <MenuItem>Pin</MenuItem>
    </ContextMenu>
  }
  // fireEvent returns false once a handler cancels the event, so true means the browser shows its own menu.
  const rightClick = (el: Element) => fireEvent.contextMenu(el, { clientX: 10, clientY: 10 })

  afterEach(() => { document.getSelection()?.removeAllRanges() })

  it('opens on right-click anywhere else in the trigger, including when the trigger is itself a link', async () => {
    render(<Row />)
    expect(rightClick(screen.getByText('Row title'))).toBe(false)
    expect(await screen.findByRole('menu', { name: 'Row actions' })).toBeInTheDocument()
  })

  it.each([
    ['input', () => screen.getByRole('textbox', { name: 'Field' })],
    ['textarea', () => screen.getByRole('textbox', { name: 'Notes' })],
    ['select', () => screen.getByRole('combobox', { name: 'Choice' })],
    ['contenteditable', () => screen.getByText('Editable')],
    ['nested link', () => screen.getByRole('link', { name: 'Nested link' })],
  ])('keeps the native menu on a %s inside the trigger', (_, target) => {
    render(<Row />)
    expect(rightClick(target())).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps the native menu while text inside the trigger is selected', () => {
    render(<Row />)
    const title = screen.getByText('Row title')
    const range = document.createRange()
    range.selectNodeContents(title)
    document.getSelection()!.addRange(range)
    expect(rightClick(title)).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens on long-press without the release click activating the trigger, and a long-press in a text field leaves it alone', async () => {
    vi.useFakeTimers()
    const clicked = vi.fn()
    try {
      render(<Row onClick={clicked} />)
      const press = (el: Element) => { fireEvent.touchStart(el, { touches: [{ clientX: 10, clientY: 10 }] }); act(() => { vi.advanceTimersByTime(600) }); fireEvent.touchEnd(el) }
      press(screen.getByRole('textbox', { name: 'Field' }))
      expect(screen.queryByRole('menu')).toBeNull()
      press(screen.getByText('Row title'))
      await act(async () => { await vi.runAllTimersAsync() })
      expect(screen.getByRole('menu', { name: 'Row actions' })).toBeInTheDocument()
      // Some browsers send a click when the finger lifts; it neither follows the link nor runs the trigger's handler.
      expect(fireEvent.click(screen.getByText('Row title'))).toBe(false)
      expect(clicked).not.toHaveBeenCalled()
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
      await act(async () => { await vi.runAllTimersAsync() })
      expect(screen.queryByRole('menu')).toBeNull()
      fireEvent.click(screen.getByText('Row title'))
      expect(clicked).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })
})
