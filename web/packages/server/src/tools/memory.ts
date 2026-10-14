/** Memory panel files and saved prompts (Python `_handle_memory_read`, `_handle_memory_write`, saved prompts helpers). */
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dict, isDict, type Config, type Dict } from '../config/agent-config.js'
import { HttpFailure } from '../sessions/service.js'
import { SidecarError } from '../sidecar/client.js'
import { redactString } from '../redact.js'
import { atomicWriteText } from '../fs/atomic.js'
import { restoreMasks } from './memory-masks.js'
import { str } from '../util.js'

const HERMES_NAMES = ['.hermes.md', 'HERMES.md']
const CWD_NAMES = ['AGENTS.md', 'agents.md', 'CLAUDE.md', 'claude.md', '.cursorrules']
const MAX_CONTEXT_BYTES = 20_000

const truthy = (v: unknown): boolean => ['1', 'true', 'yes', 'on'].includes(str(v).trim().toLowerCase())

function gitRoot(cwd: string): string | null {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 2_000, windowsHide: true })
  return r.status === 0 && r.stdout.trim() ? resolve(r.stdout.trim()) : null
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content
  const lines = content.split(/(?<=\n)/)
  if (lines[0]?.trim() !== '---') return content
  for (let i = 1; i < lines.length; i += 1) {
    const t = lines[i]?.trim()
    if (t === '---' || t === '...') return lines.slice(i + 1).join('').replace(/^\n+/, '')
  }
  return content
}

/** Python `_project_context_candidates` + `_read_active_project_context`. */
export function readProjectContext(workspace: string | null): Dict {
  const payload: Dict = { content: '', path: '', mtime: null, workspace: workspace ?? '', shadowed: [] }
  if (!workspace) return payload
  let cwd: string
  try {
    cwd = resolve(workspace)
    if (!statSync(cwd).isDirectory()) return payload
  } catch {
    return payload
  }
  const stopAt = gitRoot(cwd) ?? cwd
  const candidates: string[] = []
  let dir = cwd
  for (;;) {
    for (const name of HERMES_NAMES) candidates.push(join(dir, name))
    if (dir === stopAt || dirname(dir) === dir) break
    dir = dirname(dir)
  }
  for (const name of CWD_NAMES) candidates.push(join(cwd, name))
  try {
    const rules = join(cwd, '.cursor', 'rules')
    candidates.push(...readdirSync(rules).filter((n) => n.endsWith('.mdc')).sort().map((n) => join(rules, n)))
  } catch { /* none */ }
  const seen = new Set<string>()
  const readable: { name: string; path: string; content: string; mtime: number }[] = []
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue
      const real = resolve(candidate)
      const key = real.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      let content = stripFrontmatter(readFileSync(real, 'utf8'))
      if (content.length > MAX_CONTEXT_BYTES) content = content.slice(0, MAX_CONTEXT_BYTES)
      if (!content.trim()) continue
      readable.push({ name: real.split('/').pop() ?? real, path: real, content, mtime: statSync(real).mtimeMs / 1000 })
    } catch { /* skip */ }
  }
  const active = readable[0]
  if (!active) return payload
  return {
    ...payload, content: active.content, path: active.path, mtime: active.mtime, name: active.name,
    shadowed: readable.slice(1).map((r) => ({ name: r.name, path: r.path, mtime: r.mtime, shadowed_by: active.name, shadowed_by_path: active.path })),
  }
}

export function externalNotesEnabled(env: Record<string, string | undefined>, config: Config): boolean {
  const envValue = env.HERMES_WEBUI_EXTERNAL_NOTES_SOURCES ?? ''
  if (envValue) return truthy(envValue)
  return truthy(config.webui_external_notes_sources ?? config.external_notes_sources ?? config.notes_sources_drawer)
}

const NO_BYTES = Buffer.alloc(0)

function readText(path: string | null): [Buffer, number | null] {
  if (!path || !existsSync(path)) return [NO_BYTES, null]
  try { return [readFileSync(path), statSync(path).mtimeMs / 1000] } catch { return [NO_BYTES, null] }
}

