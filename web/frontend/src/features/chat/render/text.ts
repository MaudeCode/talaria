/** Text normalisation ported from the legacy renderer: tool-call XML removal and inline thinking split. */

const DSML = '(?:\\s*｜\\s*DSML\\s*[｜|]\\s*)?'

/** Remove provider tool-call XML (`<function_calls>…`, DSML variants) that leaks into assistant prose. */
export function stripToolCallXml(text: string): string {
  if (!text) return text
  const lo = text.toLowerCase()
  if (!lo.includes('function_calls') && !lo.includes('dsml') && !lo.includes('<tool_call')) return text
  let s = text.replace(new RegExp(`<${DSML}function_calls>[\\s\\S]*?<\\/${DSML}function_calls>`, 'gi'), '')
  s = s.replace(new RegExp(`<${DSML}function_calls(?:>|$)[\\s\\S]*$`, 'i'), '')
  s = s.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
  s = s.replace(/<tool_call>[\s\S]*$/i, '')
  s = s.replace(/<\s*｜\s*DSML\s*[｜|]\s*/gi, '')
  return s.replace(/^\s+/, '')
}

const THINK_PAIRS: { open: string; close: string }[] = [
  { open: '<think>', close: '</think>' },
  { open: '<thinking>', close: '</thinking>' },
  { open: '<|channel|>thought', close: '<channel|>' },
  { open: '<|turn|>thinking', close: '<turn|>' },
]

export interface ThinkingSplit { reasoning: string; content: string; inThinking: boolean }

/** Split inline thinking blocks out of assistant content. In streaming mode an unterminated opener is treated as still thinking. */
export function extractInlineThinking(raw: string, streaming = false): ThinkingSplit {
  const text = raw
  if (!THINK_PAIRS.some((p) => text.includes(p.open))) return { reasoning: '', content: text, inThinking: false }
  let content = ''
  let reasoning = ''
  let inThinking = false
  let cursor = 0
  while (cursor < text.length) {
    let nextOpen = -1
    let pair: { open: string; close: string } | null = null
    for (const p of THINK_PAIRS) {
      const i = text.indexOf(p.open, cursor)
      if (i !== -1 && (nextOpen === -1 || i < nextOpen)) { nextOpen = i; pair = p }
    }
    if (nextOpen === -1 || !pair) { content += text.slice(cursor); break }
    content += text.slice(cursor, nextOpen)
    const bodyStart = nextOpen + pair.open.length
    const close = text.indexOf(pair.close, bodyStart)
    if (close === -1) {
      reasoning += text.slice(bodyStart)
      inThinking = streaming
      break
    }
    reasoning += text.slice(bodyStart, close)
    cursor = close + pair.close.length
  }
  return { reasoning: reasoning.trim(), content: content.replace(/^\s+/, ''), inThinking }
}

/** Plain text of a message content value (string or typed parts). */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p
        if (p && typeof p === 'object') {
          const part = p as { type?: string; text?: unknown; content?: unknown }
          if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return typeof part.text === 'string' ? part.text : typeof part.content === 'string' ? part.content : ''
        }
        return ''
      })
      .join('')
  }
  return ''
}
