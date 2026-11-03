import { expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Markdown } from './Markdown'

// The renderer chunk resolves only when the test releases it, as a slow network would.
const chunk = vi.hoisted(() => Promise.withResolvers<undefined>())
vi.mock('./MarkdownRenderer', async () => {
  await chunk.promise
  return { default: ({ text }: { text: string }) => <p data-testid="rendered">{text.replaceAll('**', '')}</p> }
})

it('shows the raw text at its wrapped height until the renderer chunk replaces it (TAL-1693)', async () => {
  const text = '**Bold** answer\nsecond line'
  const { container } = render(<Markdown text={text} className="hermes-prose user-text" />)
  const fallback = container.firstElementChild as HTMLElement | null
  expect(fallback?.textContent).toBe(text)
  expect(fallback?.className).toBe('hermes-prose user-text')
  expect(fallback?.style.whiteSpace).toBe('pre-wrap')

  chunk.resolve(undefined)
  expect(await screen.findByTestId('rendered')).toHaveTextContent('Bold answer second line')
  expect(container.querySelector('[style*="pre-wrap"]')).toBeNull()
})