/**
 * TAL-784: a memory page file's revision. Keyed by the server's signing key, so the page cannot test guesses at a secret it
 * shows masked against the file's plain hash.
 */
export const memoryRevision = (key: Buffer, raw: Buffer): string => createHmac('sha256', key).update('memory-revision\0').update(raw).digest('hex')

export function readMemory(profileHome: string, config: Config, workspace: string | null, env: Record<string, string | undefined>, redact: boolean, key: Buffer): Dict {
  const mem = dict(config.memory)
  const memoryEnabled = mem.memory_enabled === undefined ? true : truthy(mem.memory_enabled)
  const userEnabled = mem.user_profile_enabled === undefined ? true : truthy(mem.user_profile_enabled)
  const memDir = join(profileHome, 'memories')
  const memFile = memoryEnabled ? join(memDir, 'MEMORY.md') : null
  const userFile = userEnabled ? join(memDir, 'USER.md') : null
  const soulFile = join(profileHome, 'SOUL.md')
  const [memory, memoryMtime] = readText(memFile)
  const [user, userMtime] = readText(userFile)
  const [soul, soulMtime] = readText(soulFile)
  const context = readProjectContext(workspace)
  const r = (t: Buffer | string): string => redactString(t.toString(), redact)
  return {
    memory: r(memory), user: r(user), soul: r(soul), project_context: r(str(context.content)),
    memory_revision: memoryRevision(key, memory), user_revision: memoryRevision(key, user), soul_revision: memoryRevision(key, soul),
    memory_path: memFile ?? '', user_path: userFile ?? '', soul_path: soulFile, project_context_path: str(context.path), project_context_name: str(context.name), project_context_workspace: str(context.workspace),
    memory_mtime: memoryMtime, user_mtime: userMtime, soul_mtime: soulMtime, project_context_mtime: context.mtime ?? null, project_context_shadowed: context.shadowed, external_notes_enabled: externalNotesEnabled(env, config),
  }
}

/**
 * What a memory save needs beyond the file: the revision key, the Agent's reading of a MEMORY.md / USER.md body, and the
 * sidecar's compare-and-write, which replaces the file only while its bytes still hash (SHA-256) to `base`.
 */
export interface MemoryWriteDeps {
  key: Buffer
  check: (target: 'memory' | 'user', content: string) => Promise<{ count: number; limit: number }>
  write: (section: 'memory' | 'user' | 'soul', base: string, content: string) => Promise<{ written: boolean }>
}

