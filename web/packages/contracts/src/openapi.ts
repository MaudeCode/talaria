import { OpenAPIGenerator } from '@orpc/openapi'
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4'
import { routeContract } from './router.js'
import { RAW_ROUTES } from './routes/raw.js'

export const OPENAPI_INFO = {
  title: 'Talaria Web API',
  version: '1',
  description: 'HTTP and SSE contract of the Talaria Web server. Generated from @maudecode/talaria-web-contracts; do not edit by hand.',
} as const

/** Generate the OpenAPI 3.1 document for the route contract. */
export async function generateOpenApiDocument(): Promise<Record<string, unknown>> {
  const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] })
  const document = await generator.generate(routeContract, { info: OPENAPI_INFO })
  const paths = (document.paths ?? {}) as Record<string, Record<string, unknown>>
  for (const route of RAW_ROUTES) {
    const operation: Record<string, unknown> = {
      summary: route.summary,
      tags: route.tags,
      parameters: Object.entries(route.query ?? {}).map(([name, q]) => ({ name, in: 'query', required: q.required ?? false, description: q.description, schema: { type: 'string' } })),
      responses: Object.fromEntries(Object.entries(route.responses).map(([status, r]) => [status, {
        description: r.description,
        ...(r.contentType ? { content: Object.fromEntries([r.contentType].flat().map((type) => [type, {}])) } : {}),
        ...(r.headers ? { headers: Object.fromEntries(Object.entries(r.headers).map(([name, description]) => [name, { description, schema: { type: 'string' } }])) } : {}),
      }])),
    }
    if (route.requestBody) operation.requestBody = { required: true, description: route.requestBody.description, content: { [route.requestBody.contentType]: {} } }
    paths[route.path] = { ...(paths[route.path] ?? {}), [route.method.toLowerCase()]: operation }
  }
  document.paths = paths
  return document
}
