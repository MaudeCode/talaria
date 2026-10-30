// Writes the OpenAPI 3.1 document generated from the route contract to
// <repo>/contracts/web-api.openapi.json, and the What's New announcement schema the
// release-note generator and App decode against to <repo>/contracts/whats-new.schema.json.
// CI regenerates both and fails on a diff.
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { generateOpenApiDocument, WhatsNewAnnouncementSchema } from '../dist/index.js'

const root = resolve(import.meta.dirname, '../../../../contracts')
const outputs = {
  'web-api.openapi.json': await generateOpenApiDocument(),
  'whats-new.schema.json': z.toJSONSchema(WhatsNewAnnouncementSchema, { target: 'draft-2020-12', io: 'output' }),
}
for (const [name, document] of Object.entries(outputs)) {
  writeFileSync(resolve(root, name), JSON.stringify(document, null, 2) + '\n')
  console.log(`generate-openapi: wrote ${resolve(root, name)}`)
}
