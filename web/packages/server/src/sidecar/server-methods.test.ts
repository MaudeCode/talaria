import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RPC_ERROR_CODES, SIDECAR_SERVER_METHODS } from '@maudecode/talaria-web-contracts'
import { SidecarClient } from './client.js'
import { FakeSidecar } from './fake.js'
import { answerSidecarRequest, SidecarServerError } from './server-methods.js'
import { Session } from '../sessions/session.js'
import { bootTestServer } from '../test/harness.js'

const fixtures = resolve(import.meta.dirname, '../../../contracts/fixtures/sidecar')
const recorded = (JSON.parse(readFileSync(join(fixtures, 'server.json'), 'utf8')) as Record<string, { params: Record<string, unknown>; result: unknown }[]>)['server.session_list']![0]!

describe('sidecar-originated server requests (TAL-1164)', () => {
  let client: SidecarClient | null = null
  afterEach(async () => { await client?.close(); client = null })

  it('answers an allowlisted server.session_list on the asking sidecar and refuses an unknown server.* method', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'talaria-sidecar-server-'))
    const replies = join(dir, 'replies')
    // Handshakes, then asks the server twice and records every reply it reads on stdin.
    const script = `const fs=require('fs');const [fixture,params,replies]=process.argv.slice(1);require('readline').createInterface({input:process.stdin}).on('line',(line)=>{const msg=JSON.parse(line);if(msg.method==='runtime.handshake'){const result=JSON.parse(fs.readFileSync(fixture,'utf8'))['runtime.handshake'][0].result;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:'s:1',method:'server.session_list',params:JSON.parse(params)})+'\\n');process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:'s:2',method:'server.no_such_method',params:{}})+'\\n')}else if(typeof msg.id==='string'){fs.appendFileSync(replies,line+'\\n')}})`
    const seen: unknown[] = []
    client = new SidecarClient({ python: process.execPath, command: [process.execPath, '-e', script, join(fixtures, 'runtime.json'), JSON.stringify(recorded.params), replies], agentDir: '', sidecarDir: dir, hermesHome: dir, log: () => undefined })
    client.serveSidecarRequests({ 'server.session_list': (params) => { seen.push(params); return Promise.resolve(recorded.result as never) } })
    await client.start()
    const deadline = Date.now() + 5000
    let lines: Record<string, unknown>[] = []
    while (lines.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
      try { lines = readFileSync(replies, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) } catch { lines = [] }
    }
    const byId: Record<string, unknown> = Object.fromEntries(lines.map((line) => [String(line.id), line]))
    expect(seen).toEqual([SIDECAR_SERVER_METHODS['server.session_list'].params.parse(recorded.params)])
    expect(byId['s:1']).toEqual({ jsonrpc: '2.0', id: 's:1', result: recorded.result })
    expect(byId['s:2']).toMatchObject({ jsonrpc: '2.0', id: 's:2', error: { code: RPC_ERROR_CODES.methodNotFound, data: { condition: 'method_not_found' } } })
  })

  it('refuses invalid params, reports a handler refusal, and never dispatches a method without a handler', async () => {
    let calls = 0
    const handlers = { 'server.session_list': () => { calls += 1; return Promise.reject(new SidecarServerError('no Talaria session x', 'caller_unknown')) } }
    const ask = (method: string, params: Record<string, unknown>) => answerSidecarRequest(handlers, { jsonrpc: '2.0', id: 's:7', method, params })
    expect(await ask('server.session_list', { query: 'x' })).toMatchObject({ error: { code: RPC_ERROR_CODES.invalidParams } })
    expect(calls).toBe(0)
    expect(await ask('server.session_list', { caller_session_id: 'x' })).toMatchObject({ error: { code: RPC_ERROR_CODES.application, message: 'no Talaria session x', data: { condition: 'caller_unknown' } } })
    expect(await answerSidecarRequest({}, { jsonrpc: '2.0', id: 's:8', method: 'server.session_list', params: recorded.params })).toMatchObject({ error: { code: RPC_ERROR_CODES.methodNotFound } })
    expect(await ask('toString', {})).toMatchObject({ error: { code: RPC_ERROR_CODES.methodNotFound } })
    // Integer ids are the server's own requests' replies, never a sidecar request.
    expect(await answerSidecarRequest(handlers, { jsonrpc: '2.0', id: 3, method: 'server.session_list', params: {} })).toBeNull()
  })
})

describe('server.session_list (TAL-1164)', () => {
  it('lists only the calling session profile, newest first, with each row run state', async () => {
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({ sidecar })
    try {
      mkdirSync(join(s.state, 'profiles', 'other'), { recursive: true })
      const save = async (session_id: string, profile: string, title: string, updated_at: number) => {
        await s.deps.sessionStore.save(new Session({ session_id, title, profile, updated_at, last_message_at: updated_at, messages: [{ role: 'user', content: title, timestamp: updated_at }] }, { workspace: s.state, model: null }), { touchUpdatedAt: false })
      }
      await save('agentcaller', 'default', 'Coordinate the release', 1_792_500_000)
      await save('agentpeer', 'default', 'Refactor the importer', 1_792_500_300)
      await save('agentforeign', 'other', 'Other profile work', 1_792_500_600)
      await save('agentforeigncaller', 'other', 'Other profile caller', 1_792_500_100)
      s.deps.pending.submitApproval('agentpeer', { command: 'rm -rf build', description: 'delete build output' })

      const reply = await sidecar.serverRequest('server.session_list', { caller_session_id: 'agentcaller' })
      expect('result' in reply).toBe(true)
      const result = SIDECAR_SERVER_METHODS['server.session_list'].result.parse((reply as { result: unknown }).result)
      expect(result.truncated).toBe(false)
      expect(result.sessions.map((row) => row.session_id)).toEqual(['agentpeer', 'agentcaller'])
      expect(result.sessions[0]).toEqual({ session_id: 'agentpeer', title: 'Refactor the importer', updated_at: 1_792_500_300, is_caller: false, is_streaming: false, pending_steer_count: 0, attention: { kind: 'approval', count: 1, severity: 'critical' } })
      expect(result.sessions[1]).toMatchObject({ session_id: 'agentcaller', is_caller: true, attention: null })

      const filtered = await sidecar.serverRequest('server.session_list', { caller_session_id: 'agentcaller', query: 'IMPORTER' })
      expect((filtered as { result: { sessions: { session_id: string }[] } }).result.sessions.map((row) => row.session_id)).toEqual(['agentpeer'])

      const other = await sidecar.serverRequest('server.session_list', { caller_session_id: 'agentforeigncaller' })
      expect((other as { result: { sessions: { session_id: string }[] } }).result.sessions.map((row) => row.session_id)).toEqual(['agentforeign', 'agentforeigncaller'])

      expect(await sidecar.serverRequest('server.session_list', { caller_session_id: 'nosuchsession' })).toMatchObject({ error: { data: { condition: 'caller_unknown' } } })
    } finally {
      await s.close()
    }
  })
})
