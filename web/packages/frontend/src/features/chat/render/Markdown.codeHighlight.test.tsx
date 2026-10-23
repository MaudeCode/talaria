import { afterEach, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import Markdown from './MarkdownRenderer'

const { tokenized } = vi.hoisted(() => ({ tokenized: [] as string[] }))

// Record every line handed to Shiki, whichever code plugin asks for it.
vi.mock('shiki', async (importOriginal) => {
  const actual = await importOriginal<typeof import('shiki')>()
  return {
    ...actual,
    createHighlighter: async (...args: Parameters<typeof actual.createHighlighter>) => {
      const highlighter = await actual.createHighlighter(...args)
      const codeToTokens = highlighter.codeToTokens.bind(highlighter)
      highlighter.codeToTokens = (code, options) => { tokenized.push(...code.split('\n')); return codeToTokens(code, options) }
      return highlighter
    },
  }
})

afterEach(() => { Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo') })

it('highlights each line of a streaming code block once (TAL-1402)', async () => {
  // jsdom has no scrolling implementation for Streamdown's live code-block effect.
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  const lines = Array.from({ length: 500 }, (_, index) => `const value${index} = ${index}`)
  const code = lines.join('\n')
  const fence = (body: string) => `\`\`\`ts\n${body}`
  // Let the TypeScript grammar load before the reply starts streaming.
  const view = render(<Markdown text={fence('const')} />)
  await waitFor(() => { expect(document.querySelector('[data-streamdown="code-block-body"] [style*="--sdm-c"]')).not.toBeNull() })
  tokenized.length = 0

  for (let step = 1; step <= 100; step++) {
    view.rerender(<Markdown text={fence(code.slice(0, Math.round((code.length * step) / 100)))} streaming />)
    await Promise.resolve()
  }
  view.rerender(<Markdown text={fence(`${code}\n\`\`\``)} />)
  await waitFor(() => { expect(tokenized).toContain(lines.at(-1)) })

  expect(tokenized.filter(Boolean)).toEqual(lines)
}, 30_000)
