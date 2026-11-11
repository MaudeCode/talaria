import { afterEach, expect, it, vi } from 'vitest'
import { ARRIVE_EASE, flipList, followHeight, measureList } from './motion'
import { stubAnimate } from '../test/animate'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })

it('never measures skipped content or hidden groups, and reduced motion never measures or animates the list', () => {
  const motion = stubAnimate()
  const list = document.createElement('div')
  list.innerHTML = '<div data-motion-key="visible"></div><div data-motion-key="skipped"></div><div hidden><div data-motion-key="hidden"></div></div>'
  document.body.append(list)
  const visible = list.children[0] as HTMLElement
  const skipped = list.children[1] as HTMLElement
  Object.defineProperty(skipped, 'checkVisibility', { value: () => false, configurable: true })
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 120, height: 40 } as DOMRect)
  const before = measureList(list)
  expect([...before.keys()]).toEqual(['visible'])
  expect(measure.mock.instances).toEqual([visible])
  Object.defineProperty(skipped, 'checkVisibility', { value: () => true })
  expect(flipList(list, before)).toEqual([])
  expect(motion.calls).toHaveLength(0)
  measure.mockClear()
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  expect(flipList(list, before)).toEqual([])
  expect(measure).not.toHaveBeenCalled()
  expect(motion.calls).toHaveLength(0)
  motion.restore()
})

it('retargets streamed height from the painted size, including shrink, and releases observer and styles', async () => {
  const motion = stubAnimate()
  let resized = () => undefined
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => undefined) { resized = callback }
    observe = vi.fn()
    disconnect = disconnect
  })
  const wrapper = document.createElement('div'), content = document.createElement('div')
  wrapper.append(content)
  document.body.append(wrapper)
  let target = 20, painted = 20
  content.getBoundingClientRect = () => ({ height: target } as DOMRect)
  wrapper.getBoundingClientRect = () => ({ height: painted } as DOMRect)
  try {
    const stop = followHeight(wrapper, content)
    expect(wrapper.style.height).toBe('20px')
    target = 80; resized()
    expect(motion.calls[0]).toMatchObject({ keyframes: [{ height: '20px' }, { height: '80px' }], options: { duration: 200, easing: ARRIVE_EASE } })
    expect(wrapper.style.overflow).toBe('')
    painted = 45; target = 100; resized()
    expect(motion.calls[0]!.cancel).toHaveBeenCalled()
    expect(motion.calls[1]!.keyframes[0]).toEqual({ height: '45px' })
    painted = 70; target = 30; resized()
    expect(motion.calls[2]!.keyframes).toEqual([{ height: '70px' }, { height: '30px' }])
    motion.calls[2]!.finish()
    await Promise.resolve()
    resized()
    expect(motion.calls).toHaveLength(3)
    stop()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(wrapper.style.height).toBe('')
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    followHeight(wrapper, content)()
    expect(wrapper.style.height).toBe('')
    expect(motion.calls).toHaveLength(3)
  } finally { motion.restore() }
})
