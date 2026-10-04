import { pyOsError, str } from '../util.js'
/**
 * Workspace registry and trust boundary (Python `api/workspace.py`): per-profile
 * `workspaces.json` / `last_workspace.txt`, blocked system roots, trusted
 * resolution, suggestions, and add-validation. Remote terminal backends
 * (SSH/Docker) resolve through the profile's config.yaml, supplied by a hook.
 */
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, posix, resolve, sep } from 'node:path'
import { expandHome, isWithin, resolvePathLikePython } from './paths.js'

export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const REMOTE_WORKSPACE_UNSUPPORTED_CODE = 'remote_workspace_unsupported'
export const REMOTE_WORKSPACE_UNSUPPORTED_MESSAGE = 'Workspace file operations are only supported for local terminal backends.'

export interface WorkspaceEntry { path: string; name: string }

export interface TerminalConfig { backend?: string; cwd?: string }

export interface WorkspaceDeps {
  /** Global STATE_DIR (default profile state). */
  stateDir: string
  /** Boot-time default workspace. */
  defaultWorkspace: () => string
  /** Home directory for a logical profile name; throws on an invalid name. */
  profileHome: (profile: string) => string
  /** The active request profile name. */
  activeProfile: () => string
  isRootProfileHome: (home: string) => boolean
  /** `terminal:` block and workspace keys from the profile's config.yaml (checkpoint 7 wires the reader). */
  profileConfig: (profile: string | null) => { terminal?: TerminalConfig | null; workspace?: string; default_workspace?: string } | null
  home?: string
}

export function isRemoteTerminalBackend(terminal: TerminalConfig | null | undefined): boolean {
  if (!terminal || typeof terminal !== 'object') return false
  const backend = (terminal.backend ?? '').trim().toLowerCase()
  return backend !== '' && backend !== 'local'
}

export function stripSurroundingQuotes(path: string): string {
  const s = path.trim()
  const quote = s.startsWith("'") ? "'" : s.startsWith('"') ? '"' : null
  if (quote && s.length >= 2 && s.endsWith(quote)) return s.slice(1, -1)
  return s
}

const USER_TMP_PREFIXES = ['/var/folders', '/private/var/folders', '/var/tmp', '/private/var/tmp']
const BLOCKED_RAW = ['/etc', '/usr', '/var', '/bin', '/sbin', '/boot', '/proc', '/sys', '/dev', '/lib', '/lib64', '/opt/homebrew', '/System', '/Library']

function normalizePosix(path: string | null | undefined): string | null {
  if (!path) return null
  const raw = path.replace(/\\/g, '/')
  if (!raw.startsWith('/')) return null
  return posix.normalize(raw).replace(/\/+$/, '') || '/'
}
function posixWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root === '/' ? '/' : root + '/')
}

export function blockedRoots(): string[] {
  const out: string[] = []
  for (const p of BLOCKED_RAW) for (const form of [p, resolvePathLikePython(p)]) if (!out.includes(form)) out.push(form)
  return out
}

function isBlockedPosixWorkspacePath(raw: string | null | undefined): boolean {
  const candidate = normalizePosix(raw)
  if (candidate === null) return false
  if (candidate === '/') return true
  if (USER_TMP_PREFIXES.some((t) => posixWithin(candidate, t))) return false
  return [...BLOCKED_RAW, '/private/etc', '/private/var'].some((b) => posixWithin(candidate, b))
}

/** Blocked system root check with user-tmp carve-outs (Python `_is_blocked_system_path`). */
export function isBlockedSystemPath(candidate: string): boolean {
  if (USER_TMP_PREFIXES.some((t) => isWithin(candidate, t))) return false
  return blockedRoots().some((b) => isWithin(candidate, b))
}

