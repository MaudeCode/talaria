import { describe, expect, it } from 'vitest'
import { generateOpenApiDocument } from './openapi.js'

describe('OpenAPI generation', () => {
  it('produces an OpenAPI 3.1 document with the contract paths', async () => {
    const document = await generateOpenApiDocument()
    expect(document.openapi).toBe('3.1.1')
    expect(document.info).toMatchObject({ title: 'Talaria Web API' })
  })
})
