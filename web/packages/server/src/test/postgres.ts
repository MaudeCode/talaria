/**
 * Embedded Postgres for tests (TAL-1067): PGlite with `pg_trgm`, served over the real wire protocol on a free local
 * port, so the Postgres adapter runs through `pg` exactly as in production. No Docker, no live database.
 */
import { randomBytes } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { PGLiteSocketHandler } from '@electric-sql/pglite-socket'
import pg from 'pg'

export interface TestPostgres { url: string; stop: () => Promise<void> }

/** The synthetic password the test server's URLs carry; PGlite accepts any. */
export const TEST_POSTGRES_PASSWORD = 'synthetic-pglite-secret'

/** Extended-query messages that belong to the statement a later Sync completes: Parse, Bind, Describe, Execute, Close, Flush. */
const EXTENDED = new Set([0x50, 0x42, 0x44, 0x45, 0x43, 0x48])
interface Pending { handlerId: number; message: Uint8Array; onData: (data: Uint8Array) => void; resolve: (bytes: number) => void; reject: (error: unknown) => void }

/**
 * PGlite is one backend session shared by every connection, so each connection keeps it from its first extended-query
 * message to the Sync that ends the statement, and for the whole of an open transaction. pglite-socket's own queue
 * only does the latter, which lets another connection's Parse replace the unnamed statement a Bind is about to use.
 */
class SessionQueue {
  private readonly queue: Pending[] = []
  private processing = false
  private owner: number | null = null
  constructor(private readonly db: PGlite) {}
  enqueue(handlerId: number, message: Uint8Array, onData: (data: Uint8Array) => void): Promise<number> {
    return new Promise((resolve, reject) => { this.queue.push({ handlerId, message, onData, resolve, reject }); void this.process() })
  }
  private async process(): Promise<void> {
    if (this.processing) return
    this.processing = true
    try {
      for (;;) {
        const at = this.owner === null ? (this.queue.length ? 0 : -1) : this.queue.findIndex((item) => item.handlerId === this.owner)
        if (at < 0) return
        const [item] = this.queue.splice(at, 1) as [Pending]
        let bytes = 0
        try {
          await this.db.runExclusive(async () => { await this.db.execProtocolRawStream(item.message, { onRawData: (data) => { bytes += data.length; item.onData(data) } }) })
        } catch (error) { this.owner = null; item.reject(error); continue }
        this.owner = EXTENDED.has(item.message[0] ?? 0) || this.db.isInTransaction() ? item.handlerId : null
        item.resolve(bytes)
      }
    } finally { this.processing = false }
  }
  getQueueLength(): number { return this.queue.length }
  clearQueueForHandler(handlerId: number): void {
    for (let at = this.queue.length - 1; at >= 0; at--) if (this.queue[at]!.handlerId === handlerId) this.queue.splice(at, 1)[0]!.reject(new Error('Handler disconnected'))
  }
  async clearTransactionIfNeeded(handlerId: number): Promise<void> {
    if (this.owner !== handlerId) return
    if (this.db.isInTransaction()) await this.db.exec('ROLLBACK')
    this.owner = null
    void this.process()
  }
}

export async function startTestPostgres(): Promise<TestPostgres> {
  const db = await PGlite.create({ extensions: { pg_trgm } })
  const queue = new SessionQueue(db)
  const handlers = new Set<PGLiteSocketHandler>()
  const server = createServer((socket: Socket) => {
    const handler = new PGLiteSocketHandler({ queryQueue: queue as never, closeOnDetach: true })
    handlers.add(handler)
    socket.once('close', () => { handlers.delete(handler) })
    void handler.attach(socket)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { resolve() }) })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `postgres://talaria:${TEST_POSTGRES_PASSWORD}@127.0.0.1:${String(port)}/postgres?sslmode=disable`,
    stop: async () => {
      for (const handler of handlers) await handler.detach(true)
      await new Promise((resolve) => server.close(resolve))
      await db.close()
    },
  }
}

/** A schema no other test uses. */
export const testSchema = (): string => `t_${randomBytes(8).toString('hex')}`

export async function dropTestSchema(url: string, schema: string): Promise<void> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } finally { await client.end() }
}
