import { describe, expect, it } from 'vitest'
import { classifyProviderError } from './turn.js'

describe('classifyProviderError quota phrases', () => {
  it.each([
    'This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 1234.',
    'Error code: 402 - requires more credits',
    'You can only afford 512 tokens',
    'Try fewer max_tokens',
    'Your credit balance is too low to access the API',
    'You exceeded your current quota, please check your plan',
    'usage_limit_exceeded',
    'You have reached the limit of messages for this period',
    'You have used up your usage for this window',
  ])('classifies %j as out of credits', (message) => {
    expect(classifyProviderError(message).type).toBe('quota_exhausted')
  })
})
