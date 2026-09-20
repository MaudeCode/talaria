import { OpenAPIGenerator } from '@orpc/openapi'
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4'
import { routeContract } from './router.js'

export const OPENAPI_INFO = {
  title: 'Talaria Web API',
  version: '1',
  description: 'HTTP and SSE contract of the Talaria Web server. Generated from @maudecode/talaria-web-contracts; do not edit by hand.',
} as const

/** Generate the OpenAPI 3.1 document for the route contract. */
export async function generateOpenApiDocument(): Promise<Record<string, unknown>> {
  const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] })
  const document = await generator.generate(routeContract, { info: OPENAPI_INFO })
  return document
}
