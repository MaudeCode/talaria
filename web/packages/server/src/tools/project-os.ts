/**
 * Project OS dashboard (Python `_handle_project_os_dashboard`): finds the repo for the last workspace or a kanban board,
 * then reads its `.ax` handoff/status JSON and `docs/project-os` Markdown through the workspace file reader.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectOsDashboard } from '@maudecode/talaria-web-contracts'
import type { Dict } from '../config/agent-config.js'
import { readFileContent, type FileContent } from '../workspace/fs.js'
import { expandHome, resolvePathLikePython } from '../workspace/paths.js'
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
const SUMMARY_MAX = 220

/** Python `str(value or "").strip()`. */
const text = (v: unknown): string => (v ? str(v) : '').trim()
const isDict = (v: unknown): v is Dict => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const isDir = (path: string): boolean => { try { return statSync(path).isDirectory() } catch { return false } }
/** A `readFileContent` payload, widened to the contract's loose file object. */
type Doc = FileContent & Dict
const clip = (value: string): string => Array.from(value).slice(0, SUMMARY_MAX).join('')

function readDoc(root: string, rel: string): Doc | null {
  try { return { ...readFileContent(root, rel) } } catch { return null }
}

function readJson(root: string, rel: string): Dict | null {
  const doc = readDoc(root, rel)
  if (typeof doc?.content !== 'string') return null
  try { const parsed: unknown = JSON.parse(doc.content); return isDict(parsed) ? parsed : null } catch { return null }
}

/** Every board id, slug, or name the repo's `.ax` truth files claim. */
function truthBoardSlugs(root: string): Set<string> {
  const slugs = new Set<string>()
  const add = (v: unknown): void => { const t = text(v); if (t) slugs.add(t) }
  for (const rel of TRUTH_FILES) {
    const truth = readJson(root, rel)
    if (!truth) continue
    if (isDict(truth.board)) for (const key of ['slug', 'id', 'name', 'display_name']) add(truth.board[key])
    else add(truth.board)
    for (const key of TRUTH_BOARD_KEYS) add(truth[key])
  }
  return slugs
}

const repoMatchesBoard = (root: string, slug: string): boolean => Boolean(slug) && truthBoardSlugs(root).has(slug)

/** The workspace, every `.ax` or `docs/project-os` directory found breadth-first beneath it, then the server's cwd. */
function candidateRepoRoots(workspaceRoot: string | null, cwd: string): string[] {
  const candidates: string[] = []
  const add = (path: string): void => {
    const resolved = resolvePathLikePython(path)
    if (isDir(resolved) && !candidates.includes(resolved)) candidates.push(resolved)
  }
  if (workspaceRoot === null) return candidates
  add(workspaceRoot)
  const scanRoot = resolvePathLikePython(workspaceRoot)
  if (!isDir(scanRoot)) return candidates
  const queue: [string, number][] = [[scanRoot, 0]]
  let inspected = 0
  while (queue.length && inspected < SCAN_MAX_DIRS) {
    const [current, depth] = queue.shift()!
    inspected += 1
    if (isDir(join(current, '.ax')) || isDir(join(current, 'docs', 'project-os'))) add(current)
    if (depth >= SCAN_MAX_DEPTH) continue
    let names: string[]
    try { names = readdirSync(current).filter((name) => isDir(join(current, name))).sort() } catch { continue }
    for (const name of names) {
      if (SCAN_SKIP.has(name) || (name.startsWith('.') && name !== '.ax')) continue
      queue.push([join(current, name), depth + 1])
    }
  }
  add(cwd)
  return candidates
}

function resolveRepoRootForBoard(repoRoot: string | null, slug: string, cwd: string): string | null {
  const existing = repoRoot !== null && existsSync(repoRoot) ? repoRoot : null
  if (!slug) return existing
  if (existing !== null && repoMatchesBoard(existing, slug)) return existing
  return candidateRepoRoots(repoRoot, cwd).find((candidate) => repoMatchesBoard(candidate, slug)) ?? existing
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
function onboardingContext(root: string, project: Doc | null, plan: Doc | null, status: Doc | null): Dict {
  const texts = [project, plan, status].map((doc) => str(doc?.content))
  const merged = texts.join('\n')
  const nonGit = !existsSync(join(root, '.git'))
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

function readRepo(root: string): { handoff: Dict | null; active: Dict | null; heartbeat: Dict | null; docs: Record<'project' | 'plan' | 'status' | 'blocker_resolver', Doc | null>; onboarding: Dict } {
  const docs = {
    project: readDoc(root, 'docs/project-os/PROJECT.md'),
    plan: readDoc(root, 'docs/project-os/PLAN.md'),
    status: readDoc(root, 'docs/project-os/STATUS.md'),
    blocker_resolver: readDoc(root, 'docs/project-os/BLOCKER-RESOLVER.md'),
  }
  const rootProject = readDoc(root, 'PROJECT.md')
  const rootPlan = readDoc(root, 'PLAN.md')
  const rootStatus = readDoc(root, 'STATUS.md')
  const onboarding = onboardingContext(root, rootProject, rootPlan, rootStatus)
  if (onboarding.active === true) {
    docs.project = rootProject ?? docs.project
    docs.plan = rootPlan ?? docs.plan
    docs.status = rootStatus ?? docs.status
  }
  return { handoff: readJson(root, '.ax/handoff/current.json'), active: readJson(root, '.ax/status/active.json'), heartbeat: readJson(root, '.ax/status/heartbeat.json'), docs, onboarding }
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
      if (workdir && existsSync(expandHome(workdir))) repoRoot = expandHome(workdir)
    } catch {
      selected = null
    }
  }
  repoRoot = resolveRepoRootForBoard(repoRoot, board, deps.cwd)
  if (repoRoot === null) return EMPTY
  let repo = readRepo(repoRoot)
  // `.ax/status/active.json` may point at the real repo root; read everything again from there.
  const activeRoot = text(repo.active?.repo_root)
  if (activeRoot && existsSync(expandHome(activeRoot))) {
    const moved = resolvePathLikePython(activeRoot)
    if (moved !== repoRoot) { repoRoot = moved; repo = readRepo(repoRoot) }
  }
  let git: ProjectOsDashboard['git'] = null
  try { git = await deps.git(repoRoot) } catch { git = null }
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
    workspace: repoRoot,
    repo_root: repoRoot,
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
