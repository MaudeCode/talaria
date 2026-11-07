/**
 * Project OS dashboard (Python `_handle_project_os_dashboard`): finds the repo for the last workspace or a kanban board,
 * then reads its `.ax` handoff/status JSON and `docs/project-os` Markdown through the workspace file reader.
 */
import { access, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ProjectOsDashboard } from '@maudecode/talaria-web-contracts'
import type { Dict } from '../config/agent-config.js'
import { statSignatureAsync } from '../fs/stat.js'
import { readFileContentAsync, type FileContent } from '../workspace/fs.js'
import { expandHome, resolvePathLikePythonAsync } from '../workspace/paths.js'
import { str } from '../util.js'

export interface ProjectOsDeps {
  localIo: boolean
  lastWorkspace: string
  /** Kanban board metadata, archived boards included. */
  boards: () => Promise<Dict[]>
  git: (repoRoot: string) => Promise<ProjectOsDashboard['git']>
  cwd: string
}

const EMPTY: ProjectOsDashboard = { workspace: null, repo_root: null, git: null, docs: {}, handoff: null, active: null, heartbeat: null, goal_summary: '' }
const TRUTH_FILES = ['.ax/handoff/current.json', '.ax/status/active.json', '.ax/status/heartbeat.json']
const TRUTH_BOARD_KEYS = ['selected_board_slug', 'canonical_backlog_board_id', 'current_browser_board_id', 'active_proof_board_id', 'recover_board_id']
const SCAN_SKIP = new Set(['.git', '.hg', '.svn', '.venv', '__pycache__', 'node_modules', 'vendor', 'dist', 'build'])
const SCAN_MAX_DIRS = 300
const SCAN_MAX_DEPTH = 3
const SCAN_TTL_MS = 5_000
const SCAN_CACHE_LIMIT = 32
const SUMMARY_MAX = 220

/** Python `str(value or "").strip()`. */
const text = (v: unknown): string => (v ? str(v) : '').trim()
const isDict = (v: unknown): v is Dict => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const isDir = async (path: string): Promise<boolean> => { try { return (await stat(path)).isDirectory() } catch { return false } }
const exists = async (path: string): Promise<boolean> => { try { await access(path); return true } catch { return false } }
/** A `readFileContent` payload, widened to the contract's loose file object. */
type Doc = FileContent & Dict
const clip = (value: string): string => Array.from(value).slice(0, SUMMARY_MAX).join('')

/**
 * A repo root and the directory its reads are anchored to. A repo found by the workspace scan reads through the
 * workspace, so a directory swapped for a symlink after the scan listed it cannot lead a read out of the workspace.
 */
interface Repo { path: string; anchor: string; rel: string }
const ownRoot = (path: string): Repo => ({ path, anchor: path, rel: '' })

async function readDoc(repo: Repo, file: string): Promise<Doc | null> {
  try { return { ...await readFileContentAsync(repo.anchor, repo.rel ? `${repo.rel}/${file}` : file), path: file } } catch { return null }
}

async function readJson(repo: Repo, file: string): Promise<Dict | null> {
  const doc = await readDoc(repo, file)
  if (typeof doc?.content !== 'string') return null
  try { const parsed: unknown = JSON.parse(doc.content); return isDict(parsed) ? parsed : null } catch { return null }
}

/** Every board id, slug, or name the repo's `.ax` truth files claim. */
async function truthBoardSlugs(repo: Repo): Promise<Set<string>> {
  const slugs = new Set<string>()
  const add = (v: unknown): void => { const t = text(v); if (t) slugs.add(t) }
  for (const rel of TRUTH_FILES) {
    const truth = await readJson(repo, rel)
    if (!truth) continue
    if (isDict(truth.board)) for (const key of ['slug', 'id', 'name', 'display_name']) add(truth.board[key])
    else add(truth.board)
    for (const key of TRUTH_BOARD_KEYS) add(truth[key])
  }
  return slugs
}

const repoMatchesBoard = async (repo: Repo, slug: string): Promise<boolean> => Boolean(slug) && (await truthBoardSlugs(repo)).has(slug)

