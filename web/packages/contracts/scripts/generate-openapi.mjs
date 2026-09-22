// Writes the OpenAPI 3.1 document generated from the route contract to
// <repo>/contracts/web-api.openapi.json. CI regenerates it and fails on a diff.
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { generateOpenApiDocument } from '../dist/index.js'

const target = resolve(import.meta.dirname, '../../../../contracts/web-api.openapi.json')
const document = await generateOpenApiDocument()
writeFileSync(target, JSON.stringify(document, null, 2) + '\n')
console.log(`generate-openapi: wrote ${target}`)
