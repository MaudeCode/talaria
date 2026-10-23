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
    // Marked normalizes newlines before lexing; keep the cache's source offsets in the original text.
    const normalizedTail = tail.replace(/\r\n?/g, '\n')
    // Definitions can change earlier blocks. A settled blank line cannot split this syntax.
    if (/\[\^|^[ \t]{0,3}\[[^\]\n]+\]:/m.test(normalizedTail)) {
      prefix = ''
      settled = []
      return parseMarkdownIntoBlocks(text)
    }
    // Marked's block splitter misses blank tab lines. Only its input uses spaces; returned code keeps its tabs.
    const lexerTail = normalizedTail.replace(/^[ \t]+$/gm, (line) => line.replaceAll('\t', ' '))
    const parsed = parseMarkdownIntoBlocks(lexerTail)
    // A definition or parser normalization may consume source without returning its raw text.
    if (parsed.join('') !== lexerTail) {
      prefix = ''
      settled = []
      return parseMarkdownIntoBlocks(text)
    }
    let rawOffset = 0
    const blocks = parsed.map((block) => {
      const raw = normalizedTail.slice(rawOffset, rawOffset + block.length)
      rawOffset += block.length
      return raw
    })
    let offset = 0
    let boundary = 0
    let end = offset
    for (const [i, block] of blocks.entries()) {
      const next = blocks[i + 1]
      if (next === undefined) break
      offset += block.length
      // Wait for an unindented, non-list successor. Partial markers such as "1" must stay in the tail.
      let previous = offset - 2
      while (normalizedTail[previous] === ' ' || normalizedTail[previous] === '\t') previous -= 1
      if (normalizedTail[offset - 1] === '\n' && normalizedTail[previous] === '\n' && /^[^\s\d*+>\-]/.test(next)) {
        boundary = i + 1
        end = offset
      }
    }
    const result = [...settled, ...blocks]
    if (boundary > 0) {
      settled = [...settled, ...blocks.slice(0, boundary)]
      let sourceEnd = 0
      for (let normalized = 0; normalized < end; normalized += 1) {
        sourceEnd += tail[sourceEnd] === '\r' && tail[sourceEnd + 1] === '\n' ? 2 : 1
      }
      prefix = text.slice(0, prefix.length + sourceEnd)
    }
    return result
  }
}
