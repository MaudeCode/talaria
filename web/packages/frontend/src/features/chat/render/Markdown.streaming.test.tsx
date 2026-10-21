import { memo, useContext } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import Markdown from './MarkdownRenderer'

const { controlRender } = vi.hoisted(() => ({ controlRender: vi.fn() }))

afterEach(() => { Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo') })

vi.mock('streamdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('streamdown')>()
  return {
    ...actual,
    // Observe a real control's context subscription without replacing Streamdown's provider or parser.
    CodeBlockCopyButton: memo(function CopyButtonProbe(props: React.ComponentProps<typeof actual.CodeBlockCopyButton>) {
      useContext(actual.StreamdownContext)
      controlRender()
      return <actual.CodeBlockCopyButton {...props} />
    }),
  }
})

it('keeps a completed code-block control stable while subsequent text streams', async () => {
  // jsdom has no scrolling implementation for Streamdown's live code-block effect.
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  const code = '```json\n{"answer": 42}\n```\n\n'
  let text = `${code}A response`
  const view = render(<Markdown text={text} streaming />)
  const copy = await screen.findByRole('button', { name: 'Copy Code' })
  expect(controlRender).toHaveBeenCalledTimes(1)

  for (const chunk of [' continues', ' with more', ' text.']) {
    text += chunk
    view.rerender(<Markdown text={text} streaming />)
    expect(screen.getByText(text.slice(code.length))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy Code' })).toBe(copy)
  }

  expect(controlRender).toHaveBeenCalledTimes(1)
})
