/* eslint-disable @typescript-eslint/require-await -- Each JSON transaction completes synchronously before its promise resolves. */
import { normalizeDraftVersion } from '../drafts.js'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { writeAtomic } from './json-files.js'
import { atomicWriteText, atomicWriteTextAsync } from '../../fs/atomic.js'
import { fileStatKey } from '../../fs/stat.js'
import { InvalidDocument, RevisionConflict, type DocumentBackend, type StoredDocument } from './backend.js'

interface Format { directory?: string; files?: Record<string, string>; indent?: number; sorted?: boolean; secret?: boolean; text?: boolean; newline?: boolean }
const formats: Record<string, Format> = {
  feedback: { directory: 'feedback', secret: true },
  drafts: { directory: 'sessions/_drafts' },
  shares: { directory: 'shares', indent: 2, secret: true },
  'held-wakeups': { files: { held: 'sessions/_wakeup_held.json' } },
  projects: { files: { projects: 'projects.json' }, indent: 2 },
  settings: { files: { settings: 'settings.json' }, indent: 2 },
  auth: { files: { sessions: '.sessions.json', 'login-attempts': '.login_attempts.json', 'pbkdf2-key': '.pbkdf2_key', 'signing-key': '.signing_key' }, secret: true },
  passkeys: { files: { passkeys: 'passkeys.json', '.passkey_challenges': '.passkey_challenges.json' }, indent: 2, sorted: true, secret: true },
  'update-notifications': { files: { 'update-notifications': 'update-notifications.json' }, secret: true },
  profiles: { files: { deleted: 'deleted-profiles.json' } },
  extensions: { files: { overrides: 'extension-overrides.json', 'install-manifest': 'extension-install-manifest.json' }, indent: 2 },
  background: { directory: 'sessions/_background' },
  'prompt-queues': { directory: 'prompt-queues', secret: true },
  'connector-offers': { directory: 'connector-offers', secret: true },
  catalog: { files: { 'quota-scope': '.quota_scope_id' }, text: true },
  'relay-keys': { text: true, secret: true },
  'relay-identities': { text: true, secret: true },
  recovery: { files: { 'stamping-since': 'recovery_stamping_since' }, text: true },
  'web-push': { files: { vapid: 'web-push-vapid.json' }, secret: true },
  'web-push-subscriptions': { files: { subscriptions: 'web-push-subscriptions.json' }, secret: true },
}
const sortedReplacer = (_key: string, value: unknown): unknown => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, (value as Record<string, unknown>)[key]])) : value

const documentWrites = new Map<string, Promise<unknown>>()

// Like AgentConfig's snapshot, but JSON parsing stays lazy so byte limits run first.
interface CachedDocument { signature: string; text: string; revision: string; parsed?: { value: unknown } }

export class JsonDocuments implements DocumentBackend {
  closed = false
  constructor(private readonly stateDir: string, private readonly profileHome: (profile: string) => string = (profile) => profile === 'default' ? stateDir : join(stateDir, 'profiles', profile), private readonly sessionDirectory: string = join(stateDir, 'sessions')) {}
  private readonly pending = new Set<Promise<unknown>>()
  private readonly cache = new Map<string, CachedDocument>()

