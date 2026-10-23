import { memo, useContext } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import Markdown from './MarkdownRenderer'
import fixtures from '../__fixtures__/streamingMarkdown'

const { controlRender, parseInput, parserProbe } = vi.hoisted(() => ({ controlRender: vi.fn(), parseInput: vi.fn<(length: number) => void>(), parserProbe: { full: false } }))

beforeEach(() => { vi.clearAllMocks(); parserProbe.full = false })

afterEach(() => { Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo') })

vi.mock('streamdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('streamdown')>()
  const parseMarkdownIntoBlocks: typeof actual.parseMarkdownIntoBlocks = (text) => {
    parseInput(text.length)
    return actual.parseMarkdownIntoBlocks(text)
  }
  return {
    ...actual,
    parseMarkdownIntoBlocks,
    // Count the input to the real parser, including the default pre-optimization path.
    Streamdown: (props: React.ComponentProps<typeof actual.Streamdown>) => (
      <actual.Streamdown {...props} parseMarkdownIntoBlocksFn={parserProbe.full ? parseMarkdownIntoBlocks : props.parseMarkdownIntoBlocksFn ?? parseMarkdownIntoBlocks} />
    ),
    // Observe a real control's context subscription without replacing Streamdown's provider or parser.
    CodeBlockCopyButton: memo(function CopyButtonProbe(props: React.ComponentProps<typeof actual.CodeBlockCopyButton>) {
      useContext(actual.StreamdownContext)
      controlRender()
      return <actual.CodeBlockCopyButton {...props} />
    }),
  }
})

it('renders blank tab separators like the original streaming parser at every character', () => {
  const text = 'First.\r\n \t\r\nSecond with **formatting**.\n\t\nThird.'
  const view = render(<Markdown text="" streaming />)
  for (let length = 1; length <= text.length; length += 1) {
    const frame = text.slice(0, length)
    view.rerender(<Markdown text={frame} streaming />)
    parserProbe.full = true
    const original = render(<Markdown text={frame} streaming />)
    parserProbe.full = false
    // Streamdown's display:contents block wrappers differ when a tab separator starts settling.
    expect([...view.container.querySelectorAll('p')].map((node) => node.outerHTML)).toEqual([...original.container.querySelectorAll('p')].map((node) => node.outerHTML))
    original.unmount()
  }
})

it.each(['\n\n', '\r\n\r\n', '\n  \n', '\r\n \t\r\n'])('lexes a 200-paragraph reply in 400 increments with a bounded character budget for %j', (separator) => {
  const text = Array.from({ length: 200 }, (_, i) => `Paragraph ${i}: a streamed reply with **formatted** content.${separator}`).join('')
  const view = render(<Markdown text="" streaming />)
  for (let frame = 1; frame <= 400; frame += 1) {
    view.rerender(<Markdown text={text.slice(0, Math.ceil(text.length * frame / 400))} streaming />)
  }
  const characters = parseInput.mock.calls.reduce((sum, [length]) => sum + length, 0)
  // Each frame adds roughly half a paragraph; retain at most the unfinished block.
  expect(characters).toBeLessThan(text.length * 6)
  expect(view.container.querySelectorAll('p')).toHaveLength(200)
})

it.each(Object.entries(fixtures))('converges to the static DOM and snapshot for %s', async (name, text) => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  const view = render(<Markdown text="" streaming />)
  for (let length = 1; length <= text.length; length += 3) {
    view.rerender(<Markdown text={text.slice(0, length)} streaming />)
  }
  view.rerender(<Markdown text={text} streaming />)
  if (name === 'math') await waitFor(() => { expect(view.container.querySelector('.katex')).not.toBeNull() })
  view.rerender(<Markdown text={text} />)
  const streamed = view.container.innerHTML
  view.unmount()
  const staticView = render(<Markdown text={text} />)
  if (name === 'math') await waitFor(() => { expect(staticView.container.querySelector('.katex')).not.toBeNull() })
  expect(streamed).toBe(staticView.container.innerHTML)
  // Snapshot semantic content without generated SVG/control IDs or KaTeX's presentation tree.
  expect([...staticView.container.querySelectorAll('p, li, pre, table')].map((node) => ({ tag: node.tagName, text: node.textContent }))).toMatchSnapshot()
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
