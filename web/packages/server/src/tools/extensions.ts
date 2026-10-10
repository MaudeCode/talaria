/** Browser extension registry: manifest scan, user overrides, sidecar consent, gallery install (Python `api/extensions.py`, `api/extension_manifests.py`). */
import { readCapped } from '../http/capped.js'
import { FileExistsError, makeAnchoredDir, openAnchoredCreateFd, openAnchoredFd, openAnchoredWriteFd, rmdirAnchored, unlinkAnchored, withAnchoredDir } from '../workspace/fs.js'
import { resolvePathLikePython } from '../workspace/paths.js'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { atomicWriteText } from '../fs/atomic.js'
import { readZip } from '../workspace/unzip.js'
import { isDict, type Dict } from '../config/agent-config.js'
import { str } from '../util.js'

export class ExtensionError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export const EXTENSION_ROUTE_PREFIX = '/extensions/'
export const EXTENSION_PANEL_SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-downloads allow-modals; frame-ancestors 'self'"
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SETTINGS_KEY_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const SETTING_TYPES = new Set(['boolean', 'string', 'number', 'integer', 'enum'])
const MAX_STATE_ENTRIES = 512
const MAX_URL_LIST = 32
const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_STATE_BYTES = 32 * 1024
const MAX_ZIP_BYTES = 32 * 1024 * 1024
const MAX_INSTALL_MANIFEST_BYTES = 128 * 1024
const REGISTRY_URL = 'https://hermes-webui.github.io/hermes-webui-extensions/registry.json'
const ALLOWED_DOWNLOAD_HOSTS = new Set(['hermes-webui.github.io'])
const REGISTRY_TTL_MS = 300_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const ALLOWED_ASSET_PREFIXES = ['/extensions/', '/static/']
const ALLOWED_DOTFILES = new Set(['.gitkeep', '.gitignore', '.gitattributes', '.env.example'])
export const EXTENSION_MIME: Record<string, string> = { css: 'text/css', js: 'application/javascript', html: 'text/html', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', ico: 'image/x-icon', gif: 'image/gif', webp: 'image/webp', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm' }
const TEXT_MIME = new Set(['text/css', 'application/javascript', 'text/html', 'image/svg+xml', 'text/plain'])

export interface ExtensionDeps { env: Record<string, string | undefined>; stateDir: string; isAuthEnabled: () => Promise<boolean>; fetch: typeof fetch; log: (line: string) => void }

export const validId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v.trim())
interface Diagnostics { warnings: { code: string; source: string }[] }
const warn = (d: Diagnostics | null, code: string, source: string): void => { if (d && !d.warnings.some((w) => w.code === code && w.source === source)) d.warnings.push({ code, source }) }

export function fullyUnquote(path: string): string {
  let prev = path
  for (let i = 0; i < 10; i += 1) {
    let cur: string
    try { cur = decodeURIComponent(prev) } catch { return prev }
    if (cur === prev) return cur
    prev = cur
  }
  return prev
}

export function isSafeRelativePath(rel: string): boolean {
  if (!rel || rel.includes('\0') || rel.includes('\\')) return false
  return rel.split('/').every((s) => s && s !== '.' && s !== '..' && !s.startsWith('.'))
}

function isSafeArchiveMember(rel: string): boolean {
  if (!rel || rel.includes('\0') || rel.includes('\\')) return false
  const parts = rel.split('/')
  const leaf = parts[parts.length - 1] ?? ''
  if (!parts.slice(0, -1).every((s) => s && s !== '.' && s !== '..' && !s.startsWith('.'))) return false
  if (!leaf || leaf === '.' || leaf === '..') return false
  return !leaf.startsWith('.') || ALLOWED_DOTFILES.has(leaf)
}