/** Python `_is_blocked_workspace_path`: compares the raw spelling and the resolved path. */
export function isBlockedWorkspacePath(candidate: string, rawPath?: string | null): boolean {
  let raw: string | null = null
  if (rawPath) {
    const normalized = normalizePosix(rawPath)
    raw = normalized ?? resolve(expandHome(rawPath))
  }
  if (isBlockedPosixWorkspacePath(rawPath || candidate)) return true
  const exact = new Set(['/', '/private/var', ...blockedRoots().map((r) => resolvePathLikePython(r))])
  if (exact.has(candidate) || (raw !== null && blockedRoots().includes(raw))) return true
  for (const tmp of USER_TMP_PREFIXES) if (isWithin(candidate, tmp) || (raw !== null && isWithin(raw, tmp))) return false
  if (raw !== null) for (const blocked of blockedRoots()) if (isWithin(raw, blocked)) return true
  const allowedPrivateVar = ['/private/var/folders', '/private/var/tmp']
  const subtrees = [...blockedRoots(), '/private/etc'].map((r) => resolvePathLikePython(r))
  for (const blocked of subtrees) {
    if (blocked === '/private/var') {
      if (candidate === blocked) return true
      if (allowedPrivateVar.some((a) => isWithin(candidate, a))) continue
      if (isWithin(candidate, blocked)) return true
      continue
    }
    if (isWithin(candidate, blocked)) return true
  }
  return false
}

/** TAL-303: the label every client shows for a workspace: its registered name, else its folder name (the path itself at `/`). */
export function workspaceDisplayName(path: string, entries: readonly WorkspaceEntry[]): string | null {
  if (!path) return null
  return entries.find((w) => w.path === path)?.name || basename(path) || path
}

export class WorkspaceRegistry {
  readonly home: string
  constructor(readonly deps: WorkspaceDeps) {
    this.home = deps.home ?? homedir()
  }

  private profileHomeParam(profile: string | null): string {
    if (profile === null || profile.trim() === '') return this.deps.profileHome(this.deps.activeProfile())
    const raw = profile.trim()
    if (!PROFILE_NAME_RE.test(raw)) throw new Error(`invalid profile name: ${JSON.stringify(raw)}`)
    return resolvePathLikePython(this.deps.profileHome(raw))
  }

  /** Per-profile `webui_state/` dir; the literal default profile uses the global state dir. Writers create it. */
  stateDir(profile: string | null): string {
    if (profile !== null) {
      if (profile.trim() === 'default') return this.deps.stateDir
      const home = this.profileHomeParam(profile)
      return this.deps.isRootProfileHome(home) ? this.deps.stateDir : resolve(home, 'webui_state')
    }
    const name = this.deps.activeProfile()
    return name && name !== 'default' ? resolve(this.deps.profileHome(name), 'webui_state') : this.deps.stateDir
  }

  private workspacesFile(profile: string | null): string | null {
    try { return resolve(this.stateDir(profile), 'workspaces.json') } catch { return null }
  }
  private lastWorkspaceFile(profile: string | null): string | null {
    try { return resolve(this.stateDir(profile), 'last_workspace.txt') } catch { return null }
  }
  private get globalWorkspacesFile(): string { return resolve(this.deps.stateDir, 'workspaces.json') }
  private get globalLastWorkspaceFile(): string { return resolve(this.deps.stateDir, 'last_workspace.txt') }

  homePath(): string {
    return resolvePathLikePython('~', this.home)
  }

  resolvePath(path: string, profile: string | null = null): string {
    const remote = this.remoteTerminalWorkspaceCandidate(path, profile)
    if (remote !== null) return remote
    return resolvePathLikePython(path, this.home)
  }

  remoteTerminalCwd(profile: string | null): string | null {
    try {
      const cfg = this.deps.profileConfig(profile)
      const terminal = cfg?.terminal
      if (!isRemoteTerminalBackend(terminal)) return null
      const cwd = (terminal?.cwd ?? '').trim()
      return cwd && cwd !== '.' ? cwd : null
    } catch {
      return null
    }
  }

  /** A target-side path under `terminal.cwd` for a remote profile, without a local stat. */
  remoteTerminalWorkspaceCandidate(path: string, profile: string | null = null): string | null {
    const cwd = this.remoteTerminalCwd(profile)
    if (!cwd) return null
    const raw = stripSurroundingQuotes(path).trim()
    if (!raw || raw.includes('\0') || cwd.includes('\0')) return null
    const normalizedRaw = normalizePosix(raw)
    const normalizedCwd = normalizePosix(cwd)
    if (normalizedRaw !== null && normalizedCwd !== null) {
      if (isBlockedWorkspacePath(normalizedRaw, normalizedRaw) || isBlockedWorkspacePath(normalizedCwd, normalizedCwd)) return null
      return posixWithin(normalizedRaw, normalizedCwd) ? normalizedRaw : null
    }
    const candidate = resolvePathLikePython(raw, this.home)
    const base = resolvePathLikePython(cwd, this.home)
    if (isBlockedWorkspacePath(candidate, raw) || isBlockedWorkspacePath(base, cwd)) return null
    return isWithin(candidate, base) ? candidate : null
  }

