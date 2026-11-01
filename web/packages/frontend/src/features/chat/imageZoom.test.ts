import { describe, expect, it } from 'vitest'
import { clampOffset, clampScale, MAX_ZOOM, wheelFactor, zoomAround, zoomBounds } from './imageZoom'

const stage = { w: 1000, h: 600 }

describe('lightbox zoom geometry (TAL-1530)', () => {
  it('fits a large image, never upscales a small one, and bounds zoom between min(0.25, fit) and 8', () => {
    expect(zoomBounds({ w: 2400, h: 1600 }, stage)).toEqual({ fit: 0.375, min: 0.25, max: MAX_ZOOM })
    expect(zoomBounds({ w: 120, h: 80 }, stage)).toEqual({ fit: 1, min: 0.25, max: MAX_ZOOM })
    expect(zoomBounds({ w: 900, h: 6000 }, stage).min).toBe(0.1)
    expect(clampScale(20, { w: 120, h: 80 }, stage)).toBe(MAX_ZOOM)
    expect(clampScale(0.01, { w: 120, h: 80 }, stage)).toBe(0.25)
  })

  it('centres an axis that fits and keeps an overflowing axis covering the stage', () => {
    const image = { w: 2000, h: 500 }
    expect(clampOffset({ x: 5000, y: 300 }, 1, image, stage)).toEqual({ x: 500, y: 0 })
    expect(clampOffset({ x: -5000, y: -300 }, 2, image, stage)).toEqual({ x: -1500, y: -200 })
  })

  it('keeps the anchored image point in place while zooming', () => {
    const anchor = { x: 200, y: -100 }
    const offset = { x: 50, y: 20 }
    const next = zoomAround(offset, 1, 2, anchor)
    // The image point under the anchor sat (anchor - offset) / 1 from the image centre; at scale 2 it maps back to the anchor.
    expect(next.x + (anchor.x - offset.x) * 2).toBe(anchor.x)
    expect(next.y + (anchor.y - offset.y) * 2).toBe(anchor.y)
  })

  it('converts pixel, line and page wheel deltas, caps one event, and treats ctrl+wheel as a finer pinch', () => {
    expect(wheelFactor({ deltaY: -48, deltaMode: 0, ctrlKey: false }, 600)).toBeCloseTo(wheelFactor({ deltaY: -3, deltaMode: 1, ctrlKey: false }, 600))
    expect(wheelFactor({ deltaY: -1, deltaMode: 2, ctrlKey: false }, 300)).toBeCloseTo(Math.E)
    expect(wheelFactor({ deltaY: -10, deltaMode: 2, ctrlKey: false }, 600)).toBeCloseTo(Math.E)
    expect(wheelFactor({ deltaY: 100, deltaMode: 0, ctrlKey: false }, 600)).toBeLessThan(1)
    expect(wheelFactor({ deltaY: -10, deltaMode: 0, ctrlKey: true }, 600)).toBeCloseTo(Math.exp(0.1))
  })
})
