import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { ReasoningBlock } from './ReasoningBlock'

const observers: { targets: Set<Element>; resize: () => void }[] = []
const geometry = vi.fn()
let height = 1000
let viewport = 260

beforeEach(() => {
  height = 1000
  viewport = 260
  observers.length = 0
  geometry.mockClear()
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    geometry()
    return this.classList.contains('thinking-card-body') ? height : 0
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => { geometry(); return viewport })
  vi.stubGlobal('ResizeObserver', class {
    targets = new Set<Element>()
    constructor(callback: () => void) { observers.push({ targets: this.targets, resize: callback }) }
    observe(target: Element) { this.targets.add(target) }
    disconnect() { this.targets.clear() }
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const resize = () => act(() => { for (const observer of observers) if (observer.targets.size) observer.resize() })

it('follows live growth, holds an upward scroll even before its event, and resumes at the tail across reopen', () => {
  const view = render(<ReasoningBlock text="First thoughts" live defaultOpen disclosureKey="a" />)
  const body = () => view.container.querySelector<HTMLElement>('.thinking-card-body')!
  const toggle = () => fireEvent.click(view.getByRole('button'))
  expect(body().scrollTop).toBe(740)
  height = 1400
  view.rerender(<ReasoningBlock text="More thoughts" live defaultOpen disclosureKey="a" />)
  resize()
  expect(body().scrollTop).toBe(1140)
  // DOM movement can precede the browser's scroll event, as in Transcript's follow/hold contract.
  body().scrollTop = 400
  height = 1800
  resize()
  expect(body().scrollTop).toBe(400)
  fireEvent.scroll(body())
  toggle()
  height = 2100
  view.rerender(<ReasoningBlock text="Thoughts while collapsed" live defaultOpen disclosureKey="a" />)
  toggle()
  expect(body().scrollTop).toBe(400)
  height = 2400
  resize()
  expect(body().scrollTop).toBe(400)
  body().scrollTop = 2140
  fireEvent.scroll(body())
  height = 2700
  resize()
  expect(body().scrollTop).toBe(2440)
  toggle(); height = 3000; toggle()
  expect(body().scrollTop).toBe(2740)
  // A size change between our jump and its scroll event must not turn following into a hold.
  height = 3300
  fireEvent.scroll(body())
  resize()
  expect(body().scrollTop).toBe(3040)
})

it('follows interrupted opening layout without allowing a collapsed or obsolete observer to move a replacement', () => {
  const view = render(<ReasoningBlock text="Opening" live defaultOpen disclosureKey="a" />)
  const body = () => view.container.querySelector<HTMLElement>('.thinking-card-body')!
  const old = observers.at(-1)!
  height = 1300; resize()
  expect(body().scrollTop).toBe(1040)
  body().scrollTop = 120; fireEvent.scroll(body())
  fireEvent.click(view.getByRole('button'))
  expect(old.targets.size).toBe(0)
  act(old.resize)
  height = 0; viewport = 0
  fireEvent.click(view.getByRole('button'))
  body().scrollTop = 0
  height = 1300; viewport = 260; resize()
  expect(body().scrollTop).toBe(120)
  view.rerender(<ReasoningBlock text="Replacement" live defaultOpen disclosureKey="b" />)
  expect(body().scrollTop).toBe(1040)
  body().scrollTop = 200; fireEvent.scroll(body())
  act(old.resize)
  height = 1600; resize()
  expect(body().scrollTop).toBe(200)
  const detached = body()
  view.unmount()
  expect(observers.every((observer) => observer.targets.size === 0)).toBe(true)
  geometry.mockClear()
  act(() => { for (const observer of observers) observer.resize() })
  fireEvent.scroll(detached)
  expect(geometry).not.toHaveBeenCalled()
})

it('does no per-delta measurement while collapsed or settled, and rebuilds a live body with fresh intent', () => {
  const view = render(<ReasoningBlock text="Hidden" live disclosureKey="a" />)
  view.rerender(<ReasoningBlock text="Hidden growth" live disclosureKey="a" />)
  resize()
  expect(geometry).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button'))
  const body = view.container.querySelector<HTMLElement>('.thinking-card-body')!
  expect(body.scrollTop).toBe(740)
  const old = observers.at(-1)!
  view.rerender(<ReasoningBlock text="Saved history" disclosureKey="a" />)
  expect(old.targets.size).toBe(0)
  geometry.mockClear()
  view.rerender(<ReasoningBlock text="History rebuild" disclosureKey="a" />)
  act(old.resize)
  resize()
  body.scrollTop = 90
  fireEvent.scroll(body)
  expect(geometry).not.toHaveBeenCalled()
  view.rerender(<ReasoningBlock text="New live content" live disclosureKey="a" />)
  expect(body.scrollTop).toBe(740)
})
