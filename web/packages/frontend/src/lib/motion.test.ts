import { afterEach, expect, it, vi } from 'vitest'
import { flipList, measureList } from './motion'
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
