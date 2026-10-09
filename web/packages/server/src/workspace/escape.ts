/**
 * Read-only escape grants (Python `workspace.py` `authorize_escape_target` and friends, TAL-263): a workspace symlink
 * whose target sits outside the workspace opens through a short-lived token scoped to that one link. A directory
 * target anchors the grant at the target; a file target anchors it at the parent with the file as the only reachable
 * entry. Every use re-checks the link, and every read stays anchored at the grant root, so nested escaping links stay
 * display-only.
 */
import { randomBytes } from 'node:crypto'
import { lstatSync, statSync } from 'node:fs'
import { basename, dirname, join, posix, relative } from 'node:path'
import { stripSurroundingQuotes, isBlockedSystemPath } from './workspaces.js'
import { isWithin, resolvePathLikePython } from './paths.js'
import { dirSignature, listDir, NotFoundError, PathTraversalError, safeResolveWs, withPinnedRoot, type DirEntry } from './fs.js'
import { readFilePreview, type FilePreview } from './preview.js'

export const ESCAPE_GRANT_TTL_SECONDS = 300

/** Any failed re-check: the client asks for a new grant (403). */
export class EscapeGrantExpired extends Error {
  constructor() { super('Escape authorization expired') }
}

interface EscapeGrant {
  sessionId: string
  profile: string | null
  workspaceRoot: string
  surfacePath: string
  externalRoot: string
  /** The grant root's inode at mint: a root swapped after the per-use re-check fails closed. */
  rootId: RootId
  externalEntryRel: string
  surfaceTarget: string
  expiresAt: number
}

interface RootId { dev: number; ino: number }

export interface EscapeRequest { surfacePath: string; requestPath: string; externalRoot: string; rootId: RootId; externalRel: string }

/** Run `fn` with every anchored open of the grant root held to the inode the grant was minted for. */
export function anchoredAt<T>(req: EscapeRequest, fn: () => T): T {
  return withPinnedRoot(req.externalRoot, req.rootId, fn)
}

/** Python `_normalize_workspace_rel_path`: POSIX-normalised and workspace-relative; `..` and absolute paths fail. */
export function normalizeWorkspaceRelPath(rel: string): string {
  const raw = stripSurroundingQuotes(rel).trim().replaceAll('\\', '/')
  if (!raw || raw === '.') return '.'
  const norm = posix.normalize(raw).replace(/(.)\/+$/, '$1')
  if (norm === '.') return '.'
  if (norm === '..' || norm.startsWith('../') || norm.startsWith('/')) throw new PathTraversalError(`Path traversal blocked: ${rel}`)
  return norm
}

function virtualPath(root: string, rel: string): string {
  if (root === '.') return rel
  return rel === '.' ? root : `${root}/${rel}`
}

/** Python `_escape_surface_target`: the resolved target of an escaping, reachable, non-system workspace symlink. */
function surfaceTarget(workspaceRoot: string, rel: string): string {
  const surfaceRel = normalizeWorkspaceRelPath(rel)
  const parentRel = posix.dirname(surfaceRel)
  const parent = parentRel === '.' ? workspaceRoot : safeResolveWs(workspaceRoot, parentRel)
  const surface = join(parent, posix.basename(surfaceRel))
  let isLink = false
  try { isLink = lstatSync(surface).isSymbolicLink() } catch { /* missing */ }
  if (!isLink) throw new NotFoundError(`Path is not an escape-target symlink: ${rel}`)
  let target: string
  try {
    target = resolvePathLikePython(surface)
    statSync(target)
  } catch {
    throw new NotFoundError(`Path is no longer reachable: ${rel}`)
  }
  if (isWithin(target, workspaceRoot)) throw new NotFoundError(`Path does not escape workspace: ${rel}`)
  if (isBlockedSystemPath(target)) throw new NotFoundError(`Path points to a system directory: ${target}`)
  return target
}

export class EscapeGrants {
  private readonly grants = new Map<string, EscapeGrant>()

  constructor(private readonly now: () => number) {}

