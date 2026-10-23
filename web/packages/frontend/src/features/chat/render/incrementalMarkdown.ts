import { parseMarkdownIntoBlocks } from 'streamdown'

/** Extend Streamdown's parser, retaining its fence, list, HTML and math grouping. */
export function createIncrementalMarkdownParser(): typeof parseMarkdownIntoBlocks {
  let prefix = ''
  let settled: string[] = []
  return (text) => {
    // Edits, shrink and abandoned renders can replace the prefix.
    if (!text.startsWith(prefix)) {
      prefix = ''
      settled = []
    }
    const tail = text.slice(prefix.length)
    // Definitions can change earlier blocks. A settled blank line cannot split this syntax.
    if (/\[\^|^[ \t]{0,3}\[[^\]\n]+\]:/m.test(tail)) {
      prefix = ''
      settled = []
      return parseMarkdownIntoBlocks(text)
    }
    const blocks = parseMarkdownIntoBlocks(tail)
    // A definition or parser normalization may consume source without returning its raw text.
    if (blocks.join('') !== tail) {
      prefix = ''
      settled = []
      return parseMarkdownIntoBlocks(text)
    }
    let offset = prefix.length
    let boundary = 0
    let end = offset
    for (const [i, block] of blocks.entries()) {
      const next = blocks[i + 1]
      if (next === undefined) break
      offset += block.length
      // Wait for an unindented, non-list successor. Partial markers such as "1" must stay in the tail.
      if (text.slice(offset - 2, offset) === '\n\n' && /^[^\s\d*+>\-]/.test(next)) {
        boundary = i + 1
        end = offset
      }
    }
    const result = [...settled, ...blocks]
    if (boundary > 0) {
      settled = [...settled, ...blocks.slice(0, boundary)]
      prefix = text.slice(0, end)
    }
    return result
  }
}
