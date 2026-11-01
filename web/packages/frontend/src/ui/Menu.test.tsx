import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Menu, MenuRadioGroup, MenuRadioItem } from './Menu'

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
