import { expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SharedTranscript } from './SharedTranscript'

it('shows angle-bracket placeholders in a shared message (TAL-2715)', async () => {
  render(<SharedTranscript messages={[{ role: 'assistant', content: 'Run git checkout <branch-name> now' }]} />)
  // The loading fallback is a div of raw text; only the rendered paragraph proves the renderer kept the words.
  expect(await screen.findByText('Run git checkout <branch-name> now', { selector: 'p' })).toBeInTheDocument()
})
