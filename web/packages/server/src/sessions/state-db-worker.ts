/**
 * The listing worker behind the `state-db.ts` `…Async` readers (TAL-920): runs
 * the synchronous `state.db` reads of the session list and the gateway watcher
 * off the server's event loop, one request at a time.
 */
import { parentPort } from 'node:worker_threads'
import type { StateDbWorkerReply, StateDbWorkerRequest } from './state-db.js'

// Source runs (vitest) start this file as TypeScript; map its `.js` imports back to the sources first.
if (import.meta.url.endsWith('.ts')) await import(new URL('../test/ts-worker-hooks.ts', import.meta.url).href)
const { agentSessionRowsExisting, cheapChangeFingerprint, readImportableAgentSessionRows, stateDbSessionSources, stateDbStorage, stateDbWebDiagnosticIds } = await import('./state-db.js')

parentPort?.on('message', (request: StateDbWorkerRequest) => {
  const reply: StateDbWorkerReply = { id: request.id, logs: [], failures: [] }
  // The test read delay holds every request here, standing in for a slow state.db.
  if (request.delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, request.delayMs)
  try {
    if (request.op === 'crash') process.exit(1)
    else if (request.op === 'rows') reply.value = readImportableAgentSessionRows(request.dbPath, { ...request.opts, log: (line) => { reply.logs.push(line) } })
    else if (request.op === 'fingerprint') reply.value = cheapChangeFingerprint(request.dbPath, (reason, error) => { reply.failures.push([reason, (error as Error).message]) })
    else if (request.op === 'storage') reply.value = stateDbStorage(request.dbPath)
    else if (request.op === 'webDiagnostic') reply.value = stateDbWebDiagnosticIds(request.dbPath)
    else if (request.op === 'sources') reply.value = stateDbSessionSources(request.dbPath, request.ids)
    else if (request.op === 'existing') reply.value = agentSessionRowsExisting(request.dbPath, request.ids)
  } catch (error) {
    reply.error = (error as Error).message
  }
  parentPort?.postMessage(reply)
})
