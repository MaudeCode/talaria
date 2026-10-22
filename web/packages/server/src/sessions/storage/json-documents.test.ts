import * as fs from 'node:fs'
import * as crypto from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { JsonDocuments } from './json-documents.js'
import { InvalidDocument, RevisionConflict } from './backend.js'

vi.mock('node:fs', async (original) => {
  const real = await original<typeof fs>()
  return { ...real, readFileSync: vi.fn(real.readFileSync), statSync: vi.fn(real.statSync), renameSync: vi.fn(real.renameSync) }
})
vi.mock('node:crypto', async (original) => {
  const real = await original<typeof crypto>()
  return { ...real, createHash: vi.fn(real.createHash) }
})

let state: string
let documents: JsonDocuments
beforeEach(() => {
  state = fs.mkdtempSync(join(tmpdir(), 'talaria-document-cache-'))
  documents = new JsonDocuments(state)
  vi.clearAllMocks()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await documents.close()
  fs.rmSync(state, { recursive: true, force: true })
})

it('reads, hashes and parses unchanged documents once, with one stat per warm get', async () => {
  fs.writeFileSync(join(state, 'settings.json'), '{"nested":{"value":1}}')
  const parse = vi.spyOn(JSON, 'parse')
  const first = await documents.get('settings', 'settings')
  const second = await documents.get('settings', 'settings')
  expect(fs.readFileSync).toHaveBeenCalledTimes(1)
  expect(crypto.createHash).toHaveBeenCalledTimes(1)
  expect(parse).toHaveBeenCalledTimes(1)
  expect(fs.statSync).toHaveBeenCalledTimes(2)
  expect(second).toEqual(first)
  ;(first!.value as { nested: { value: number } }).nested.value = 99
  expect((await documents.get('settings', 'settings'))?.value).toEqual({ nested: { value: 1 } })
})

it.each(['settings', 'auth'] as const)('seeds the %s cache from published bytes without rereading', async (namespace) => {
  const key = namespace === 'auth' ? 'sessions' : 'settings'
  const input = { nested: { value: 1 } }
  const revision = await documents.put(namespace, key, input, null)
  input.nested.value = 99
  expect((await documents.get(namespace, key))).toEqual({ value: { nested: { value: 1 } }, revision })
  expect(fs.readFileSync).not.toHaveBeenCalled()
})

it('reloads external edits and replacements, rejects stale writes, and notices removal', async () => {
  const path = join(state, 'settings.json')
  fs.writeFileSync(path, '{"value":1}')
  const first = (await documents.get('settings', 'settings'))!
  fs.writeFileSync(path, '{"value":2}')
  fs.utimesSync(path, 2_000_000_000, 2_000_000_000)
  const second = (await documents.get('settings', 'settings'))!
  expect(second.value).toEqual({ value: 2 })
  expect(second.revision).not.toBe(first.revision)
  await expect(documents.put('settings', 'settings', {}, first.revision)).rejects.toBeInstanceOf(RevisionConflict)
  fs.writeFileSync(join(state, 'replacement'), '{"value":3}')
  fs.renameSync(join(state, 'replacement'), path)
  expect((await documents.get('settings', 'settings'))?.value).toEqual({ value: 3 })
  fs.unlinkSync(path)
  expect(await documents.get('settings', 'settings')).toBeNull()
  fs.writeFileSync(path, '{"value":4}')
  expect((await documents.get('settings', 'settings'))?.value).toEqual({ value: 4 })
})

it('enforces byte limits on cached bytes and never serves a cached parse for invalid external data', async () => {
  const path = join(state, 'settings.json')
  fs.writeFileSync(path, '  {"value":1}')
  await documents.get('settings', 'settings')
  await expect(documents.get('settings', 'settings', { maxBytes: 4 })).rejects.toMatchObject({ reason: 'too-large' })
  fs.writeFileSync(path, '{broken')
  await expect(documents.get('settings', 'settings')).rejects.toBeInstanceOf(InvalidDocument)
  fs.writeFileSync(path, 'null')
  expect((await documents.get('settings', 'settings'))?.value).toBeNull()
})

