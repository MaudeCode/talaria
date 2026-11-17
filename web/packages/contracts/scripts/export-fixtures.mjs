// Exports one JSON Schema per sidecar method result to sidecar/tests/fixtures/schemas.json
// so the Python suite validates the real sidecar against the same contract the
// TypeScript server and fake sidecar are typed by. The `server.*` methods the sidecar
// calls go to server_schemas.json with both directions: what the sidecar sends, and
// what the server answers. TAL-2322: the Agent tool presentation table goes to the shared
// contracts/fixtures/tool-presentations.json, which the sidecar checks against the Agent's tool registry.
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { SIDECAR_METHODS, SIDECAR_SERVER_METHODS, TOOL_PRESENTATIONS } from '../dist/index.js'

const target = resolve(import.meta.dirname, '../../../sidecar/tests/fixtures/schemas.json')
const schemas = {}
for (const [name, method] of Object.entries(SIDECAR_METHODS)) {
  schemas[name] = z.toJSONSchema(method.result, { target: 'draft-2020-12', io: 'output' })
}
writeFileSync(target, JSON.stringify(schemas, null, 2) + '\n')
console.log(`export-fixtures: wrote ${Object.keys(schemas).length} result schemas to ${target}`)

const serverTarget = resolve(import.meta.dirname, '../../../sidecar/tests/fixtures/server_schemas.json')
const serverSchemas = {}
for (const [name, method] of Object.entries(SIDECAR_SERVER_METHODS)) {
  serverSchemas[name] = {
    params: z.toJSONSchema(method.params, { target: 'draft-2020-12', io: 'input' }),
    result: z.toJSONSchema(method.result, { target: 'draft-2020-12', io: 'output' }),
  }
}
writeFileSync(serverTarget, JSON.stringify(serverSchemas, null, 2) + '\n')
console.log(`export-fixtures: wrote ${Object.keys(serverSchemas).length} server method schemas to ${serverTarget}`)

const presentationsTarget = resolve(import.meta.dirname, '../../../../contracts/fixtures/tool-presentations.json')
writeFileSync(presentationsTarget, JSON.stringify(TOOL_PRESENTATIONS, null, 2) + '\n')
console.log(`export-fixtures: wrote ${Object.keys(TOOL_PRESENTATIONS).length} Agent tool presentations to ${presentationsTarget}`)
