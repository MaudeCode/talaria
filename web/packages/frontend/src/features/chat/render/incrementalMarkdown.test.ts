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

  it('settles blank tab lines while preserving tabs inside code blocks', () => {
    const text = 'First.\n \t\nSecond.\n\t\n```text\ncode\n\t\nmore\n```\n\t\nAfter.'
    const blocks = createIncrementalMarkdownParser()(text)
    expect(blocks).toEqual(['First.', '\n \t\n', 'Second.', '\n\t\n', '```text\ncode\n\t\nmore\n```', '\n\t\n', 'After.'])
    expect(blocks.join('')).toBe(text)
  })

  it.each(['    first\n\t\n    second', '```text\nfirst\n\t\nsecond\n```', '<span>\n\t\nfirst\n\t\n</span>'])('preserves blank tabs in code and HTML: %j', (text) => {
    const parse = createIncrementalMarkdownParser()
    for (let length = 0; length <= text.length; length += 1) {
      const frame = text.slice(0, length)
      expect(parse(frame)).toEqual(parseMarkdownIntoBlocks(frame))
    }
  })
})