  profileSupportsLocalIo(profile: string | null = null): boolean {
    try {
      // Python: `get_config_for_profile_home(...) or {}`; a missing config or terminal block means local.
      const cfg = this.deps.profileConfig(profile)
      // Fail closed while a profile's config is still unresolved (null); a missing file resolves to `{}` and means local.
      if (cfg === null) return false
      const terminal = cfg.terminal ?? {}
      if (typeof terminal !== 'object') return false
      return !isRemoteTerminalBackend(terminal)
    } catch {
      return false
    }
  }

  /**
   * Python `get_profile_default_workspace` (`GET /api/profile/active`): a named profile's own last workspace first,
   * never the global one (#5169), then the profile's configured default.
   */
  profileDefaultWorkspace(profile: string | null = null): string {
    if (profile?.trim() && !this.deps.isRootProfileHome(this.profileHomeParam(profile))) {
      const file = this.lastWorkspaceFile(profile)
      if (file !== null && existsSync(file)) {
        try {
          const p = this.validLastWorkspace(readFileSync(file, 'utf8').trim(), profile, this.remoteTerminalCwd(profile))
          if (p) return p
        } catch { /* fall through */ }
      }
    }
    return this.profileConfigDefaultWorkspace(profile)
  }

  /** Python `_profile_default_workspace`: config.yaml `workspace` / `default_workspace` / `terminal.cwd`, else the live default — never `last_workspace.txt`. */
  profileConfigDefaultWorkspace(profile: string | null = null): string {
    try {
      const cfg = this.deps.profileConfig(profile)
      if (cfg) {
        const terminal = cfg.terminal ?? {}
        const remote = isRemoteTerminalBackend(terminal)
        for (const key of ['workspace', 'default_workspace'] as const) {
          const ws = cfg[key]
          if (ws) {
            if (remote) return ws.trim()
            const p = resolvePathLikePython(ws, this.home)
            if (isDir(p)) return p
          }
        }
        const cwd = (terminal?.cwd ?? '')
        if (cwd && cwd !== '.') {
          if (remote) return cwd.trim()
          const p = resolvePathLikePython(cwd, this.home)
          if (isDir(p)) return p
        }
      }
    } catch {
      /* fall through */
    }
    return resolvePathLikePython(this.deps.defaultWorkspace(), this.home)
  }

  /** `forNames` keeps every entry a profile without local I/O would drop: a label grants no access (TAL-303). */
  private cleanWorkspaceList(workspaces: unknown, profile: string | null, forNames = false): WorkspaceEntry[] {
    const hermesProfiles = resolvePathLikePython(resolve(this.homePath(), '.hermes', 'profiles'))
    const result: WorkspaceEntry[] = []
    // A cold config.yaml cache reads as non-local until its background refresh lands, which would drop every entry.
    const localIo = forNames || this.profileSupportsLocalIo(profile)
    if (!Array.isArray(workspaces)) return result
    for (const w of workspaces) {
      if (!w || typeof w !== 'object') continue
      const entry = w as Record<string, unknown>
      const path = str(entry.path)
      let name = str(entry.name)
      if (!path) continue
      const remote = this.remoteTerminalWorkspaceCandidate(path, profile)
      let p: string
      if (remote !== null) p = remote
      else {
        if (!localIo) continue
        p = resolvePathLikePython(path, this.home)
      }
      if (isWithin(p, hermesProfiles)) {
        try {
          const own = profile !== null ? this.profileHomeParam(profile) : this.deps.profileHome(this.deps.activeProfile())
          if (!isWithin(p, resolvePathLikePython(own))) continue
        } catch {
          continue
        }
      }
      if (name.toLowerCase() === 'default') name = 'Home'
      // TAL-303: every entry carries a label, so no client names a workspace from its path.
      if (!name.trim()) name = basename(p) || p
      result.push({ path: p, name })
    }
    return result
  }

