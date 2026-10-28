import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Streamdown } from 'streamdown'
import { math } from '@streamdown/math'

const renderMath = (text: string) => renderToStaticMarkup(<Streamdown mode="static" plugins={{ math }}>{text}</Streamdown>)

it('refuses external math images even when trust is inherited (TAL-1497)', () => {
  const expression = '$$\\includegraphics{https://probe.invalid/tracker.png}$$'
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'trust')
  try {
    expect(renderMath(expression)).not.toContain('<img')
    // Synthetic pollution precondition, scoped to this synchronous render in an isolated test worker.
    Object.defineProperty(Object.prototype, 'trust', { configurable: true, enumerable: true, writable: true, value: true })
    const output = renderMath(expression)
    expect(output).not.toContain('<img')
    expect(output).not.toContain('rel="preload"')
  } finally {
    if (original) Object.defineProperty(Object.prototype, 'trust', original)
    else Reflect.deleteProperty(Object.prototype, 'trust')
  }
})

it('preserves inline and block math and readable malformed expressions', () => {
  const output = renderMath('Inline $$x^2$$.\n\n$$\nx^2 + y^2 = z^2\n$$\n\n$$\\notARealCommand{x}$$')
  expect(output).toContain('class="katex"')
  expect(output).toContain('class="katex-display"')
  expect(output).toContain('encoding="application/x-tex"')
  expect(output).toContain('x^2 + y^2 = z^2')
  expect(output).toContain('\\notARealCommand')
})
