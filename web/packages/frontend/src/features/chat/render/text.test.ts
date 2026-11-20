import { describe, expect, it } from 'vitest'
import { extractInlineThinking, stripToolCallXml } from './text'

describe('stripToolCallXml', () => {
  it('removes complete and truncated function_calls blocks', () => {
    expect(stripToolCallXml('Hi <function_calls><invoke name="x"/></function_calls> there')).toBe('Hi  there')
    expect(stripToolCallXml('Prose\n<function_calls><invoke')).toBe('Prose\n')
    expect(stripToolCallXml('<tool_call>{"a":1}</tool_call>after')).toBe('after')
  })
  it('leaves ordinary text untouched', () => {
    expect(stripToolCallXml('plain **md** <b>x</b>')).toBe('plain **md** <b>x</b>')
  })
})

describe('extractInlineThinking', () => {
  it('splits closed think blocks out of content', () => {
    expect(extractInlineThinking('<think>plan</think>Answer')).toEqual({ reasoning: 'plan', content: 'Answer', inThinking: false })
  })
  it('treats an open block as in-progress thinking while streaming', () => {
    expect(extractInlineThinking('<think>still', true)).toEqual({ reasoning: 'still', content: '', inThinking: true })
    expect(extractInlineThinking('<think>still', false).inThinking).toBe(false)
  })
  it('supports channel and turn markers', () => {
    expect(extractInlineThinking('<|channel|>thought\nhmm<channel|>Yes')).toEqual({ reasoning: 'hmm', content: 'Yes', inThinking: false })
  })
})
