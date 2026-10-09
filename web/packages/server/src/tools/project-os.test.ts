import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Dict } from '../config/agent-config.js'
import { projectOsDashboard, type ProjectOsDeps } from './project-os.js'

// Runs once right after `readdirSync` lists `dir`, so a test can swap a listed directory before the scan dequeues it.
const afterListing = vi.hoisted(() => ({ dir: '', run: null as null | (() => void) }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const readdirSync = ((...args: Parameters<typeof fs.readdirSync>) => {
    const listed = fs.readdirSync(...args)
    if (afterListing.run && String(args[0]) === afterListing.dir) { const run = afterListing.run; afterListing.run = null; run() }
    return listed
  }) as typeof fs.readdirSync
  return { ...fs, default: { ...fs, readdirSync }, readdirSync }
})

const EMPTY = { workspace: null, repo_root: null, git: null, docs: {}, handoff: null, active: null, heartbeat: null, goal_summary: '' }

describe('project-os dashboard (TAL-266)', () => {
  let root: string
  const write = (rel: string, body: unknown): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), typeof body === 'string' ? body : JSON.stringify(body))
  }
  const deps = (over: Partial<ProjectOsDeps> = {}): ProjectOsDeps => ({ localIo: true, lastWorkspace: root, boards: () => Promise.resolve([]), git: () => Promise.resolve(null), cwd: root, ...over })

  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'project-os-'))) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('is empty without local workspace I/O or a repo', async () => {
    write('repo/.ax/status/active.json', {})
    expect(await projectOsDashboard('', deps({ localIo: false }))).toEqual(EMPTY)
    expect(await projectOsDashboard('', deps({ lastWorkspace: '' }))).toEqual(EMPTY)
    expect(await projectOsDashboard('', deps({ lastWorkspace: join(root, 'missing') }))).toEqual(EMPTY)
  })

  it('reads the last workspace truth files and docs, with the git badge and the first content line as the goal', async () => {
    mkdirSync(join(root, '.git'))
    write('.ax/handoff/current.json', { board: { slug: 'ops', display_name: 'Ops' } })
    write('.ax/status/heartbeat.json', { at: 1 })
    write('docs/project-os/PROJECT.md', '# Project\n\n- Ship the gateway controls\n')
    write('docs/project-os/STATUS.md', 'green\n')
    const badge = { branch: 'main', dirty: 0, modified: 0, untracked: 0, ahead: 0, behind: 0, is_git: true as const }
    const seen: string[] = []
    const body = await projectOsDashboard('', deps({ git: (repo) => { seen.push(repo); return Promise.resolve(badge) } }))
    expect(body).toMatchObject({ workspace: root, repo_root: root, selected_board_slug: null, git: badge, handoff: { board: { slug: 'ops' } }, active: null, heartbeat: { at: 1 }, onboarding: { active: false, doc_source: 'project-os' }, goal_summary: 'Ship the gateway controls' })
    expect(body.docs).toMatchObject({ project: { path: 'docs/project-os/PROJECT.md', content: '# Project\n\n- Ship the gateway controls\n' }, status: { content: 'green\n' }, plan: null, blocker_resolver: null })
    expect(seen).toEqual([root])
  })

  it('falls back to the handoff goal, the board description, STATUS.md, then the board name', async () => {
    mkdirSync(join(root, '.git'))
    write('.ax/status/heartbeat.json', {})
    const boards = (): Promise<Dict[]> => Promise.resolve([{ slug: 'ops', name: 'Ops board', description: 'Board goal' }])
    expect((await projectOsDashboard('ops', deps({ boards }))).goal_summary).toBe('Board goal')
    write('docs/project-os/STATUS.md', '## Now\n- status line\n')
    expect((await projectOsDashboard('', deps())).goal_summary).toBe('status line')
    rmSync(join(root, 'docs'), { recursive: true })
    expect((await projectOsDashboard('', deps())).goal_summary).toBe('Project OS')
    write('.ax/handoff/current.json', { goal_summary: 'x'.repeat(300) })
    expect((await projectOsDashboard('', deps())).goal_summary).toBe('x'.repeat(220))
  })

  it("finds the board's repo breadth-first under the workspace, skipping hidden and vendored directories", async () => {
    write('node_modules/pkg/.ax/status/active.json', { board: 'ops' })
    write('.hidden/.ax/status/active.json', { board: 'ops' })
    write('apps/web/.ax/handoff/current.json', { board: { id: 'ops' } })
    const body = await projectOsDashboard('ops', deps())
    expect([body.repo_root, body.selected_board_slug]).toEqual([join(root, 'apps', 'web'), 'ops'])
    expect(body.handoff).toEqual({ board: { id: 'ops' } })
    // An unmatched board keeps the workspace itself.
    expect((await projectOsDashboard('other', deps())).repo_root).toBe(root)
  })

  it('never scans into a directory symlink that leaves the workspace', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'project-os-outside-')))
    try {
      mkdirSync(join(outside, '.ax', 'status'), { recursive: true })
      writeFileSync(join(outside, '.ax', 'status', 'active.json'), JSON.stringify({ board: 'ops', secret: 'outside truth' }))
      symlinkSync(outside, join(root, 'linked'))
      const body = await projectOsDashboard('ops', deps())
      expect(body.repo_root).toBe(root)
      expect(JSON.stringify(body)).not.toContain('outside truth')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('never reads through a directory swapped for an outside symlink after it was listed', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'project-os-outside-')))
    try {
      mkdirSync(join(outside, '.ax', 'status'), { recursive: true })
      writeFileSync(join(outside, '.ax', 'status', 'active.json'), JSON.stringify({ board: 'ops', secret: 'outside truth' }))
      mkdirSync(join(root, 'apps'))
      afterListing.dir = root
      afterListing.run = () => { rmSync(join(root, 'apps'), { recursive: true }); symlinkSync(outside, join(root, 'apps')) }
      const body = await projectOsDashboard('ops', deps())
      expect(afterListing.run).toBeNull()
      expect(body.repo_root).toBe(root)
      expect(JSON.stringify(body)).not.toContain('outside truth')
    } finally {
      afterListing.run = null
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("starts from the board's default workdir and follows active.json to the real repo root", async () => {
    write('work/.ax/status/active.json', { repo_root: join(root, 'real') })
    write('real/.ax/status/active.json', { repo_root: join(root, 'real'), phase: 'build' })
    write('real/docs/project-os/PLAN.md', 'plan\n')
    const boards = (): Promise<Dict[]> => Promise.resolve([{ slug: 'other' }, { slug: 'ops', default_workdir: join(root, 'work') }])
    const body = await projectOsDashboard('ops', deps({ lastWorkspace: join(root, 'missing'), boards }))
    expect(body).toMatchObject({ repo_root: join(root, 'real'), active: { phase: 'build' }, docs: { plan: { content: 'plan\n' } } })
    // A failing board lookup is ignored.
    expect((await projectOsDashboard('ops', deps({ lastWorkspace: join(root, 'work'), boards: () => Promise.reject(new Error('down')) }))).repo_root).toBe(join(root, 'real'))
  })

  it('uses root-level docs in a non-git onboarding workspace', async () => {
    write('PROJECT.md', `Onboarding ${root}\nTO_BE_VALIDATED_BY_HERMES\n자동 승격 금지\n`)
    write('docs/project-os/PROJECT.md', 'nested\n')
    const body = await projectOsDashboard('', deps())
    expect(body.docs.project).toMatchObject({ path: 'PROJECT.md' })
    expect(body.onboarding).toEqual({
      active: true, doc_source: 'root', status_label: '보류(안전)',
      summary: 'workspace root onboarding 진행 중 · 저장소 경계는 아직 미확정이며 TO_BE_VALIDATED_BY_HERMES 상태를 유지합니다.',
      next_safe_action: 'workspace-root 기준으로 경계만 좁게 검증', workspace_root_confirmed: true, repo_boundary_status: 'TO_BE_VALIDATED_BY_HERMES', child_repo_auto_promotion_blocked: true,
      guardrails: ['workspace root 확인됨', 'child repo 자동 승격 금지 유지', 'repo boundary 미확정 유지'],
    })
    expect(body.goal_summary).toBe(`Onboarding ${root}`)
  })

  // Python test_issue4582_workspace_escape_navigation: a symlink out of the repo is never read.
  it('does not read docs through a symlink that escapes the repo', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'project-os-outside-')))
    try {
      writeFileSync(join(outside, 'note.md'), 'outside note')
      mkdirSync(join(root, '.git'))
      mkdirSync(join(root, 'docs', 'project-os'), { recursive: true })
      symlinkSync(join(outside, 'note.md'), join(root, 'docs', 'project-os', 'PROJECT.md'))
      const body = await projectOsDashboard('', deps())
      expect(body.docs.project).toBeNull()
      expect(JSON.stringify(body)).not.toContain('outside note')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
