// Exports one JSON Schema per sidecar method result to sidecar/tests/fixtures/schemas.json
// so the Python suite validates the real sidecar against the same contract the
// TypeScript server and fake sidecar are typed by.
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { SIDECAR_METHODS } from '../dist/index.js'

const target = resolve(import.meta.dirname, '../../../sidecar/tests/fixtures/schemas.json')
const schemas = {}
for (const [name, method] of Object.entries(SIDECAR_METHODS)) {
  schemas[name] = z.toJSONSchema(method.result, { target: 'draft-2020-12', io: 'output' })
}
writeFileSync(target, JSON.stringify(schemas, null, 2) + '\n')
console.log(`export-fixtures: wrote ${Object.keys(schemas).length} result schemas to ${target}`)
