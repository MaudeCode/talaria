/** Synthetic notification transports shared by the Web Push, Relay and agent notice suites. */
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'
import type { PinnedInit } from '../http/pinned.js'
import type { TestServer } from './harness.js'

type Json = Record<string, unknown>
/** The address the stubbed push service resolves to. */
export const PUBLIC = '93.184.216.34'

/** A synthetic browser subscription whose private key stays in the test, so it can open every push. */
export function browserKeys(): { p256dh: string; auth: string; decrypt: (body: Buffer) => Json } {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = randomBytes(16)
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: auth.toString('base64url'),
    // RFC 8291 / RFC 8188 aes128gcm, one record.
    decrypt: (body) => {
      const salt = body.subarray(0, 16)
      const idlen = body[20]!
      const serverKey = body.subarray(21, 21 + idlen)
      const record = body.subarray(21 + idlen)
      const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), serverKey])
      const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(serverKey), auth, keyInfo, 32))
      const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
      const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
      decipher.setAuthTag(record.subarray(record.length - 16))
      const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()])
      const end = padded.lastIndexOf(2)
      return JSON.parse(padded.subarray(0, end).toString('utf8')) as Json
    },
  }
}

export interface Push { url: string; init: PinnedInit; addresses: string[] }

export function stubPushService(s: TestServer): { pushes: Push[]; statuses: number[] } {
  const pushes: Push[] = []
  const statuses: number[] = []
  s.deps.dnsLookup = (host) => Promise.resolve(host === 'push.example' ? [{ address: PUBLIC, family: 4 }] : host === 'private.example' ? [{ address: '10.0.0.5', family: 4 }] : [])
  s.deps.pinnedFetch = (url, init, addresses) => { pushes.push({ url, init, addresses }); return Promise.resolve(new Response(null, { status: statuses.shift() ?? 201 })) }
  return { pushes, statuses }
}

export interface Captured { method: string; url: string; body: Json; headers: Record<string, string> }
export interface FakeRelay { calls: Captured[]; snapshotStatus: number; viewedStatus: number; failOnly: string | null; snapshots: () => Captured[]; views: () => Captured[]; publicKey: Buffer | null; fetch: typeof fetch }

export function fakeRelay(): FakeRelay {
  const relay: FakeRelay = {
    calls: [], snapshotStatus: 200, viewedStatus: 200, failOnly: null, publicKey: null,
    snapshots: () => relay.calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/snapshot')),
    views: () => relay.calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/viewed')),
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Json
      const call = { method: init?.method ?? 'GET', url, body, headers }
      relay.calls.push(call)
      if (url.endsWith('/v1/pairings/publisher/redeem')) {
        relay.publicKey = Buffer.from(String(body.publicKey), 'base64url')
        return Promise.resolve(Response.json({ protocolVersion: 2, keyId: 'key-1', publisherId: body.publisherId, profileId: body.profileId, profileIdPreserved: false }))
      }
      if (url.endsWith('/v1/pairings/profile/redeem')) return Promise.resolve(Response.json({ protocolVersion: 2, publisherId: body.publisherId, profileId: body.profileId }))
      if (call.method === 'PUT' && url.endsWith('/viewed')) return Promise.resolve(new Response(relay.viewedStatus === 200 ? '{}' : 'nope', { status: relay.viewedStatus }))
      if (call.method === 'PUT') {
        const status = relay.failOnly && !url.includes(relay.failOnly) ? 200 : relay.snapshotStatus
        return Promise.resolve(new Response(status === 200 ? '{}' : 'nope', { status }))
      }
      return Promise.resolve(new Response('not found', { status: 404 }))
    },
  }
  return relay
}