  /** Mint a grant for one surfaced escape-target symlink. */
  authorize(workspace: string, sessionId: string, profile: string | null, rel: string): { token: string; path: string; is_dir: boolean; expires_at: number; expires_in: number; read_only: true } {
    const workspaceRoot = resolvePathLikePython(workspace)
    const target = surfaceTarget(workspaceRoot, rel)
    const isDir = statSync(target).isDirectory()
    const externalRoot = isDir ? target : dirname(target)
    const { dev, ino } = statSync(externalRoot)
    const token = randomBytes(24).toString('base64url')
    const expiresAt = this.now() + ESCAPE_GRANT_TTL_SECONDS
    const surfacePath = normalizeWorkspaceRelPath(rel)
    this.prune()
    this.grants.set(token, { sessionId, profile, workspaceRoot, surfacePath, externalRoot, rootId: { dev, ino }, externalEntryRel: isDir ? '.' : basename(target), surfaceTarget: target, expiresAt })
    return { token, path: surfacePath, is_dir: isDir, expires_at: expiresAt, expires_in: ESCAPE_GRANT_TTL_SECONDS, read_only: true }
  }

  /**
   * Python `resolve_authorized_escape_request`: re-check the grant, then re-root a request path under the link onto
   * the grant root. A path outside the link answers "Path traversal blocked".
   */
  resolve(workspace: string, sessionId: string, profile: string | null, token: string, rel: string): EscapeRequest {
    const grant = this.check(workspace, sessionId, profile, token)
    const requestPath = normalizeWorkspaceRelPath(rel)
    const under = grant.surfacePath === '.' ? requestPath : requestPath === grant.surfacePath ? '.' : requestPath.startsWith(`${grant.surfacePath}/`) ? requestPath.slice(grant.surfacePath.length + 1) : null
    if (under === null) throw new PathTraversalError(`Path traversal blocked: ${rel}`)
    const externalRel = grant.externalEntryRel === '.' ? under : under === '.' ? grant.externalEntryRel : `${grant.externalEntryRel}/${under}`
    return { surfacePath: grant.surfacePath, requestPath, externalRoot: grant.externalRoot, rootId: grant.rootId, externalRel }
  }

  /** Python `list_authorized_escape_dir`: entries re-pathed under the link; a target outside the grant root is dropped. */
  list(req: EscapeRequest): { path: string; entries: (DirEntry & { escape_read_only: true })[]; signature: string; virtual_root: string; read_only: true } {
    const entries = anchoredAt(req, () => listDir(req.externalRoot, req.externalRel)).map((entry) => {
      const out: DirEntry & { escape_read_only: true } = { ...entry, path: virtualPath(req.surfacePath, entry.path), escape_read_only: true }
      if (entry.target === undefined) return out
      delete out.target
      if (isWithin(entry.target, req.externalRoot)) out.target = virtualPath(req.surfacePath, relative(req.externalRoot, entry.target) || '.')
      return out
    })
    return { path: req.requestPath, entries, signature: dirSignature(req.externalRoot, req.externalRel, entries), virtual_root: req.surfacePath, read_only: true }
  }

  /** Python `read_authorized_escape_file_content`, with the `/api/file` preview kind. */
  read(req: EscapeRequest): FilePreview & { escape_read_only: true } {
    return { ...anchoredAt(req, () => readFilePreview(req.externalRoot, req.externalRel)), path: req.requestPath, escape_read_only: true }
  }

  /** Python `raw_authorized_escape_target`: the file to serve, anchored at the grant root. */
  rawTarget(req: EscapeRequest): string {
    return safeResolveWs(req.externalRoot, req.externalRel)
  }

  /** Python `_escape_authorization_record`: the link must still escape to the same reachable, non-system target and root inode. */
  private check(workspace: string, sessionId: string, profile: string | null, token: string): EscapeGrant {
    this.prune()
    const grant = this.grants.get(token)
    if (grant?.sessionId !== sessionId || grant.profile !== profile || grant.workspaceRoot !== resolvePathLikePython(workspace)) throw new EscapeGrantExpired()
    try {
      if (surfaceTarget(grant.workspaceRoot, grant.surfacePath) !== grant.surfaceTarget) throw new EscapeGrantExpired()
      const root = statSync(grant.externalRoot)
      if (root.dev !== grant.rootId.dev || root.ino !== grant.rootId.ino) throw new EscapeGrantExpired()
    } catch {
      // A retargeted link kills the grant for good, even if it later points back.
      this.grants.delete(token)
      throw new EscapeGrantExpired()
    }
    return grant
  }

  private prune(): void {
    const now = this.now()
    for (const [token, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(token)
  }
}