/** The bytes of the regular file at `target` without following a link; none when it does not exist yet. */
function readCurrent(target: string): Buffer {
  let fd: number
  try {
    fd = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return NO_BYTES
    if (code === 'ELOOP') throw new HttpFailure(400, 'Cannot write to a symlinked memory file')
    if (code === 'EACCES' || code === 'EPERM') throw new HttpFailure(403, `${basename(target)} is not readable: ${target}. Run chmod 644 on the file or fix ownership on the shared volume.`)
    throw error
  }
  try {
    if (!fstatSync(fd).isFile()) throw new HttpFailure(400, 'Cannot write to a non-regular memory file')
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * TAL-886: the page shows each file through `redactString`, so the masks it submits are restored to the secrets they hide,
 * and a MEMORY.md / USER.md body over the Agent store's char limit is refused (the Agent's memory tool cannot add,
 * replace or remove anything in such a file). A refusal leaves the file untouched; SOUL.md stays free-form.
 * TAL-784: `revision` is the file's revision the edit started from. A file changed since, by the Agent's memory tool or
 * another page, is a 409 conflict rather than overwritten; the sidecar re-checks it under the Agent's lock as it writes.
 */
export async function writeMemory(profileHome: string, config: Config, section: string, submitted: string, revision: string, deps: MemoryWriteDeps): Promise<{ ok: true; section: string; path: string }> {
  const mem = dict(config.memory)
  if (section === 'memory' && !(mem.memory_enabled === undefined || truthy(mem.memory_enabled))) throw new HttpFailure(403, 'Memory is disabled by configuration (memory_enabled: false)')
  if (section === 'user' && !(mem.user_profile_enabled === undefined || truthy(mem.user_profile_enabled))) throw new HttpFailure(403, 'User profile is disabled by configuration (user_profile_enabled: false)')
  const memDir = join(profileHome, 'memories')
  mkdirSync(memDir, { recursive: true })
  let target: string
  if (section === 'memory') target = join(memDir, 'MEMORY.md')
  else if (section === 'user') target = join(memDir, 'USER.md')
  else if (section === 'soul') target = join(profileHome, 'SOUL.md')
  else throw new HttpFailure(400, 'section must be "memory", "user", or "soul"')
  try { if (lstatSync(target).isSymbolicLink()) throw new HttpFailure(400, 'Cannot write to a symlinked memory file') } catch (error) { if (error instanceof HttpFailure) throw error }
  const raw = readCurrent(target)
  const conflict = (): HttpFailure => new HttpFailure(409, `${basename(target)} changed after you opened it. Not saved.`, { code: 'memory_conflict' })
  if (memoryRevision(deps.key, raw) !== revision) throw conflict()
  const current = raw.toString()
  // Masks are rebuilt as redaction shows them even when it is off now: the page may have loaded while it was on.
  const content = restoreMasks(current, redactString(current), submitted)
  if (section !== 'soul') {
    const { count, limit } = await deps.check(section, content)
    if (count > limit) {
      throw new HttpFailure(422, `${basename(target)} would hold ${count.toLocaleString('en-US')} characters, over its ${limit.toLocaleString('en-US')}-character limit. Shorten or remove entries, then save.`, { code: 'memory_char_limit', char_limit: { count, limit } })
    }
  }
  let written: boolean
  try {
    ({ written } = await deps.write(section, createHash('sha256').update(raw).digest('hex'), content))
  } catch (error) {
    if (!(error instanceof SidecarError && error.condition === 'memory_not_writable')) throw error
    let hint = ''
    try { hint = ` (mode ${(statSync(target).mode & 0o777).toString(8)})` } catch { /* none */ }
    throw new HttpFailure(403, `${basename(target)} is not writable${hint}: ${target}. The save replaces the file, so its folder must be writable too; fix ownership on the shared volume.`)
  }
  if (!written) throw conflict()
  return { ok: true, section, path: target }
}

// ── saved prompts ─────────────────────────────────────────────────────

export interface SavedPrompt { id: string; label: string; text: string; created_at: number }

const promptsPath = (profileHome: string): string => join(profileHome, 'webui', 'saved_prompts.json')

export function loadPrompts(profileHome: string): SavedPrompt[] {
  try {
    const raw = JSON.parse(readFileSync(promptsPath(profileHome), 'utf8')) as unknown
    return Array.isArray(raw) ? raw.filter(isDict).map((p) => ({ id: str(p.id), label: str(p.label), text: str(p.text), created_at: typeof p.created_at === 'number' ? p.created_at : 0 })) : []
  } catch {
    return []
  }
}

export function savePrompts(profileHome: string, prompts: SavedPrompt[]): void {
  const path = promptsPath(profileHome)
  mkdirSync(dirname(path), { recursive: true })
  atomicWriteText(path, JSON.stringify(prompts, null, 2))
}

export function createPrompt(profileHome: string, textRaw: string, labelRaw: string, now: number): SavedPrompt {
  const text = textRaw.trim()
  const label = labelRaw.trim()
  if (!text) throw new HttpFailure(400, 'text is required')
  if (text.length > 8000) throw new HttpFailure(400, 'text too long (max 8000 chars)')
  const prompts = loadPrompts(profileHome)
  if (prompts.length >= 200) throw new HttpFailure(400, 'saved prompts limit reached (max 200)')
  const prompt = { id: randomUUID().replaceAll('-', '').slice(0, 12), label: label || text.slice(0, 60), text, created_at: now }
  prompts.push(prompt)
  savePrompts(profileHome, prompts)
  return prompt
}

export function deletePrompt(profileHome: string, id: string): void {
  if (!id) throw new HttpFailure(400, 'id is required')
  savePrompts(profileHome, loadPrompts(profileHome).filter((p) => p.id !== id))
}
