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

  it('documents raw routes with every media type and header they answer with', async () => {
    const paths = (await generateOpenApiDocument()).paths as Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown>; headers?: Record<string, unknown> }> }>>
    expect(Object.keys(paths['/api/sessions/gateway/stream']?.get?.responses['200']?.content ?? {})).toEqual(['text/event-stream', 'application/json'])
    const gone = paths['/api/process-complete-ack']?.post?.responses
    expect(Object.keys(gone ?? {})).toEqual(['410'])
    expect(gone?.['410']?.headers).toHaveProperty('X-Replaced-By')
  })
})