/** The workspace, every `.ax` or `docs/project-os` directory found breadth-first beneath it (symlinks not followed), then the server's cwd. */
async function scanRepoRoots(scanRoot: string, cwd: string): Promise<Repo[]> {
  const candidates: Repo[] = []
  const add = async (repo: Repo): Promise<void> => {
    if (!candidates.some((c) => c.path === repo.path) && await isDir(repo.path)) candidates.push(repo)
  }
  await add(ownRoot(scanRoot))
  if (!await isDir(scanRoot)) return candidates
  // Queued as paths relative to the scan root; each found repo reads through it.
  const queue: [string, number][] = [['', 0]]
  let inspected = 0
  while (queue.length && inspected < SCAN_MAX_DIRS) {
    const [rel, depth] = queue.shift()!
    const current = rel ? join(scanRoot, rel) : scanRoot
    inspected += 1
    if (await isDir(join(current, '.ax')) || await isDir(join(current, 'docs', 'project-os'))) await add({ path: current, anchor: scanRoot, rel })
    if (depth >= SCAN_MAX_DEPTH) continue
    let names: string[]
    // Real directories only: a directory symlink could lead the scan, and every later read, out of the workspace.
    try { names = (await readdir(current, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() } catch { continue }
    for (const name of names) {
      if (SCAN_SKIP.has(name) || (name.startsWith('.') && name !== '.ax')) continue
      queue.push([rel ? `${rel}/${name}` : name, depth + 1])
    }
  }
  await add(ownRoot(await resolvePathLikePythonAsync(cwd)))
  return candidates
}

const scans = new Map<string, { signature: string | null; expiresAt: number; repos: Repo[] }>()

/**
 * The scan above, reused for 5 s while the scan root's stat signature holds. A nested repo appearing in that window
 * waits for the expiry. Boards share the entry because the scan does not depend on the board; the truth files that
 * match a board are still read on every request, and every read still proves containment.
 */
async function candidateRepoRoots(workspaceRoot: string | null, cwd: string): Promise<Repo[]> {
  if (workspaceRoot === null) return []
  const scanRoot = await resolvePathLikePythonAsync(workspaceRoot)
  const key = `${scanRoot}\0${cwd}`
  const signature = await statSignatureAsync(scanRoot)
  const now = Date.now()
  const hit = scans.get(key)
  if (hit?.signature === signature && now < hit.expiresAt) return hit.repos
  const repos = await scanRepoRoots(scanRoot, cwd)
  if (scans.size >= SCAN_CACHE_LIMIT) scans.clear()
  scans.set(key, { signature, expiresAt: now + SCAN_TTL_MS, repos })
  return repos
}

async function resolveRepoRootForBoard(repoRoot: string | null, slug: string, cwd: string): Promise<Repo | null> {
  const existing = repoRoot !== null && await exists(repoRoot) ? ownRoot(repoRoot) : null
  if (!slug) return existing
  if (existing !== null && await repoMatchesBoard(existing, slug)) return existing
  for (const candidate of await candidateRepoRoots(repoRoot, cwd)) if (await repoMatchesBoard(candidate, slug)) return candidate
  return existing
}

function firstContentLine(doc: Doc | null): string {
  for (const line of str(doc?.content).split(/\r\n|\r|\n/)) {
    const t = line.trim().replace(/^[- ]+/, '').trim()
    if (t && !t.startsWith('#')) return clip(t)
  }
  return ''
}

function goalSummary(project: Doc | null, handoff: Dict | null, status: Doc | null, boardName: unknown, boardDesc: unknown): string {
  return firstContentLine(project) || clip(text(handoff?.goal_summary)) || clip(text(boardDesc)) || firstContentLine(status) || clip((boardName ? str(boardName) : 'Project OS').trim())
}

/** Python `_project_os_onboarding_context`, Korean copy included: a non-git workspace whose root carries the Project OS docs. */
async function onboardingContext(root: string, project: Doc | null, plan: Doc | null, status: Doc | null): Promise<Dict> {
  const texts = [project, plan, status].map((doc) => str(doc?.content))
  const merged = texts.join('\n')
  const nonGit = !await exists(join(root, '.git'))
  if (!(nonGit && texts.some(Boolean))) return { active: false, doc_source: 'project-os' }
  const hold = merged.includes('TO_BE_VALIDATED_BY_HERMES')
  const childBlocked = ['auto-promoted', 'auto-adopted', 'auto-adoption | `금지`', '자동 승격 금지', 'canonical repo continuity로 승격하지 않습니다'].some((marker) => merged.includes(marker))
  const rootConfirmed = merged.includes(root)
  return {
    active: true,
    doc_source: 'root',
    status_label: hold ? '보류(안전)' : '확인됨',
    summary: hold
      ? 'workspace root onboarding 진행 중 · 저장소 경계는 아직 미확정이며 TO_BE_VALIDATED_BY_HERMES 상태를 유지합니다.'
      : 'workspace root onboarding 진행 중 · 저장소 경계는 아직 미확정이며 자동 승격은 금지됩니다.',
    next_safe_action: 'workspace-root 기준으로 경계만 좁게 검증',
    workspace_root_confirmed: rootConfirmed,
    repo_boundary_status: hold ? 'TO_BE_VALIDATED_BY_HERMES' : 'confirmed',
    child_repo_auto_promotion_blocked: childBlocked,
    guardrails: [
      rootConfirmed ? 'workspace root 확인됨' : 'workspace root 확인 필요',
      childBlocked ? 'child repo 자동 승격 금지 유지' : 'child repo guardrail 확인 필요',
      hold ? 'repo boundary 미확정 유지' : 'repo boundary confirmed',
    ],
  }
}

/**
 * The repo `active.json` names. A target inside the current anchor keeps reading through that anchor, compared by
 * path rather than re-resolved, so a directory swapped for a symlink in between cannot move the reads out of it.
 * Any other target is the explicit external root Python followed.
 */
async function redirect(from: Repo, target: string): Promise<Repo> {
  const rel = relative(from.anchor, resolve(expandHome(target))).split(sep).join('/')
  if (rel === '') return ownRoot(from.anchor)
  if (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)) return { path: join(from.anchor, rel), anchor: from.anchor, rel }
  return ownRoot(await resolvePathLikePythonAsync(target))
}

/** The repo's real directory for a git lookup: null when a repo read through an anchor has been moved out of it. */
async function pinnedDir(repo: Repo): Promise<string | null> {
  if (!repo.rel) return repo.path
  try {
    const anchor = await realpath(repo.anchor)
    const real = await realpath(repo.path)
    return real.startsWith(anchor + sep) ? real : null
  } catch { return null }
}

async function readRepo(repo: Repo): Promise<{ handoff: Dict | null; active: Dict | null; heartbeat: Dict | null; docs: Record<'project' | 'plan' | 'status' | 'blocker_resolver', Doc | null>; onboarding: Dict }> {
  const docs = {
    project: await readDoc(repo, 'docs/project-os/PROJECT.md'),
    plan: await readDoc(repo, 'docs/project-os/PLAN.md'),
    status: await readDoc(repo, 'docs/project-os/STATUS.md'),
    blocker_resolver: await readDoc(repo, 'docs/project-os/BLOCKER-RESOLVER.md'),
  }
  const rootProject = await readDoc(repo, 'PROJECT.md')
  const rootPlan = await readDoc(repo, 'PLAN.md')
  const rootStatus = await readDoc(repo, 'STATUS.md')
  const onboarding = await onboardingContext(repo.path, rootProject, rootPlan, rootStatus)
  if (onboarding.active === true) {
    docs.project = rootProject ?? docs.project
    docs.plan = rootPlan ?? docs.plan
    docs.status = rootStatus ?? docs.status
  }
  return { handoff: await readJson(repo, '.ax/handoff/current.json'), active: await readJson(repo, '.ax/status/active.json'), heartbeat: await readJson(repo, '.ax/status/heartbeat.json'), docs, onboarding }
}

export async function projectOsDashboard(requestedBoard: string, deps: ProjectOsDeps): Promise<ProjectOsDashboard> {
  const board = requestedBoard.trim()
  if (!deps.localIo) return EMPTY
  const workspace = deps.lastWorkspace.trim()
  let repoRoot: string | null = workspace ? expandHome(workspace) : null
  let selected: Dict | null = null
  if (board) {
    try {
      selected = (await deps.boards()).find((meta) => str(meta.slug) === board) ?? null
      const workdir = text(selected?.default_workdir)
      if (workdir && await exists(expandHome(workdir))) repoRoot = expandHome(workdir)
    } catch {
      selected = null
    }
  }
  let found = await resolveRepoRootForBoard(repoRoot, board, deps.cwd)
  if (found === null) return EMPTY
  let repo = await readRepo(found)
  // `.ax/status/active.json` may point at the real repo root; read everything again from there.
  const activeRoot = text(repo.active?.repo_root)
  if (activeRoot && await exists(expandHome(activeRoot))) {
    const moved = await redirect(found, activeRoot)
    if (moved.path !== found.path) { found = moved; repo = await readRepo(found) }
  }
  let git: ProjectOsDashboard['git'] = null
  const dir = await pinnedDir(found)
  if (dir !== null) {
    try {
      const badge = await deps.git(dir)
      // A repo that left its anchor while git ran reports no badge.
      git = await pinnedDir(found) === dir ? badge : null
    } catch { git = null }
  }
  let boardName: unknown = null
  let boardDesc: unknown = null
  if (repo.handoff) {
    const handoffBoard = isDict(repo.handoff.board) ? repo.handoff.board : {}
    boardName = handoffBoard.display_name || handoffBoard.name || handoffBoard.slug
    boardDesc = repo.handoff.goal_summary || handoffBoard.repo_corroboration
  }
  if (selected) {
    boardName = boardName || selected.name || selected.slug
    boardDesc = boardDesc || selected.description
  }
  return {
    workspace: found.path,
    repo_root: found.path,
    selected_board_slug: board || null,
    git,
    docs: repo.docs,
    handoff: repo.handoff,
    active: repo.active,
    heartbeat: repo.heartbeat,
    onboarding: repo.onboarding as ProjectOsDashboard['onboarding'],
    goal_summary: goalSummary(repo.docs.project, repo.handoff, repo.docs.status, boardName, boardDesc),
  }
}
