import { describe, expect, it } from 'vitest'
import { generateOpenApiDocument } from './openapi.js'

describe('OpenAPI generation', () => {
  it('produces an OpenAPI 3.1 document with the contract paths', async () => {
    const document = await generateOpenApiDocument()
    expect(document.openapi).toBe('3.1.1')
    expect(document.info).toMatchObject({ title: 'Talaria Web API' })
    expect(document.paths).toHaveProperty('/api/update-notifications')
    expect(document.paths).toHaveProperty('/api/update-notifications/clear')
    expect(document.paths).toHaveProperty('/api/update-notifications/{id}/actions/{action_id}')
  })
})