/** Python `_is_safe_asset_url`: `urlsplit` semantics — the raw path (no dot-segment resolution) must start with an allowed prefix. */
function isSafeAssetUrl(value: string): boolean {
  if (!value || /[\0\r\n"'<>\\]/.test(value)) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//') || value.includes('#')) return false
  const path = value.split('?')[0] ?? ''
  const decoded = fullyUnquote(path)
  for (const prefix of ALLOWED_ASSET_PREFIXES) if (decoded.startsWith(prefix)) return isSafeRelativePath(decoded.slice(prefix.length))
  return false
}

/**
 * Read `<root>/<rel>` for a static route: `rel` must be a clean relative path (no dot segments or dotfiles), and the
 * read is an anchored, symlink-free open, so a link inside the root cannot expose its target. Python
 * `(root / rel).resolve()`: a symlinked file is served when its target stays inside the root, never otherwise.
 */
export function readContainedFile(root: string, rel: string): { body: Buffer; file: string } | null {
  if (!isSafeRelativePath(rel)) return null
  const anchor = resolvePathLikePython(root)
  let file = resolve(anchor, rel)
  if (!file.startsWith(anchor + sep)) return null
  const real = resolvePathLikePython(file)
  if (real !== file) { if (!real.startsWith(anchor + sep)) return null; file = real }
  let fd: number
  try { fd = openAnchoredFd(anchor, file, { wantDir: false }) } catch { return null }
  try {
    return fstatSync(fd).isFile() ? { body: readFileSync(fd), file } : null
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/**
 * Python `_normalize_loopback_sidecar_origin` (`urlsplit`, not WHATWG): scheme + literal loopback host + optional
 * numeric port, nothing else — no path (not even `/`), no query, no fragment, no userinfo, no host aliases.
 */
export function normalizeLoopbackOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const origin = value.trim()
  if (!origin || /[\0\r\n"'<>\\]/.test(origin)) return null
  const m = /^(https?):\/\/([^/?#]*)$/i.exec(origin)
  if (!m) return null
  const scheme = (m[1] ?? '').toLowerCase()
  const netloc = m[2] ?? ''
  if (!netloc || netloc.includes('@')) return null
  const hostPort = /^(\[[^\]]*\]|[^:]*)(?::(.*))?$/.exec(netloc)
  if (!hostPort) return null
  const host = (hostPort[1] ?? '').replace(/^\[|\]$/g, '').toLowerCase()
  if (!LOOPBACK_HOSTS.has(host)) return null
  const portRaw = hostPort[2]
  let port: string | null = null
  if (portRaw !== undefined && portRaw !== '') {
    if (!/^\d+$/.test(portRaw)) return null
    const n = Number.parseInt(portRaw, 10)
    if (n < 0 || n > 65535) return null
    port = String(n)
  }
  const display = host.includes(':') ? `[${host}]` : host
  return `${scheme}://${display}${port !== null ? `:${port}` : ''}`
}

function normalizeHealthPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const path = value.trim()
  if (!path.startsWith('/') || path.startsWith('//') || /[\0\r\n"'<>\\?#\s]/.test(path)) return null
  const decoded = fullyUnquote(path)
  if (/[\0\r\n"'<>\\?#\s]/.test(decoded) || !decoded.startsWith('/') || decoded.startsWith('//')) return null
  const segments = decoded.split('/').slice(1)
  return segments.length && segments.every((s) => s && s !== '.' && s !== '..') ? decoded : null
}

export function normalizeProxyPath(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return '/'
  const raw = str(value)
  if (raw.startsWith('/')) return null
  const candidate = `/${raw}`
  const decoded = fullyUnquote(candidate)
  if (/[?#\s]/.test(decoded) || !decoded.startsWith('/') || decoded.startsWith('//')) return null
  const segments = decoded.split('/').slice(1)
  return segments.length && segments.every((s) => s && s !== '.' && s !== '..') ? candidate : null
}

export const text = (v: unknown, max = 160): string => (typeof v === 'string' ? v.replaceAll(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max) : '')
const entryText = (e: Dict, k: string): string => (typeof e[k] === 'string' ? e[k].trim() : '')
const storageOwned = (e: Dict): boolean => isDict(e.permissions) && isDict(e.permissions.storage) && e.permissions.storage.owned === true

function settingsSchema(entry: Dict): Dict[] {
  if (!storageOwned(entry)) return []
  const raw = Array.isArray(entry.settings_schema) ? entry.settings_schema : []
  const out: Dict[] = []
  const seen = new Set<string>()
  for (const field of raw) {
    if (!isDict(field) || field.sensitive === true || typeof field.key !== 'string' || typeof field.type !== 'string') continue
    const key = field.key.trim()
    const type = field.type.trim().toLowerCase()
    if (!SETTINGS_KEY_RE.test(key) || !SETTING_TYPES.has(type) || seen.has(key)) continue
    let options: { value: string; label: string }[] | null = null
    if (type === 'enum') {
      if (!Array.isArray(field.options) || !field.options.length) continue
      options = []
      let ok = true
      for (const o of field.options) {
        let value: string
        let label: string
        if (typeof o === 'string') { value = o.trim(); label = value } else if (isDict(o) && typeof o.value === 'string') { value = o.value.trim(); label = text(o.label) || value } else { ok = false; break }
        if (!value || options.some((x) => x.value === value)) { ok = false; break }
        options.push({ value, label })
      }
      if (!ok) continue
    }
    const hasDefault = 'default' in field
    const d = field.default
    let def: unknown
    if (type === 'boolean') { if (hasDefault && typeof d !== 'boolean') continue; def = hasDefault ? d : false }
    else if (type === 'string') { if (hasDefault && typeof d !== 'string') continue; def = hasDefault ? d : '' }
    else if (type === 'number') { if (hasDefault && !(typeof d === 'number' && Number.isFinite(d))) continue; def = hasDefault ? d : 0 }
    else if (type === 'integer') { if (hasDefault && !Number.isInteger(d)) continue; def = hasDefault ? d : 0 }
    else { const values = (options ?? []).map((o) => o.value); if (hasDefault && !(typeof d === 'string' && values.includes(d))) continue; def = hasDefault ? d : values[0] }
    seen.add(key)
    const row: Dict = { key, type, label: text(field.label) || key, description: text(field.description, 300), default: def }
    if (options) row.options = options
    out.push(row)
  }
  return out
}

function manifestEntries(manifest: unknown): Dict[] {
  const list = isDict(manifest) ? manifest.extensions : Array.isArray(manifest) ? manifest : []
  return Array.isArray(list) ? list.filter(isDict) : []
}

function sidecarFromEntry(entry: Dict, d: Diagnostics | null): Dict | null {
  const raw = entry.sidecar
  if (raw === null || raw === undefined) return null
  const src = 'manifest:sidecars'
  if (!isDict(raw)) { warn(d, 'sidecar_invalid', src); return null }
  if (raw.type !== 'loopback') { warn(d, 'sidecar_type_unsupported', src); return null }
  const origin = normalizeLoopbackOrigin(raw.origin)
  if (!origin) { warn(d, 'sidecar_origin_rejected', src); return null }
  let healthPath = '/health'
  if ('health_path' in raw) { const hp = normalizeHealthPath(raw.health_path); if (!hp) { warn(d, 'sidecar_health_path_rejected', src); return null } healthPath = hp }
  let proxyAuth = 'legacy'
  if (raw.proxy_auth !== null && raw.proxy_auth !== undefined) {
    if (raw.proxy_auth !== 'legacy' && raw.proxy_auth !== 'token-v1') { warn(d, 'sidecar_proxy_auth_unsupported', src); return null }
    proxyAuth = raw.proxy_auth
  }
  return { id: entryText(entry, 'id'), name: entryText(entry, 'name'), type: 'loopback', origin, health_path: healthPath, health_url: `${origin}${healthPath}`, proxy_auth: proxyAuth }
}

/** Entries the gallery loader read from `<root>/<id>/`, keyed by object so a manifest can never claim gallery provenance. */
const galleryFolders = new WeakMap<Dict, string>()

interface State { version: 1; disabled_extensions: string[]; sidecar_proxy_consents: Record<string, string> }

export class ExtensionService {
  private registryCache: { at: number; entries: unknown[] } | null = null
  private registryInflight: Promise<unknown[]> | null = null
  /** Read/validate/write of the state file runs one transaction at a time: `setConsent` awaits the sidecar probe mid-transaction. */
  private stateLock: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: ExtensionDeps) {}

  private get defaultRoot(): string { return join(this.deps.stateDir, 'extensions') }
  private get stateFile(): string { return join(this.deps.stateDir, 'extension-overrides.json') }
  private get installFile(): string { return join(this.deps.stateDir, 'extension-install-manifest.json') }

  root(): string | null {
    const raw = (this.deps.env.HERMES_WEBUI_EXTENSION_DIR ?? '').trim()
    if (raw) {
      const r = resolve(raw.replace(/^~(?=$|\/)/, this.deps.env.HOME ?? ''))
      return existsSync(r) && statSync(r).isDirectory() ? r : null
    }
    try { return existsSync(this.defaultRoot) && statSync(this.defaultRoot).isDirectory() && !lstatSync(this.defaultRoot).isSymbolicLink() ? resolve(this.defaultRoot) : null } catch { return null }
  }

  private writableRoot(): string | null {
    if ((this.deps.env.HERMES_WEBUI_EXTENSION_DIR ?? '').trim()) return this.root()
    try { mkdirSync(this.defaultRoot, { recursive: true }); return lstatSync(this.defaultRoot).isSymbolicLink() ? null : resolve(this.defaultRoot) } catch { return null }
  }

  private loadState(d: Diagnostics | null): State {
    const empty: State = { version: 1, disabled_extensions: [], sidecar_proxy_consents: {} }
    const src = 'extension_state'
    let parsed: unknown
    try {
      if (!existsSync(this.stateFile) || !statSync(this.stateFile).isFile()) return empty
      const raw = readFileSync(this.stateFile)
      if (raw.length > MAX_STATE_BYTES) { warn(d, 'extension_state_oversized', src); return empty }
      parsed = JSON.parse(raw.toString('utf8'))
    } catch { warn(d, 'extension_state_unreadable', src); return empty }
    if (!isDict(parsed)) { warn(d, 'extension_state_invalid', src); return empty }
    const disabledRaw = parsed.disabled_extensions ?? []
    if (!Array.isArray(disabledRaw)) { warn(d, 'extension_state_invalid', src); return empty }
    let invalid = false
    const disabled: string[] = []
    // Python `_MAX_DISABLED_EXTENSION_IDS` / `_MAX_SIDECAR_PROXY_CONSENTS`: the state file is read up to 512 entries each.
    for (const v of disabledRaw) {
      if (!validId(v)) { invalid = true; continue }
      if (disabled.includes(v.trim())) continue
      disabled.push(v.trim())
      if (disabled.length >= MAX_STATE_ENTRIES) { warn(d, 'extension_state_truncated', src); break }
    }
    let consents: Record<string, string> = {}
    const rawConsents = parsed.sidecar_proxy_consents ?? {}
    let consentsInvalid = false
    if (rawConsents !== null) {
      if (!isDict(rawConsents)) { invalid = true; consentsInvalid = true } else {
        for (const [id, origin] of Object.entries(rawConsents)) {
          const norm = validId(id) ? normalizeLoopbackOrigin(origin) : null
          if (!norm) { invalid = true; consentsInvalid = true; continue }
          if (id.trim() in consents) continue
          consents[id.trim()] = norm
          if (Object.keys(consents).length >= MAX_STATE_ENTRIES) { warn(d, 'extension_state_truncated', src); break }
        }
      }
    }
    if (consentsInvalid) consents = {}
    if (invalid) warn(d, 'extension_state_invalid_entries', src)
    return { version: 1, disabled_extensions: disabled, sidecar_proxy_consents: consents }
  }

  private writeState(state: { disabled_extensions: string[]; sidecar_proxy_consents: Record<string, string> }): void {
    mkdirSync(this.deps.stateDir, { recursive: true })
    atomicWriteText(this.stateFile, JSON.stringify({ version: 1, disabled_extensions: [...new Set(state.disabled_extensions.filter(validId))].sort(), sidecar_proxy_consents: state.sidecar_proxy_consents }, null, 2))
  }

  private loadInstallManifest(): { version: 1; installed: Record<string, { version: string; files: string[]; installed_at: string }> } {
    const empty = { version: 1 as const, installed: {} }
    try {
      if (!existsSync(this.installFile)) return empty
      const raw = readFileSync(this.installFile)
      if (raw.length > MAX_INSTALL_MANIFEST_BYTES) return empty
      const parsed = JSON.parse(raw.toString('utf8')) as unknown
      if (!isDict(parsed) || !isDict(parsed.installed)) return empty
      const installed: Record<string, { version: string; files: string[]; installed_at: string }> = {}
      for (const [id, entry] of Object.entries(parsed.installed)) {
        if (!validId(id) || !isDict(entry) || !Array.isArray(entry.files)) continue
        installed[id] = { version: str(entry.version ?? 'unknown'), files: entry.files.filter((f): f is string => typeof f === 'string'), installed_at: str(entry.installed_at) }
        if (Object.keys(installed).length >= 256) break
      }
      return { version: 1, installed }
    } catch { return empty }
  }

  private writeInstallManifest(manifest: { version: 1; installed: Record<string, unknown> }): void {
    mkdirSync(this.deps.stateDir, { recursive: true })
    atomicWriteText(this.installFile, JSON.stringify(manifest, null, 2))
  }

  private manifestPath(root: string): [string | null, string] {
    const raw = (this.deps.env.HERMES_WEBUI_EXTENSION_MANIFEST ?? '').trim()
    if (!raw) return [null, 'not_configured']
    if (raw.startsWith('/') || raw.startsWith('~')) return [null, 'invalid_path']
    const rel = fullyUnquote(raw)
    if (!isSafeRelativePath(rel)) return [null, 'invalid_path']
    const manifest = resolve(root, rel)
    if (!manifest.startsWith(root + sep)) return [null, 'invalid_path']
    // Python `(root / rel).resolve().relative_to(root)`: a symlinked manifest that leaves the root is rejected too.
    const real = resolvePathLikePython(manifest)
    const rootReal = resolvePathLikePython(root)
    if (real !== rootReal && !real.startsWith(rootReal + sep)) return [null, 'invalid_path']
    return [manifest, 'configured']
  }

  private galleryManifest(root: string, d: Diagnostics | null): Dict | null {
    const installed = this.loadInstallManifest().installed
    const entries: Dict[] = []
    for (const id of Object.keys(installed).sort()) {
      if (!validId(id)) continue
      const file = join(root, id, 'manifest.json')
      let manifest: unknown
      try {
        if (!existsSync(file) || !statSync(file).isFile()) { warn(d, 'gallery_manifest_missing', 'gallery'); continue }
        const raw = readFileSync(file)
        if (raw.length > MAX_MANIFEST_BYTES) { warn(d, 'gallery_manifest_oversized', 'gallery'); continue }
        manifest = JSON.parse(raw.toString('utf8'))
      } catch { warn(d, 'gallery_manifest_malformed', 'gallery'); continue }
      const withBase = (entry: Dict): Dict => {
        const copy = { ...entry }
        const rebase = (v: unknown): unknown => (typeof v === 'string' && v.trim() && !/^[a-z]+:|^\/\/|^\//i.test(v.trim()) ? `${id}/${v.trim()}` : v)
        for (const key of ['scripts', 'stylesheets']) if (Array.isArray(copy[key])) copy[key] = copy[key].map(rebase)
        if (typeof copy.panel === 'string') copy.panel = rebase(copy.panel.trim().replace(/^(\.\/)+/, ''))
        galleryFolders.set(copy, id)
        return copy
      }
      if (isDict(manifest)) {
        const top: Dict = { id }
        for (const key of ['name', 'enabled', 'version', 'description', 'panel', 'nav', 'capabilities', 'scripts', 'stylesheets', 'sidecar', 'permissions', 'settings_schema']) if (key in manifest) top[key] = manifest[key]
        if (['panel', 'scripts', 'stylesheets', 'sidecar', 'permissions', 'settings_schema'].some((k) => k in top)) entries.push(withBase(top))
      }
      for (const entry of manifestEntries(manifest)) { const copy = withBase(entry); if (!validId(copy.id)) copy.id = id; entries.push(copy) }
    }
    return entries.length ? { extensions: entries } : null
  }

  private loadManifest(root: string, d: Diagnostics | null): [unknown, Dict] {
    const [file, pathStatus] = this.manifestPath(root)
    const status: Dict = { configured: pathStatus !== 'not_configured', loaded: false, status: pathStatus, _asset_base: '', entry_count: 0, script_count: 0, stylesheet_count: 0, sidecar_count: 0 }
    if (!file) {
      if (pathStatus === 'invalid_path') warn(d, 'manifest_invalid_path', 'manifest')
      else if (pathStatus === 'not_configured') {
        const gallery = this.galleryManifest(root, d)
        if (gallery) return [gallery, { ...status, loaded: true, status: 'gallery_installed' }]
      }
      return [null, status]
    }
    try {
      if (!existsSync(file) || !statSync(file).isFile()) { status.status = 'missing'; warn(d, 'manifest_missing', 'manifest'); return [null, status] }
      const raw = readFileSync(file)
      if (raw.length > MAX_MANIFEST_BYTES) { status.status = 'oversized'; warn(d, 'manifest_oversized', 'manifest'); return [null, status] }
      const manifest = JSON.parse(raw.toString('utf8')) as unknown
      const relParent = relative(root, dirname(file)).split(sep).join('/')
      return [manifest, { ...status, loaded: true, status: 'loaded', _asset_base: relParent === '' || relParent === '.' ? '' : relParent }]
    } catch (error) {
      status.status = error instanceof SyntaxError ? 'malformed' : 'unreadable'
      warn(d, error instanceof SyntaxError ? 'manifest_malformed' : 'manifest_unreadable', 'manifest')
      return [null, status]
    }
  }

  private extensionState(manifest: unknown, disabled: Set<string>, d: Diagnostics | null, consentIds: Set<string>): { extensions: Dict[]; knownIds: Set<string>; manifestDisabled: Set<string> } {
    const extensions: Dict[] = []
    const knownIds = new Set<string>()
    const manifestDisabled = new Set<string>()
    let invalid = false
    let duplicate = false
    for (const entry of manifestEntries(manifest)) {
      const raw = entryText(entry, 'id')
      if (!validId(raw)) { invalid = true; continue }
      if (knownIds.has(raw)) { duplicate = true; continue }
      knownIds.add(raw)
      const manifestEnabled = entry.enabled !== false
      const userDisabled = disabled.has(raw)
      if (!manifestEnabled) manifestDisabled.add(raw)
      extensions.push({
        id: raw, name: entryText(entry, 'name') || raw, manifest_enabled: manifestEnabled, user_enabled: manifestEnabled ? !userDisabled : false, user_disabled: userDisabled,
        effective_enabled: manifestEnabled && !userDisabled, can_toggle: manifestEnabled, reload_required: true, storage_owned: storageOwned(entry), settings_schema: settingsSchema(entry),
        status: !manifestEnabled ? 'manifest_disabled' : userDisabled ? 'user_disabled' : 'enabled',
      })
    }
    if (invalid) warn(d, 'manifest_extension_id_invalid', 'manifest:extensions')
    if (duplicate) warn(d, 'manifest_extension_id_duplicate', 'manifest:extensions')
    if ([...disabled, ...consentIds].some((id) => !knownIds.has(id))) warn(d, 'extension_state_unknown_ids', 'extension_state')
    return { extensions, knownIds, manifestDisabled }
  }

  private async sidecarRecords(manifest: unknown, disabled: Set<string>, state: State, d: Diagnostics | null): Promise<{ records: Dict[]; byId: Map<string, Dict> }> {
    const counts = new Map<string, number>()
    const byId = new Map<string, Dict>()
    for (const entry of manifestEntries(manifest)) {
      const id = entryText(entry, 'id')
      if (!validId(id)) continue
      counts.set(id, (counts.get(id) ?? 0) + 1)
      if (byId.has(id)) continue
      const manifestEnabled = entry.enabled !== false
      const effective = manifestEnabled && !disabled.has(id)
      byId.set(id, { id, name: entryText(entry, 'name'), manifest_enabled: manifestEnabled, user_disabled: disabled.has(id), effective_enabled: effective, sidecar: effective ? sidecarFromEntry(entry, d) : null, approved_origin: state.sidecar_proxy_consents[id] ?? null })
    }
    const records: Dict[] = []
    const authEnabled = await this.deps.isAuthEnabled()
    for (const [id, item] of byId) {
      const sidecar = item.sidecar as Dict | null
      if (!sidecar) continue
      const available = Boolean(item.effective_enabled) && counts.get(id) === 1
      const approved = item.approved_origin as string | null
      const proxy: Dict = { available, consented: available && approved === sidecar.origin, consent_required: available && approved !== sidecar.origin, path: `/api/extensions/${id}/sidecar/`, origin_changed: Boolean(available && approved && approved !== sidecar.origin) }
      if (sidecar.proxy_auth === 'token-v1') { proxy.proxy_auth = 'token-v1'; proxy.posture = available ? (authEnabled ? 'protected' : 'local_unprotected') : null }
      item.duplicate_id = (counts.get(id) ?? 0) > 1
      item.proxy = proxy
      if (records.length < MAX_URL_LIST) { const pub = { ...sidecar }; Reflect.deleteProperty(pub, 'proxy_auth'); records.push({ ...pub, proxy }) } else warn(d, 'sidecar_list_truncated', 'manifest:sidecars')
    }
    return { records, byId }
  }

  private assetUrl(value: unknown, base: string): string {
    if (typeof value !== 'string' || !value.trim()) return ''
    const item = value.trim()
    if (/^[a-z][a-z0-9+.-]*:/i.test(item) || item.startsWith('//') || item.startsWith('/')) return item
    const b = base.replace(/^\/+|\/+$/g, '')
    return EXTENSION_ROUTE_PREFIX + (b ? `${b}/${item}` : item)
  }

  private appendUrl(urls: string[], value: string, source: string, d: Diagnostics | null, dedupe: boolean): boolean {
    const v = value.trim()
    if (!v) return true
    if (!isSafeAssetUrl(v)) { warn(d, 'asset_url_rejected', source); return true }
    if (dedupe && urls.includes(v)) return true
    if (urls.length >= MAX_URL_LIST) { warn(d, 'asset_url_list_truncated', source); return false }
    urls.push(v)
    return true
  }

  private envUrls(envName: string, existing: string[] | null, d: Diagnostics | null): string[] {
    const urls = [...(existing ?? [])]
    for (const item of (this.deps.env[envName] ?? '').split(',')) if (!this.appendUrl(urls, item, envName, d, existing !== null)) break
    return urls
  }

  private async manifestUrls(manifest: unknown, status: Dict, disabled: Set<string>, state: State, d: Diagnostics | null): Promise<{ scripts: string[]; stylesheets: string[]; sidecars: Dict[] }> {
    const scripts: string[] = []
    const stylesheets: string[] = []
    const base = str(status._asset_base)
    const entries: Dict[] = []
    if (isDict(manifest)) entries.push(manifest)
    for (const e of manifestEntries(manifest)) { const id = entryText(e, 'id'); if (e.enabled !== false && !(validId(id) && disabled.has(id))) entries.push(e) }
    status.entry_count = entries.length
    let scriptsFull = false
    let stylesFull = false
    for (const entry of entries) {
      if (!scriptsFull) for (const v of Array.isArray(entry.scripts) ? entry.scripts : []) if (!this.appendUrl(scripts, this.assetUrl(v, base), 'manifest:scripts', d, true)) { scriptsFull = true; break }
      if (!stylesFull) for (const v of Array.isArray(entry.stylesheets) ? entry.stylesheets : []) if (!this.appendUrl(stylesheets, this.assetUrl(v, base), 'manifest:stylesheets', d, true)) { stylesFull = true; break }
    }
    const { records } = await this.sidecarRecords(manifest, disabled, state, d)
    Object.assign(status, { loaded: true, status: str(status.status) || 'loaded', script_count: scripts.length, stylesheet_count: stylesheets.length, sidecar_count: records.length })
    return { scripts, stylesheets, sidecars: records }
  }

  /** Python `get_extension_status`. */
  /** Python `get_extension_config()["enabled"]` for the bootstrap feature flag: a valid root with a loadable manifest. */
  /** Python `get_extension_config()["enabled"]`: true whenever the extension root directory exists (a manifest is optional). */
  enabledSync(): boolean {
    return this.root() !== null
  }

  async status(): Promise<Dict> {
    return (await this.snapshot()).status
  }

  /** The status payload plus the manifest it was built from, so `manifests()` reads the raw entries of the same load. */
  private async snapshot(): Promise<{ status: Dict; manifest: unknown; assetBase: string }> {
    const d: Diagnostics = { warnings: [] }
    const envDir = (this.deps.env.HERMES_WEBUI_EXTENSION_DIR ?? '').trim()
    const root = this.root()
    const state = this.loadState(d)
    const disabled = new Set(state.disabled_extensions)
    const manifestConfigured = Boolean((this.deps.env.HERMES_WEBUI_EXTENSION_MANIFEST ?? '').trim())
    if (envDir && !root) warn(d, 'extension_dir_unavailable', 'extension_dir')
    if (!root) {
      return { manifest: null, assetBase: '', status: { enabled: false, extension_dir_configured: true, extension_dir_valid: false, script_urls: [], stylesheet_urls: [], sidecars: [], counts: { script_urls: 0, stylesheet_urls: 0, sidecars: 0, manifest_extensions: 0, user_disabled: 0 }, manifest: { configured: manifestConfigured, loaded: false, status: manifestConfigured ? 'extension_disabled' : 'not_configured', entry_count: 0, script_count: 0, stylesheet_count: 0, sidecar_count: 0 }, extensions: [], warnings: d.warnings } }
    }
    const [manifest, status] = this.loadManifest(root, d)
    const consentIds = new Set(Object.keys(state.sidecar_proxy_consents))
    const ext = manifest !== null ? this.extensionState(manifest, disabled, d, consentIds) : { extensions: [], knownIds: new Set<string>(), manifestDisabled: new Set<string>() }
    const urls = manifest !== null ? await this.manifestUrls(manifest, status, disabled, state, d) : { scripts: [], stylesheets: [], sidecars: [] }
    const scriptUrls = this.envUrls('HERMES_WEBUI_EXTENSION_SCRIPT_URLS', urls.scripts.length ? urls.scripts : null, d)
    const stylesheetUrls = this.envUrls('HERMES_WEBUI_EXTENSION_STYLESHEET_URLS', urls.stylesheets.length ? urls.stylesheets : null, d)
    const publicStatus = Object.fromEntries(Object.entries(status).filter(([k]) => !k.startsWith('_')))
    return { manifest, assetBase: str(status._asset_base), status: {
      enabled: true, extension_dir_configured: true, extension_dir_valid: true, script_urls: scriptUrls, stylesheet_urls: stylesheetUrls, sidecars: urls.sidecars,
      counts: { script_urls: scriptUrls.length, stylesheet_urls: stylesheetUrls.length, sidecars: urls.sidecars.length, manifest_extensions: ext.extensions.length, user_disabled: [...disabled].filter((id) => ext.knownIds.has(id)).length },
      manifest: publicStatus, extensions: ext.extensions, gallery_installed: this.loadInstallManifest().installed, warnings: d.warnings,
    } }
  }

  private loaded(root: string, d: Diagnostics): { manifest: unknown; state: State; disabled: Set<string> } {
    const state = this.loadState(d)
    const [manifest, status] = this.loadManifest(root, d)
    if (manifest === null || status.loaded !== true) throw new ExtensionError('Extension manifest is not loaded', 409)
    return { manifest, state, disabled: new Set(state.disabled_extensions) }
  }

  private mutateState<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.stateLock.catch(() => undefined).then(fn)
    this.stateLock = run
    return run
  }

  setEnabled(idRaw: unknown, enabled: unknown): Promise<Dict> {
    if (!validId(idRaw)) throw new ExtensionError('Invalid extension id', 400)
    if (typeof enabled !== 'boolean') throw new ExtensionError('enabled must be a boolean', 400)
    return this.mutateState(async () => this.setEnabledLocked(idRaw.trim(), enabled))
  }

  private async setEnabledLocked(id: string, enabled: boolean): Promise<Dict> {
    const root = this.root()
    if (!root) throw new ExtensionError('Extensions are not configured', 404)
    const d: Diagnostics = { warnings: [] }
    const { manifest, state, disabled } = this.loaded(root, d)
    const ext = this.extensionState(manifest, disabled, d, new Set(Object.keys(state.sidecar_proxy_consents)))
    if (!ext.knownIds.has(id)) throw new ExtensionError('Extension not found', 404)
    if (ext.manifestDisabled.has(id)) throw new ExtensionError('Extension is disabled by its manifest', 409)
    if (enabled) disabled.delete(id); else disabled.add(id)
    this.writeState({ disabled_extensions: [...disabled], sidecar_proxy_consents: Object.fromEntries(Object.entries(state.sidecar_proxy_consents).filter(([k]) => ext.knownIds.has(k))) })
    return this.status()
  }

  setConsent(idRaw: unknown, approved: unknown): Promise<Dict> {
    if (!validId(idRaw)) throw new ExtensionError('Invalid extension id', 400)
    if (typeof approved !== 'boolean') throw new ExtensionError('approved must be a boolean', 400)
    return this.mutateState(() => this.setConsentLocked(idRaw.trim(), approved))
  }

  private async setConsentLocked(id: string, approved: boolean): Promise<Dict> {
    const root = this.root()
    if (!root) throw new ExtensionError('Extensions are not configured', 404)
    const d: Diagnostics = { warnings: [] }
    const { manifest, state, disabled } = this.loaded(root, d)
    const consents = { ...state.sidecar_proxy_consents }
    const ext = this.extensionState(manifest, disabled, d, new Set(Object.keys(consents)))
    if (!ext.knownIds.has(id)) throw new ExtensionError('Extension not found', 404)
    const { byId } = await this.sidecarRecords(manifest, disabled, state, d)
    const item = byId.get(id) ?? {}
    const sidecar = item.sidecar as Dict | null | undefined
    const proxy = (item.proxy ?? {}) as Dict
    if (approved) {
      if (!sidecar || proxy.available !== true) throw new ExtensionError('Extension sidecar proxy is unavailable', 409)
      if (sidecar.proxy_auth === 'token-v1') throw new ExtensionError('Sidecar token-v1 proxy auth is not available in this release.', 409)
      consents[id] = str(sidecar.origin)
    } else Reflect.deleteProperty(consents, id)
    this.writeState({ disabled_extensions: [...disabled], sidecar_proxy_consents: Object.fromEntries(Object.entries(consents).filter(([k]) => ext.knownIds.has(k))) })
    return this.status()
  }

  /** Python `resolve_extension_sidecar_proxy_target` (legacy proxy auth only). */
  async proxyTarget(idRaw: string, proxyPath: string, query: string): Promise<{ origin: string; upstream_url: string }> {
    if (!validId(idRaw)) throw new ExtensionError('Invalid extension id', 400)
    const normalized = normalizeProxyPath(proxyPath)
    if (normalized === null) throw new ExtensionError('Invalid sidecar proxy path', 400)
    const root = this.root()
    if (!root) throw new ExtensionError('Extensions are not configured', 404)
    const id = idRaw.trim()
    const d: Diagnostics = { warnings: [] }
    const { manifest, state, disabled } = this.loaded(root, d)
    const ext = this.extensionState(manifest, disabled, d, new Set(Object.keys(state.sidecar_proxy_consents)))
    if (!ext.knownIds.has(id)) throw new ExtensionError('Extension not found', 404)
    const { byId } = await this.sidecarRecords(manifest, disabled, state, d)
    const item = byId.get(id) ?? {}
    const sidecar = item.sidecar as Dict | null | undefined
    const proxy = (item.proxy ?? {}) as Dict
    if (!sidecar || proxy.available !== true) throw new ExtensionError('Extension sidecar proxy is unavailable', 409)
    if (proxy.consented !== true) throw new ExtensionError('Extension sidecar proxy consent required', 403)
    if (sidecar.proxy_auth === 'token-v1') throw new ExtensionError('Sidecar token-v1 proxy auth is not available in this release.', 403)
    const origin = str(sidecar.origin)
    return { origin, upstream_url: `${origin}${normalized}${query ? `?${query}` : ''}` }
  }

  /** Python `_build_gallery_opener` (`_AllowlistRedirectHandler`): redirects are followed only onto https gallery hosts. */
  private async galleryFetch(url: string, timeoutMs: number): Promise<Response> {
    let current = url
    let res = await this.deps.fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    for (let hop = 0; res.status >= 300 && res.status < 400 && hop < 3; hop += 1) {
      const location = res.headers.get('location') ?? ''
      let next: URL | null = null
      try { next = new URL(location, current) } catch { next = null }
      if (next?.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(next.hostname)) throw new ExtensionError('Download redirected to disallowed host')
      current = next.href
      res = await this.deps.fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    }
    return res
  }

  async registry(): Promise<{ entries: unknown[]; error?: string }> {
    const now = Date.now()
    if (this.registryCache && now - this.registryCache.at < REGISTRY_TTL_MS) return { entries: this.registryCache.entries }
    if (this.registryInflight) return this.registryCache ? { entries: this.registryCache.entries } : { entries: [], error: 'registry_unavailable' }
    this.registryInflight = (async () => {
      const res = await this.galleryFetch(REGISTRY_URL, 10_000)
      if (!res.ok) throw new Error(`registry ${String(res.status)}`)
      const raw = await readCapped(res, 2 * 1024 * 1024)
      if (!raw) throw new Error('registry too large')
      const data = JSON.parse(raw.toString('utf8')) as unknown
      const entries: unknown[] = Array.isArray(data) ? data : isDict(data) ? (Array.isArray(data.extensions) ? data.extensions : Array.isArray(data.entries) ? data.entries : []) : []
      this.registryCache = { at: now, entries }
      return entries
    })()
    try {
      return { entries: await this.registryInflight }
    } catch {
      return { entries: [], error: 'registry_unavailable' }
    } finally {
      this.registryInflight = null
    }
  }

  async install(idRaw: unknown, downloadUrl: unknown, sha256: unknown): Promise<{ installed: true; id: string; version: string }> {
    if (!validId(idRaw)) throw new ExtensionError('Invalid extension id')
    const id = idRaw.trim()
    if (typeof downloadUrl !== 'string' || !downloadUrl.startsWith('https://')) throw new ExtensionError('Invalid download URL')
    let host = ''
    try { host = new URL(downloadUrl).hostname } catch { host = '' }
    if (!ALLOWED_DOWNLOAD_HOSTS.has(host)) throw new ExtensionError('Invalid download URL')
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new ExtensionError('Invalid sha256')
    const root = this.writableRoot()
    if (!root) throw new ExtensionError('Extensions not configured', 404)
    let raw: Buffer
    try {
      const res = await this.galleryFetch(downloadUrl, 30_000)
      if (!res.ok) throw new Error(`download ${String(res.status)}`)
      const capped = await readCapped(res, MAX_ZIP_BYTES)
      if (!capped) throw new ExtensionError('Download too large')
      raw = capped
    } catch (error) {
      throw new ExtensionError(error instanceof ExtensionError ? error.message : 'Download failed', error instanceof ExtensionError ? error.status : 502)
    }
    if (createHash('sha256').update(raw).digest('hex') !== sha256) throw new ExtensionError('SHA-256 mismatch')
    let entries: ReturnType<typeof readZip>
    try { entries = readZip(raw) } catch { throw new ExtensionError('Invalid zip archive') }
    const files = entries.filter((e) => e.name && !e.isDir)
    if (files.reduce((acc, e) => acc + e.size, 0) > MAX_ZIP_BYTES * 10) throw new ExtensionError('Archive uncompressed size exceeds limit')
    if (files.length > 1024) throw new ExtensionError('Archive contains too many files')
    const prefix = files.every((e) => e.name.startsWith(`${id}/`)) ? `${id}/` : ''
    const stripped = (name: string): string => (prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name)
    const anchor = resolvePathLikePython(root)
    const extDir = resolve(anchor, id)
    for (const e of files) {
      const decoded = fullyUnquote(stripped(e.name))
      if (!decoded || !isSafeArchiveMember(decoded)) throw new ExtensionError('Unsafe archive member')
      const target = resolve(extDir, decoded)
      if (!target.startsWith(anchor + sep) || !target.startsWith(extDir + sep)) throw new ExtensionError('Zip-slip detected')
    }
    let version = 'unknown'
    for (const vfile of ['extension.json', 'manifest.json']) {
      const entry = entries.find((e) => e.name === prefix + vfile)
      if (!entry) continue
      try { const m = JSON.parse(entry.read().toString('utf8')) as unknown; if (isDict(m) && typeof m.version === 'string') { version = m.version; break } } catch { /* ignore */ }
    }
    try { if (lstatSync(extDir).isSymbolicLink()) throw new ExtensionError('Extension directory is a symlink', 400) } catch (error) { if (error instanceof ExtensionError) throw error }
    try { makeAnchoredDir(anchor, extDir) } catch { throw new ExtensionError('Extension directory is a symlink', 400) }
    const written: string[] = []
    const rollback = (): void => {
      for (const p of written) { try { unlinkAnchored(anchor, p) } catch { /* gone */ } }
      try { rmdirAnchored(anchor, extDir) } catch { /* not empty, or gone */ }
    }
    try {
      // Every destination is created or truncated through the anchored walk from the extension root, so a symlink
      // already inside the extension (or a parent swapped mid-extraction) can never redirect a write outside it.
      for (const e of files) {
        const dest = resolve(extDir, fullyUnquote(stripped(e.name)))
        let fd: number
        try { fd = openAnchoredCreateFd(anchor, dest) } catch (error) { if (!(error instanceof FileExistsError)) throw error; fd = openAnchoredWriteFd(anchor, dest) }
        try { writeFileSync(fd, e.read()) } finally { closeSync(fd) }
        written.push(dest)
      }
    } catch { rollback(); throw new ExtensionError('Extraction failed', 500) }
    try {
      const manifest = this.loadInstallManifest()
      const record = { version, files: written.map((p) => relative(extDir, p).split(sep).join('/')), installed_at: new Date().toISOString() }
      const next = { version: 1 as const, installed: { ...manifest.installed, [id]: record } }
      if (Buffer.byteLength(JSON.stringify(next, null, 2)) > MAX_INSTALL_MANIFEST_BYTES) throw new ExtensionError('Install manifest would exceed size limit')
      this.writeInstallManifest(next)
    } catch (error) {
      rollback()
      throw error instanceof ExtensionError ? error : new ExtensionError('Failed to record install', 500)
    }
    return { installed: true, id, version }
  }

  uninstall(idRaw: unknown): { uninstalled: true; id: string } {
    if (!validId(idRaw)) throw new ExtensionError('Invalid extension id')
    const id = idRaw.trim()
    const root = this.root()
    if (!root) throw new ExtensionError('Extensions not configured', 404)
    const manifest = this.loadInstallManifest()
    const entry = manifest.installed[id]
    if (!entry) throw new ExtensionError('Extension not installed', 404)
    const anchor = resolvePathLikePython(root)
    const extDir = resolve(anchor, id)
    for (const rel of entry.files) {
      if (!isSafeArchiveMember(rel)) continue
      const target = resolve(extDir, rel)
      if (!target.startsWith(extDir + sep)) continue
      try { unlinkAnchored(anchor, target) } catch { /* gone */ }
    }
    // Prune now-empty directories, enumerating and removing each through the anchored walk so a directory replaced by
    // a symlink is skipped rather than followed into its target.
    const prune = (dir: string): void => {
      let subdirs: string[]
      try { subdirs = withAnchoredDir(anchor, dir, (child) => readdirSync(child('.'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) } catch { return }
      for (const name of subdirs) prune(join(dir, name))
      try { rmdirAnchored(anchor, dir) } catch { /* not empty, or gone */ }
    }
    prune(extDir)
    Reflect.deleteProperty(manifest.installed, id)
    this.writeInstallManifest(manifest)
    return { uninstalled: true, id }
  }

  /** Python `serve_extension_static`: bytes, MIME, sandbox CSP for HTML; null means 404. */
  staticFile(rel: string): { body: Buffer; contentType: string; html: boolean } | null {
    const root = this.root()
    const found = root ? readContainedFile(root, rel) : null
    if (!found) return null
    const ext = found.file.slice(found.file.lastIndexOf('.') + 1).toLowerCase()
    const ct = EXTENSION_MIME[ext] ?? 'text/plain'
    return { body: found.body, contentType: TEXT_MIME.has(ct) ? `${ct}; charset=utf-8` : ct, html: ct === 'text/html' }
  }

  /** Python `api/extension_manifests.build_manifests` extension entries (the manifests route appends dashboard plugins). */
  async manifests(): Promise<{ protocol_version: 1; manifests: Dict[] }> {
    const { status, manifest, assetBase } = await this.snapshot()
    // Status rows carry only enable state; panel, nav, capabilities, assets, and metadata come from the first manifest entry per id.
    const rawById = new Map<string, Dict>()
    for (const e of manifestEntries(manifest)) { const id = entryText(e, 'id'); if (!rawById.has(id)) rawById.set(id, e) }
    // Gallery rows are the entries the gallery loader read from their own install folder; `uninstall` accepts exactly the
    // ids in the install manifest, so a configured entry that shares an installed id never offers Uninstall.
    const installed = isDict(status.gallery_installed) ? status.gallery_installed : {}
    const manifests: Dict[] = []
    const seen = new Set<string>()
    const ID = /^[a-z][a-z0-9_-]{0,63}$/
    for (const entry of status.extensions as Dict[]) {
      const id = text(entry.id, 64)
      if (!ID.test(id) || seen.has(id)) continue
      seen.add(id)
      const rawManifest = rawById.get(str(entry.id)) ?? {}
      const warnings: string[] = []
      let panel: string | null = null
      const rawPanel = rawManifest.panel
      if (rawPanel !== null && rawPanel !== undefined) {
        // Like scripts, a panel path is relative to the manifest's folder; gallery entries were rebased onto `<id>/`.
        const url = typeof rawPanel === 'string' ? `extensions/${assetBase ? `${assetBase}/` : ''}${rawPanel.replace(/^(\.\/)+/, '')}` : ''
        if (typeof rawPanel !== 'string' || !/^[A-Za-z0-9._/-]{1,300}$/.test(rawPanel) || !isSafeRelativePath(url) || url.length > 400) warnings.push('panel_path_rejected')
        else if (!rawPanel.toLowerCase().endsWith('.html')) warnings.push('panel_not_html')
        else panel = url
      }
      const scripts = Array.isArray(rawManifest.scripts) ? rawManifest.scripts : []
      const stylesheets = Array.isArray(rawManifest.stylesheets) ? rawManifest.stylesheets : []
      const legacy = Boolean((scripts.length || stylesheets.length) && !panel)
      const rawNav = isDict(rawManifest.nav) ? rawManifest.nav : {}
      const nav = panel ? { label: text(rawNav.label, 40) || text(entry.name, 40) || id, ...(text(rawNav.icon, 40) ? { icon: text(rawNav.icon, 40) } : {}) } : null
      const permissions = isDict(rawManifest.permissions) ? Object.fromEntries(Object.entries(rawManifest.permissions).filter(([k]) => k.length <= 64).map(([k, v]) => [k, Boolean(v)])) : {}
      const caps = (Array.isArray(rawManifest.capabilities) ? rawManifest.capabilities : []).filter((c): c is string => typeof c === 'string' && ['settings', 'storage', 'sidecar', 'lifecycle', 'theme', 'tts', 'navigate', 'toast', 'session'].includes(c))
      manifests.push({ id, name: text(entry.name, 80) || id, version: text(rawManifest.version, 40), description: text(rawManifest.description, 300), source: galleryFolders.get(rawManifest) === id && Object.hasOwn(installed, id) ? 'gallery' : 'manifest', enabled: entry.effective_enabled === true && !legacy, can_toggle: entry.can_toggle !== false && !legacy, panel, nav, capabilities: [...new Set(caps)], permissions, settings_schema: Array.isArray(entry.settings_schema) ? entry.settings_schema : [], theme: null, tts: null, sidecar: null, legacy_injection: legacy, warnings })
    }
    return { protocol_version: 1, manifests }
  }
}
