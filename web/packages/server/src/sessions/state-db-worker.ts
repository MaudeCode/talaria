/**
 * The worker behind each lane of the `state-db.ts` `…Async` readers (TAL-1189): runs
 * the synchronous `state.db` reads of the session list, the gateway watcher, the
 * single-session lookups (TAL-923), and the transcript reads (TAL-1162) off the
 * server's event loop, one request at a time per lane.
 */
import { parentPort } from 'node:worker_threads'
import type { StateDbWorkerReply, StateDbWorkerRequest } from './state-db.js'

// Source runs (vitest) start this file as TypeScript; map its `.js` imports back to the sources first.
if (import.meta.url.endsWith('.ts')) await import(new URL('../test/ts-worker-hooks.ts', import.meta.url).href)
const { SESSION_READS, agentSessionRowsExisting, cheapChangeFingerprint, readImportableAgentSessionRowBatches, readImportableAgentSessionRows, stateDbSessionSources, stateDbStorage, stateDbWebDiagnosticIds } = await import('./state-db.js')

parentPort?.on('message', (request: StateDbWorkerRequest) => {
  if (request.op === 'stop') process.exit(0)
  const started = process.hrtime.bigint()
  const reply: StateDbWorkerReply = { id: request.id, logs: [], failures: [] }
  if (request.testBarrier) {
    const barrier = new Int32Array(request.testBarrier)
    Atomics.store(barrier, 0, 1)
    Atomics.notify(barrier, 0)
    Atomics.wait(barrier, 1, 0)
  }
  // The test read delay holds every request here, standing in for a slow state.db.
  if (request.delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, request.delayMs)
  try {
    if (request.op === 'crash') process.exit(1)
    else if (request.op === 'rowBatches') reply.value = readImportableAgentSessionRowBatches(request.dbPath, request.queries.map((opts) => ({ ...opts, log: (line) => { reply.logs.push(line) } })))
    else if (request.op === 'rows') reply.value = readImportableAgentSessionRows(request.dbPath, { ...request.opts, log: (line) => { reply.logs.push(line) } })
    else if (request.op === 'fingerprint') reply.value = cheapChangeFingerprint(request.dbPath, (reason, error) => { reply.failures.push([reason, (error as Error).message]) })
    else if (request.op === 'storage') reply.value = stateDbStorage(request.dbPath)
    else if (request.op === 'webDiagnostic') reply.value = stateDbWebDiagnosticIds(request.dbPath)
    else if (request.op === 'sources') reply.value = stateDbSessionSources(request.dbPath, request.ids)
    else if (request.op === 'existing') reply.value = agentSessionRowsExisting(request.dbPath, request.ids)
    else if (request.op === 'session') reply.value = (SESSION_READS[request.read] as (...args: unknown[]) => unknown)(...request.args)
  } catch (error) {
    reply.error = (error as Error).message
  }
  reply.timing = { queue_wait_ms: Math.max(0, Number(started - (request.queuedAtNs ?? started)) / 1e6), execution_ms: Number(process.hrtime.bigint() - started) / 1e6 }
  parentPort?.postMessage(reply)
})
