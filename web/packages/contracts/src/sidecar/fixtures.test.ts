import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SIDECAR_METHODS, type SidecarMethodName } from './methods.js'
import { SIDECAR_RPC_VERSION } from './version.js'

const fixtureDir = resolve(import.meta.dirname, '../../fixtures/sidecar')
interface Recorded { params: unknown; result: unknown; stream?: { event: string; data: unknown }[] }
const recorded: [SidecarMethodName, Recorded][] = []
for (const file of readdirSync(fixtureDir).filter((name) => name.endsWith('.json'))) {
  const byMethod = JSON.parse(readFileSync(resolve(fixtureDir, file), 'utf8')) as Record<string, Recorded[]>
  for (const [method, entries] of Object.entries(byMethod)) for (const entry of entries) recorded.push([method as SidecarMethodName, entry])
}

describe('sidecar method fixtures (recorded from the pinned Agent)', () => {
  it.each(recorded)('%s parses with its method schemas', (method, fixture) => {
    expect(SIDECAR_METHODS).toHaveProperty(method)
    const definition = SIDECAR_METHODS[method] as { params: { parse: (v: unknown) => unknown }; result: { parse: (v: unknown) => unknown }; stream?: { parse: (v: unknown) => unknown } }
    expect(definition.params.parse(fixture.params)).toBeTruthy()
    expect(definition.result.parse(fixture.result)).toBeTruthy()
    for (const frame of fixture.stream ?? []) {
      expect(definition.stream, `${method} streamed frames but declares no stream schema`).toBeDefined()
      expect(definition.stream!.parse(frame)).toBeTruthy()
    }
  })

  it('records every method that is not credential, network, or process bound', () => {
    const seen = new Set(recorded.map(([method]) => method))
    const unexercised = new Set(['rpc.cancel', 'rpc.methods', 'runtime.shutdown', 'goals.restore', 'commands.exec', 'kanban.dispatch', 'providers.resolve_runtime', 'oauth.start', 'oauth.poll', 'oauth.cancel', 'aux.complete', 'stt.transcribe', 'gateway.restart', 'mcp.reload', 'cron.run', 'worktree.create', 'chat.start', 'chat.interrupt', 'chat.steer', 'chat.steer_withdraw', 'chat.steer_now', 'chat.evict_agent', 'chat.commit_memory', 'chat.compress', 'chat.compress_finalize', 'approval.respond', 'approval.pending', 'approval.set_yolo', 'clarify.respond', 'config.set'])
    const missing = Object.keys(SIDECAR_METHODS).filter((m) => !seen.has(m as SidecarMethodName) && !unexercised.has(m))
    expect(missing).toEqual([])
  })

  it('pins the RPC version the Python package declares', () => {
    const init = readFileSync(resolve(import.meta.dirname, '../../../../sidecar/talaria_sidecar/__init__.py'), 'utf8')
    expect(init).toMatch(new RegExp(`^SIDECAR_RPC_VERSION = ${SIDECAR_RPC_VERSION}$`, 'm'))
  })
})
