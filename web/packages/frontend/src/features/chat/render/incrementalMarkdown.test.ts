import { describe, expect, it } from 'vitest'
import { parseMarkdownIntoBlocks } from 'streamdown'
import fixtures from '../__fixtures__/streamingMarkdown'
import { createIncrementalMarkdownParser } from './incrementalMarkdown'

describe('incremental Markdown blocks', () => {
  it.each(Object.entries(fixtures))('preserves full-parser blocks at every character of %s', (_, text) => {
    const parse = createIncrementalMarkdownParser()
    for (let length = 0; length <= text.length; length += 1) {
      const frame = text.slice(0, length)
      expect(parse(frame), `frame ${length}: ${frame}`).toEqual(parseMarkdownIntoBlocks(frame))
    }
  })

  it('resets on shrink, replacement, replay and an abandoned render', () => {
    const parse = createIncrementalMarkdownParser()
    for (const text of ['First.\n\nSecond.\n\nThird.', 'First.', 'Other.\n\nReply.', '', fixtures.lists, 'Other.\n\nReply.']) {
      expect(parse(text)).toEqual(parseMarkdownIntoBlocks(text))
    }
  })
})