  private serialize<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const result = (documentWrites.get(path) ?? Promise.resolve()).catch(() => undefined).then(operation)
    const settled = result.then(() => { /* released below */ }, () => { /* next write may retry */ })
    documentWrites.set(path, settled)
    this.pending.add(result)
    void settled.then(() => { this.pending.delete(result); if (documentWrites.get(path) === settled) documentWrites.delete(path) })
    return result
  }

  async close(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending])
    this.closed = true
    this.cache.clear()
  }

  private format(namespace: string, key?: string): Format {
    if (this.closed) throw new Error('Storage is closed')
    if (namespace === 'workspaces') return key?.endsWith('.last') ? { text: true } : { indent: 2 }
    if (namespace === 'relay') return key === 'revision' ? { text: true } : { files: { config: 'talaria-relay.json', started: 'talaria-relay-started.json', deleted: 'talaria-relay-deleted.json' }, ...(key === 'config' ? { indent: 2 } : {}), newline: true, secret: key === 'deleted' }
    const format = Object.hasOwn(formats, namespace) ? formats[namespace] : undefined
    if (!format) throw new Error(`Unknown document namespace ${namespace}`)
    return format
  }
  private path(namespace: string, key: string): string {
    const format = this.format(namespace, key)
    if ((!Object.hasOwn(format.files ?? {}, key) && !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(key)) || key === '.' || key === '..') throw new Error('Unsafe document key')
    if (namespace === 'drafts' || namespace === 'background') return join(this.sessionDirectory, namespace === 'drafts' ? '_drafts' : '_background', `${key}.json`)
    if (namespace === 'held-wakeups' && key === 'held') return join(this.sessionDirectory, '_wakeup_held.json')
    if (namespace === 'workspaces') {
      const match = /^([a-z0-9][a-z0-9_-]{0,63})\.(registry|last)$/.exec(key)
      if (!match) throw new Error('Unsafe workspace document key')
      const directory = match[1] === 'default' ? this.stateDir : join(this.profileHome(match[1]!), 'webui_state')
      return join(directory, match[2] === 'registry' ? 'workspaces.json' : 'last_workspace.txt')
    }
    if (namespace === 'relay-identities') {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key)) throw new Error('Unsafe profile identity key')
      return join(this.profileHome(key), '.talaria-relay-profile-id')
    }
    if (namespace === 'relay-keys') {
      if (!/^[a-f0-9]{16}$/.test(key)) throw new Error('Unsafe relay key')
      return join(this.stateDir, `talaria-relay-publisher-${key}.pem`)
    }
    if (namespace === 'relay' && (key === 'revision' || key === 'started')) {
      let directory = this.stateDir
      try { const config = JSON.parse(readFileSync(join(this.stateDir, 'talaria-relay.json'), 'utf8')) as Record<string, unknown>; if (typeof config.private_key_path === 'string' && config.private_key_path) directory = dirname(config.private_key_path) } catch { /* unconfigured */ }
      return join(directory, key === 'revision' ? 'talaria-relay-revision' : 'talaria-relay-started.json')
    }
    const path = format.files?.[key] ?? (format.directory ? `${format.directory}/${key}.json` : null)
    if (!path) throw new Error(`Unknown document key ${namespace}/${key}`)
    return join(this.stateDir, path)
  }
  private remember(namespace: string, path: string, text: string, signature: string): CachedDocument {
    const entry: CachedDocument = { text, signature, revision: createHash('sha256').update(text).digest('hex') }
    if (namespace === 'drafts') {
      try {
        const value = JSON.parse(text) as unknown
        entry.parsed = { value }
        const version = normalizeDraftVersion((value as Record<string, unknown> | null)?._draft_version)
        if (version !== null) entry.revision = version
      } catch { /* hash malformed bytes */ }
    }
    this.cache.delete(path)
    this.cache.set(path, entry)
    if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!)
    return entry
  }
  private raw(namespace: string, key: string): CachedDocument | null {
    const path = this.path(namespace, key)
    try {
      const signature = fileStatKey(path)
      const hit = this.cache.get(path)
      if (hit?.signature === signature) {
        this.cache.delete(path)
        this.cache.set(path, hit)
        return hit
      }
      // Bind bytes to the pre-read identity, never to a replacement arriving during the read.
      const text = readFileSync(path, namespace === 'auth' && key.endsWith('-key') ? 'latin1' : 'utf8')
      return this.remember(namespace, path, text, signature)
    } catch (error) {
      this.cache.delete(path)
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  async get(namespace: string, key: string, opts: { maxBytes?: number } = {}): Promise<StoredDocument | null> {
    const raw = this.raw(namespace, key)
    if (!raw) return null
    if (opts.maxBytes !== undefined && Buffer.byteLength(raw.text) > opts.maxBytes) throw new InvalidDocument(raw.revision, new Error('Document byte limit exceeded'), 'too-large')
    try {
      raw.parsed ??= { value: namespace === 'auth' && key.endsWith('-key') ? Buffer.from(raw.text, 'latin1').toString('base64') : this.format(namespace, key).text ? raw.text : JSON.parse(raw.text) as unknown }
      const value = structuredClone(raw.parsed.value)
      if (namespace === 'relay' && key === 'config' && value && typeof value === 'object') {
        const config = value as Record<string, unknown>
        if (typeof config.private_key_path === 'string') {
          const name = relative(this.stateDir, config.private_key_path)
          const match = /^talaria-relay-publisher-([a-f0-9]{16})\.pem$/.exec(name)
          if (match) config.private_key_document = match[1]
        }
      }
      return { value, revision: raw.revision }
    }
    catch (error) { throw new InvalidDocument(raw.revision, error) }
  }
  async put(namespace: string, key: string, value: unknown, expected: string | null): Promise<string> {
    const path = this.path(namespace, key)
    if ((this.raw(namespace, key)?.revision ?? null) !== expected) throw new RevisionConflict(`${namespace}/${key}`)
    const format = this.format(namespace, key)
    if (namespace === 'relay' && key === 'config' && value && typeof value === 'object') {
      const config = { ...value } as Record<string, unknown>
      if (typeof config.private_key_document === 'string') config.private_key_path = this.path('relay-keys', config.private_key_document)
      delete config.private_key_document
      value = config
    }
    const serialized = format.text ? String(value) : JSON.stringify(value, format.sorted ? sortedReplacer : undefined, format.indent)
    if (serialized === undefined) throw new Error('Document must be serializable')
    const text = serialized + (format.newline ? '\n' : '')
    const binary = namespace === 'auth' && key.endsWith('-key') ? Buffer.from(String(value), 'base64') : null
    const storedText = binary ? binary.toString('latin1') : text
    let revision!: string
    const publish = (staged: string, target: string): void => {
      // Hold the written inode across rename; a later path lookup could describe an external replacement.
      const fd = openSync(staged, 'r')
      try {
        const before = fstatSync(fd, { bigint: true })
        renameSync(staged, target)
        if (format.secret && format.sorted) { try { chmodSync(target, 0o600) } catch { /* legacy best effort */ } }
        const after = fstatSync(fd, { bigint: true })
        // An in-place edit during publication must also miss the next cache lookup.
        const identity = before.mtimeNs === after.mtimeNs && before.size === after.size ? after : before
        revision = this.remember(namespace, path, storedText, fileStatKey(path, identity)).revision
      } finally { closeSync(fd) }
    }
    if (namespace !== 'relay-identities') mkdirSync(dirname(path), { recursive: true })
    if (binary) writeAtomic(path, binary, 0o600, publish)
    else if (namespace === 'auth') {
      return this.serialize(path, async () => {
        // Stage and fsync off the event loop; compare and publish together without another asynchronous gap.
        const assertCurrent = (): void => { if ((this.raw(namespace, key)?.revision ?? null) !== expected) throw new RevisionConflict(`${namespace}/${key}`) }
        assertCurrent()
        await atomicWriteTextAsync(path, text, { mode: 0o600, commit: (staged, target) => {
          assertCurrent()
          publish(staged, target)
        } })
        return revision
      })
    } else atomicWriteText(path, text, { ...(format.secret ? { mode: 0o600 } : {}), commit: publish })
    return revision
  }
  async delete(namespace: string, key: string, expected?: string | null): Promise<boolean> {
    const path = this.path(namespace, key)
    return this.serialize(path, () => {
      const current = this.raw(namespace, key)
      if (expected !== undefined && (current?.revision ?? null) !== expected) throw new RevisionConflict(`${namespace}/${key}`)
      if (!current) return Promise.resolve(false)
      unlinkSync(path)
      this.cache.delete(path)
      return Promise.resolve(true)
    })
  }
  async list(namespace: string): Promise<{ key: string; revision: string }[]> {
    const format = this.format(namespace)
    let keys = Object.keys(format.files ?? {})
    if (namespace === 'relay') keys = ['config', 'deleted', 'started', 'revision']
    if (namespace === 'workspaces' || namespace === 'relay-identities') {
      const profiles = ['default']
      try { profiles.push(...readdirSync(join(this.profileHome('default'), 'profiles')).filter((name) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name))) } catch { /* no named profiles */ }
      keys = namespace === 'workspaces' ? profiles.flatMap((profile) => [`${profile}.registry`, `${profile}.last`]) : profiles
    }
    if (namespace === 'relay-keys') {
      try { keys = readdirSync(this.stateDir).flatMap((name) => { const match = /^talaria-relay-publisher-([a-f0-9]{16})\.pem$/.exec(name); return match ? [match[1]!] : [] }) } catch { /* no keys */ }
    }
    if (format.directory) {
      try { keys = readdirSync(namespace === 'drafts' || namespace === 'background' ? join(this.sessionDirectory, namespace === 'drafts' ? '_drafts' : '_background') : join(this.stateDir, format.directory)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    return keys.sort().flatMap((key) => { const raw = this.raw(namespace, key); return raw ? [{ key, revision: raw.revision }] : [] })
  }
}