  load(profile: string | null = null): WorkspaceEntry[] {
    return this.read(profile, false)
  }

  /** TAL-303: the registry as named for display: never rewritten on read, and complete before a profile's config is cached. */
  entries(profile: string | null = null): WorkspaceEntry[] {
    return this.read(profile, true)
  }

  private read(profile: string | null, forNames: boolean): WorkspaceEntry[] {
    const persist = !forNames
    const file = this.workspacesFile(profile)
    if (file !== null && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
        const cleaned = this.cleanWorkspaceList(raw, profile, forNames)
        if (persist && Array.isArray(raw) && cleaned.length !== raw.length) {
          try { writeFileSync(file, JSON.stringify(cleaned, null, 2), 'utf8') } catch { /* best effort */ }
        }
        return cleaned.length ? cleaned : [{ path: this.profileConfigDefaultWorkspace(profile), name: 'Home' }]
      } catch {
        /* fall through */
      }
    }
    let isDefault = true
    try {
      isDefault = profile !== null ? this.deps.isRootProfileHome(this.profileHomeParam(profile)) : ['default', ''].includes(this.deps.activeProfile())
    } catch {
      isDefault = true
    }
    if (isDefault) {
      const migrated = this.migrateGlobalWorkspaces(forNames)
      if (migrated.length) return migrated
    }
    return [{ path: this.profileConfigDefaultWorkspace(profile), name: 'Home' }]
  }

  private migrateGlobalWorkspaces(forNames: boolean): WorkspaceEntry[] {
    if (!existsSync(this.globalWorkspacesFile)) return []
    try {
      const raw = JSON.parse(readFileSync(this.globalWorkspacesFile, 'utf8')) as unknown
      const cleaned = this.cleanWorkspaceList(raw, null, forNames)
      if (!forNames && Array.isArray(raw) && cleaned.length !== raw.length) writeFileSync(this.globalWorkspacesFile, JSON.stringify(cleaned, null, 2), 'utf8')
      return cleaned
    } catch {
      return []
    }
  }

  save(workspaces: WorkspaceEntry[], profile: string | null = null): void {
    const file = this.workspacesFile(profile)
    if (file === null) throw new Error(`cannot save workspaces for invalid profile ${JSON.stringify(profile)}`)
    mkdirSync(resolve(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(workspaces, null, 2), 'utf8')
  }

  private validLastWorkspace(raw: string, profile: string | null, remoteCwd: string | null): string | null {
    if (!raw) return null
    if (remoteCwd) return this.remoteTerminalWorkspaceCandidate(raw, profile) !== null ? raw : null
    return isDir(raw) ? raw : null
  }

  /** Profile `last_workspace.txt` -> profile config -> live default (never the global file). */
  profileDefaultWorkspaceForBoot(profile: string | null = null): string {
    const remoteCwd = this.remoteTerminalCwd(profile)
    const file = this.lastWorkspaceFile(profile)
    if (file !== null && existsSync(file)) {
      try {
        const p = this.validLastWorkspace(readFileSync(file, 'utf8').trim(), profile, remoteCwd)
        if (p) return p
      } catch { /* ignore */ }
    }
    return this.profileConfigDefaultWorkspace(profile)
  }

  lastWorkspace(profile: string | null = null): string {
    const remoteCwd = this.remoteTerminalCwd(profile)
    const file = this.lastWorkspaceFile(profile)
    if (file !== null && existsSync(file)) {
      try {
        const p = this.validLastWorkspace(readFileSync(file, 'utf8').trim(), profile, remoteCwd)
        if (p) return p
      } catch { /* ignore */ }
    }
    let globalAllowed = false
    if (profile === null) globalAllowed = ['', 'default'].includes(this.deps.activeProfile())
    else if (profile.trim() === 'default') globalAllowed = true
    else {
      try { globalAllowed = this.deps.isRootProfileHome(this.profileHomeParam(profile)) } catch { globalAllowed = false }
    }
    if (globalAllowed && existsSync(this.globalLastWorkspaceFile)) {
      try {
        const p = this.validLastWorkspace(readFileSync(this.globalLastWorkspaceFile, 'utf8').trim(), profile, remoteCwd)
        if (p) return p
      } catch { /* ignore */ }
    }
    return this.profileConfigDefaultWorkspace(profile)
  }

  setLastWorkspace(path: string, profile: string | null = null): void {
    try {
      const file = this.lastWorkspaceFile(profile)
      if (file === null) return
      mkdirSync(resolve(file, '..'), { recursive: true })
      writeFileSync(file, path, 'utf8')
    } catch {
      /* best effort */
    }
  }

  /** Python `_workspace_access_error`. */
  accessError(candidate: string, missingLabel = 'Path does not exist'): string | null {
    let st
    try {
      st = statSync(candidate)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return `${missingLabel}: ${candidate}`
      if (code === 'EACCES' || code === 'EPERM') {
        return `Cannot access path: ${candidate}. The server process could not inspect this directory (${pyOsError(error, candidate)}). On macOS, grant Full Disk Access or Files and Folders permission to the Hermes/WebUI app or server process, then try again.`
      }
      return `Cannot access path: ${candidate}. The server process could not inspect this path (${pyOsError(error, candidate)}).`
    }
    if (!st.isDirectory()) return `Path is not a directory: ${candidate}`
    return null
  }

  trustedRoots(profile: string | null = null): string[] {
    const roots: string[] = []
    const add = (candidate: string | null | undefined) => {
      if (!candidate) return
      let p: string
      try { p = this.resolvePath(candidate) } catch { return }
      if (!isDir(p)) return
      if (isBlockedWorkspacePath(p, candidate)) return
      if (!roots.includes(p)) roots.push(p)
    }
    add(this.homePath())
    add(this.deps.defaultWorkspace())
    for (const w of this.load(profile)) add(w.path)
    roots.sort((a, b) => a.length - b.length)
    return roots
  }

  /** Directory suggestions under trusted roots only (Python `list_workspace_suggestions`). */
  suggest(prefix = '', limit = 12, profile: string | null = null): string[] {
    if (!this.profileSupportsLocalIo(profile)) return []
    const roots = this.trustedRoots(profile)
    if (!roots.length) return []
    const raw = prefix.trim()
    if (!raw) return roots.slice(0, limit)
    let target: string
    if (raw.startsWith('~')) target = expandHome(raw, this.home)
    else if (isAbsolute(raw)) target = raw
    else target = resolve(this.homePath(), raw)
    let matchTarget: string
    try { matchTarget = resolvePathLikePython(target, this.home) } catch { matchTarget = target }
    const normalizedLower = matchTarget.toLowerCase()
    const preserveTilde = raw.startsWith('~')
    const homeRoot = preserveTilde ? this.homePath() : null
    const suggestions: string[] = []
    const format = (p: string): string => {
      if (preserveTilde && homeRoot !== null) {
        const real = resolvePathLikePython(p)
        if (real === homeRoot) return '~'
        if (isWithin(real, homeRoot)) return '~/' + real.slice(homeRoot.length + 1).split(sep).join('/')
      }
      return p
    }
    const add = (p: string) => { const v = format(p); if (!suggestions.includes(v)) suggestions.push(v) }
    for (const root of roots) if (root.toLowerCase().startsWith(normalizedLower)) add(root)
    const inRoot = roots.filter((root) => matchTarget === root || matchTarget.startsWith(root + sep))
    if (!inRoot.length) return suggestions.slice(0, limit)
    const anchor = inRoot.reduce((a, b) => (b.length > a.length ? b : a))
    const endsWithSep = raw.endsWith(sep) || raw.endsWith('/')
    const parent = endsWithSep ? target : resolve(target, '..')
    const leaf = endsWithSep ? '' : basename(target)
    const showHidden = leaf.startsWith('.')
    let parentResolved: string
    try { parentResolved = resolvePathLikePython(parent, this.home) } catch { return suggestions.slice(0, limit) }
    if (!isDir(parentResolved) || !isWithin(parentResolved, anchor)) return suggestions.slice(0, limit)
    const leafLower = leaf.toLowerCase()
    let children: string[]
    try { children = readdirSync(parentResolved).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())) } catch { return suggestions.slice(0, limit) }
    for (const child of children) {
      const full = resolve(parentResolved, child)
      if (!isDir(full)) continue
      if (child.startsWith('.') && !showHidden) continue
      if (leafLower && !child.toLowerCase().startsWith(leafLower)) continue
      add(resolvePathLikePython(full))
      if (suggestions.length >= limit) break
    }
    return suggestions.slice(0, limit)
  }

  /** Python `resolve_trusted_workspace`: home, saved list, or under the boot default. */
  resolveTrusted(path: string | null | undefined, profile: string | null = null): string {
    if (!path) {
      if (!this.profileSupportsLocalIo(profile)) {
        const remote = this.remoteTerminalWorkspaceCandidate(this.profileConfigDefaultWorkspace(profile), profile)
        if (remote === null) throw new Error('Remote terminal workspace is not configured')
        return remote
      }
      return resolvePathLikePython(this.deps.defaultWorkspace(), this.home)
    }
    const remote = this.remoteTerminalWorkspaceCandidate(path, profile)
    if (remote !== null) return remote
    if (!this.profileSupportsLocalIo(profile)) {
      this.rejectBlockedRemote(path)
      throw new Error('Path is outside the configured remote terminal workspace')
    }
    const candidate = this.resolvePath(path, profile)
    const accessError = this.accessError(candidate)
    if (accessError) throw new Error(accessError)
    const home = this.homePath()
    if (home !== '/' && isWithin(candidate, home)) return candidate
    if (isBlockedWorkspacePath(candidate, path)) throw new Error(`Path points to a system directory: ${candidate}`)
    try {
      const saved = new Set(this.load(profile).map((w) => this.resolvePath(w.path, profile)))
      if (saved.has(candidate)) return candidate
    } catch { /* ignore */ }
    const bootDefault = resolvePathLikePython(this.deps.defaultWorkspace(), this.home)
    if (isWithin(candidate, bootDefault)) return candidate
    throw new Error(`Path is outside the user home directory, not in the saved workspace list, and not under the default workspace: ${candidate}. Add it via Settings → Workspaces first.`)
  }

  private rejectBlockedRemote(path: string): void {
    const raw = stripSurroundingQuotes(path).trim()
    const normalized = normalizePosix(raw)
    const candidate = normalized ?? raw
    if (isBlockedWorkspacePath(candidate, raw)) throw new Error(`Path points to a system directory: ${candidate}`)
  }

  /** Recover only a genuinely missing implicit workspace (Python `resolve_implicit_workspace_with_recovery`). */
  resolveImplicitWithRecovery(candidate: string | null | undefined, fallback: (profile: string | null) => string, profile: string | null = null): [string, boolean] {
    try {
      return [this.resolveTrusted(candidate, profile), false]
    } catch (original) {
      if (!candidate) throw original
      let terminal: TerminalConfig | null | undefined
      try {
        terminal = this.deps.profileConfig(profile)?.terminal
      } catch {
        throw original
      }
      if (isRemoteTerminalBackend(terminal)) throw original
      const local = this.resolvePath(candidate, profile)
      try {
        statSync(local)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [this.resolveTrusted(fallback(profile), profile), true]
        throw original
      }
      throw original
    }
  }

  /** Less strict than `resolveTrusted`: explicit user intent to register (Python `validate_workspace_to_add`). */
  validateToAdd(path: string, profile: string | null = null): string {
    const cleaned = stripSurroundingQuotes(path)
    const remote = this.remoteTerminalWorkspaceCandidate(cleaned, profile)
    if (remote !== null) return remote
    if (!this.profileSupportsLocalIo(profile)) {
      this.rejectBlockedRemote(cleaned)
      throw new Error('Path is outside the configured remote terminal workspace')
    }
    const candidate = this.resolvePath(cleaned, profile)
    const accessError = this.accessError(candidate)
    if (accessError) throw new Error(accessError)
    const home = this.homePath()
    if (home !== '/' && isWithin(candidate, home)) return candidate
    if (isBlockedWorkspacePath(candidate, cleaned)) throw new Error(`Path points to a system directory: ${candidate}`)
    return candidate
  }
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function isWritableDir(path: string): boolean {
  try {
    accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK)
    return isDir(path)
  } catch {
    return false
  }
}