it('keeps workspace text, binary auth keys, and draft revisions intact', async () => {
  await documents.put('workspaces', 'default.last', '/workspace', null)
  expect((await documents.get('workspaces', 'default.last'))?.value).toBe('/workspace')
  const encoded = Buffer.from([0, 128, 255]).toString('base64')
  await documents.put('auth', 'signing-key', encoded, null)
  expect((await documents.get('auth', 'signing-key'))?.value).toBe(encoded)
  const revision = await documents.put('drafts', 'chat', { _draft_version: '123' }, null)
  expect(revision).toBe('123')
  expect((await documents.get('drafts', 'chat'))?.revision).toBe('123')
  await documents.delete('drafts', 'chat', revision)
  expect(await documents.get('drafts', 'chat')).toBeNull()
})

it('propagates stat failures instead of returning cached data', async () => {
  await documents.put('settings', 'settings', { value: 1 }, null)
  vi.mocked(fs.statSync).mockImplementationOnce(() => { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }) })
  await expect(documents.get('settings', 'settings')).rejects.toMatchObject({ code: 'EACCES' })
  expect((await documents.get('settings', 'settings'))?.value).toEqual({ value: 1 })
  expect(fs.readFileSync).toHaveBeenCalledTimes(1)
})

it('does not cache old bytes under a replacement that arrives during a read', async () => {
  const path = join(state, 'settings.json')
  fs.writeFileSync(path, '{"value":1}')
  const read = vi.mocked(fs.readFileSync).getMockImplementation()!
  vi.mocked(fs.readFileSync).mockImplementationOnce((...args) => {
    const text = read(...args)
    fs.writeFileSync(join(state, 'replacement'), '{"value":2}')
    fs.renameSync(join(state, 'replacement'), path)
    return text
  })
  expect((await documents.get('settings', 'settings'))?.value).toEqual({ value: 1 })
  expect((await documents.get('settings', 'settings'))?.value).toEqual({ value: 2 })
})

it('does not seed auth bytes under an external edit arriving after publication', async () => {
  const rename = vi.mocked(fs.renameSync).getMockImplementation()!
  vi.mocked(fs.renameSync).mockImplementationOnce((...args) => {
    rename(...args)
    queueMicrotask(() => { fs.writeFileSync(join(state, '.sessions.json'), '{"external":true}') })
  })
  await documents.put('auth', 'sessions', { ours: true }, null)
  expect((await documents.get('auth', 'sessions'))?.value).toEqual({ external: true })
})

it.each([
  ['settings', 'settings', 'settings.json'],
  ['auth', 'sessions', '.sessions.json'],
  ['auth', 'signing-key', '.signing_key'],
] as const)('binds %s/%s seeded bytes to the published inode', async (namespace, key, filename) => {
  const binary = key === 'signing-key'
  const rename = vi.mocked(fs.renameSync).getMockImplementation()!
  vi.mocked(fs.renameSync).mockImplementationOnce((...args) => {
    rename(...args)
    const replacement = join(state, 'replacement')
    fs.writeFileSync(replacement, binary ? 'external' : '{"external":true}')
    rename(replacement, join(state, filename))
  })
  await documents.put(namespace, key, binary ? Buffer.from('ours').toString('base64') : { ours: true }, null)
  expect((await documents.get(namespace, key))?.value).toEqual(binary ? Buffer.from('external').toString('base64') : { external: true })
})

it('invalidates seeded bytes when the published inode is edited in place', async () => {
  const rename = vi.mocked(fs.renameSync).getMockImplementation()!
  vi.mocked(fs.renameSync).mockImplementationOnce((...args) => {
    rename(...args)
    fs.writeFileSync(join(state, 'settings.json'), '{"external":true}')
  })
  await documents.put('settings', 'settings', { ours: true }, null)
  expect((await documents.get('settings', 'settings'))?.value).toEqual({ external: true })
})

it('bounds resident snapshots and releases them on close', async () => {
  fs.mkdirSync(join(state, 'sessions', '_drafts'), { recursive: true })
  for (let index = 0; index <= 256; index += 1) {
    fs.writeFileSync(join(state, 'sessions', '_drafts', `${index}.json`), '{}')
    await documents.get('drafts', String(index))
  }
  vi.clearAllMocks()
  await documents.get('drafts', '256')
  expect(fs.readFileSync).not.toHaveBeenCalled()
  await documents.get('drafts', '0')
  expect(fs.readFileSync).toHaveBeenCalledTimes(1)
  await documents.close()
  await expect(documents.get('drafts', '0')).rejects.toThrow('Storage is closed')
})
