import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { RevisionConflict } from './backend.js'
import { JsonDocuments } from './json-documents.js'
import { DraftStore } from '../drafts.js'
import { SettingsStore } from '../../settings.js'
import { gateFsync } from '../../test/fs-handles.js'

vi.mock('node:fs', async (original) => { const real = await original<typeof fs>(); return { ...real, writeSync: vi.fn(real.writeSync), fsyncSync: vi.fn(real.fsyncSync) } })
vi.mock('node:fs/promises', async (original) => { const real = await original<typeof fsp>(); return { ...real, open: vi.fn(real.open) } })

const ordinary = ((): number => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'talaria-create-mode-'))
  fs.writeFileSync(join(directory, 'probe'), '')
  const mode = fs.statSync(join(directory, 'probe')).mode & 0o777
  fs.rmSync(directory, { recursive: true })
  return mode
})()
const bytes = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value)
const namespaces = [
  { namespace: 'auth', key: 'sessions', file: '.sessions.json', first: { first: 1000 }, second: { second: 2000 }, external: { external: 3000 }, mode: 0o600 },
  { namespace: 'prompt-queues', key: 'chat', file: 'prompt-queues/chat.json', first: { first: 1000 }, second: { second: 2000 }, external: { external: 3000 }, mode: 0o600 },
  { namespace: 'drafts', key: 'chat', file: 'sessions/_drafts/chat.json', first: { text: 'first' }, second: { text: 'second' }, external: { text: 'external' }, mode: ordinary },
  { namespace: 'relay', key: 'revision', file: 'talaria-relay-revision', first: '1\n', second: '2\n', external: '3\n', mode: ordinary },
] as const

async function withDocuments(run: (documents: JsonDocuments, state: string, hold: () => ReturnType<typeof gateFsync>) => Promise<void>): Promise<void> {
  const state = fs.mkdtempSync(join(tmpdir(), 'talaria-json-documents-'))
  const documents = new JsonDocuments(state)
  const open = vi.mocked(fsp.open)
  const realOpen = open.getMockImplementation()!
  let release = () => { /* no pending fsync yet */ }
  const hold = () => { const gate = gateFsync(); release = gate.release; return gate }
  try { await run(documents, state, hold) }
  finally { release(); open.mockImplementation(realOpen); await documents.close(); vi.restoreAllMocks(); fs.rmSync(state, { recursive: true, force: true }) }
}

it.each(namespaces)('keeps $namespace fsync off the event loop, publishes its bytes and mode, and drains before close', async ({ namespace, key, file, first, second, mode }) => {
  await withDocuments(async (documents, state, hold) => {
    const path = join(state, file)
    const revision = await documents.put(namespace, key, first, null)
    vi.mocked(fs.writeSync).mockClear()
    vi.mocked(fs.fsyncSync).mockClear()
    const gate = hold()
    const pending = documents.put(namespace, key, second, revision)
    await Promise.race([gate.started, pending])
    await setImmediate()
    expect(fs.writeSync).not.toHaveBeenCalled()
    expect(fs.fsyncSync).not.toHaveBeenCalled()
    expect((await documents.get(namespace, key))?.value).toEqual(first)
    let closed = false
    const closing = documents.close().then(() => { closed = true })
    await setImmediate()
    expect(closed).toBe(false)
    gate.release()
    await pending
    await closing
    expect((await new JsonDocuments(state).get(namespace, key))?.value).toEqual(second)
    expect(fs.readFileSync(path, 'utf8')).toBe(bytes(second))
    expect(fs.statSync(path).mode & 0o777).toBe(mode)
    expect(fs.readdirSync(dirname(path))).toEqual([basename(path)])
    expect(fs.writeSync).not.toHaveBeenCalled()
    expect(fs.fsyncSync).not.toHaveBeenCalled()
  })
})

it.each(namespaces)('refuses a $namespace overwrite when the revision changes during async fsync', async ({ namespace, key, file, first, second, external }) => {
  await withDocuments(async (documents, state, hold) => {
    const path = join(state, file)
    const revision = await documents.put(namespace, key, first, null)
    const gate = hold()
    const pending = documents.put(namespace, key, second, revision)
    const refused = expect(pending).rejects.toBeInstanceOf(RevisionConflict)
    await Promise.race([gate.started, pending.catch(() => undefined)])
    fs.writeFileSync(path, bytes(external))
    gate.release()
    await refused
    expect((await documents.get(namespace, key))?.value).toEqual(external)
    expect(fs.readdirSync(dirname(path))).toEqual([basename(path)])
  })
})

it('lets a newer draft arriving during the previous save\'s fsync win instead of reporting a conflict', async () => {
  await withDocuments(async (documents, _state, hold) => {
    const drafts = new DraftStore(documents)
    const gate = hold()
    const older = drafts.write('chat', { text: 'older' }, '1')
    await Promise.race([gate.started, older])
    const newer = drafts.write('chat', { text: 'newer' }, '2')
    await setImmediate()
    gate.release()
    await older
    await expect(newer).resolves.toEqual({ text: 'newer', files: [] })
    expect(await drafts.readState('chat')).toEqual([{ text: 'newer', files: [] }, '2'])
  })
})

it('merges every settings patch arriving during another save\'s fsync', async () => {
  await withDocuments(async (documents, state, hold) => {
    const settings = new SettingsStore({ documents, env: {}, stateDir: state, defaultWorkspace: join(state, 'workspace'), botName: 'Hermes' })
    const gate = hold()
    const first = settings.save({ onboarding_completed: true })
    await Promise.race([gate.started, first])
    const others = [settings.save({ show_cli_sessions: false }), settings.save({ bot_name: 'Atlas' })]
    await setImmediate()
    gate.release()
    await Promise.all([first, ...others])
    expect(JSON.parse(fs.readFileSync(join(state, 'settings.json'), 'utf8'))).toMatchObject({ onboarding_completed: true, show_cli_sessions: false, bot_name: 'Atlas' })
  })
})
