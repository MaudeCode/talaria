import { describe, expect, it } from 'vitest'
import { safeNextPath } from './safeNextPath'

describe('safeNextPath', () => {
  it('accepts a plain app path', () => {
    expect(safeNextPath('/settings?x=1')).toBe('/settings?x=1')
    expect(safeNextPath('/session/abc')).toBe('/session/abc')
  })
  it('rejects open redirects and malformed targets', () => {
    expect(safeNextPath('//evil.com')).toBe('./')
    expect(safeNextPath('/\\evil.com')).toBe('./')
    expect(safeNextPath('https://evil.com')).toBe('./')
    expect(safeNextPath('/a\nb')).toBe('./')
    expect(safeNextPath('')).toBe('./')
    expect(safeNextPath(null)).toBe('./')
  })
  it('collapses login chains even when nested-encoded', () => {
    expect(safeNextPath('/login')).toBe('./')
    expect(safeNextPath('/session/login?next=%2Fx')).toBe('./')
    expect(safeNextPath('/session/login%3Fnext%3D%252Flogin')).toBe('./')
  })
  it('fails closed on pathologically deep encoding', () => {
    let deep = '/x'
    for (let i = 0; i < 12; i++) deep = encodeURIComponent(deep)
    expect(safeNextPath(deep)).toBe('./')
  })
})
