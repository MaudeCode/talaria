/** Skills panel: list/view through the Agent (sidecar `skills.*`), file writes and config.yaml toggles here (Python `api/routes.py` skills section). */
import { decodeText, makeAnchoredDir, openAnchoredCreateFd, openAnchoredFd, openAnchoredWriteFd, rmtreeAnchored } from '../workspace/fs.js'
import { resolvePathLikePython } from '../workspace/paths.js'
import { closeSync, fstatSync, mkdirSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { SidecarLike } from '../sidecar/client.js'
import { dict, isDict, type AgentConfig, type Dict } from '../config/agent-config.js'
import { HttpFailure } from '../sessions/service.js'
import { str } from '../util.js'

const EXCLUDED_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.hg', '.svn', 'dist', 'build'])

export class SkillsService {
  constructor(private readonly deps: { sidecar: () => SidecarLike | null; config: AgentConfig; log: (line: string) => void }) {}

  private sidecar(): SidecarLike {
    const s = this.deps.sidecar()
    if (!s) throw new HttpFailure(503, 'Hermes Agent sidecar is not running; skills are unavailable')
    return s
  }

  static skillsDir(profileHome: string): string {
    return join(profileHome, 'skills')
  }

  async list(profileHome: string, category: string | null): Promise<{ name: string; description: string; category: string | null; disabled: boolean }[]> {
    const result = await this.sidecar().call('skills.list', { profile_home: profileHome, category })
    return result.skills
  }

  /** Python `/api/skills/usage`: `.usage.json` counters merged with the skill inventory. */
  async usage(profileHome: string): Promise<Dict> {
    const usage: Record<string, Dict> = {}
    try {
      const raw = JSON.parse(readFileSync(join(SkillsService.skillsDir(profileHome), '.usage.json'), 'utf8')) as unknown
      if (isDict(raw)) {
        for (const [k, v] of Object.entries(raw)) {
          if (!isDict(v)) { usage[k] = { use_count: 0, view_count: 0, patch_count: 0 }; continue }
          const n = (x: unknown): number => (x === null || x === undefined ? 0 : Math.trunc(Number(x)) || 0)
          usage[k] = { use_count: n(v.use_count), view_count: n(v.view_count), patch_count: n(v.patch_count) }
          for (const [mk, mv] of Object.entries(v)) if (!(mk in usage[k])) usage[k][mk] = mv
        }
      }
    } catch { /* missing or corrupt → empty */ }
    const names = [...new Set((await this.list(profileHome, null)).map((s) => s.name))].sort()
    const count = (e: Dict, k: string): number => (typeof e[k] === 'number' ? e[k] : 0)
    const total = Object.values(usage).reduce((acc, e) => acc + count(e, 'use_count') + count(e, 'view_count') + count(e, 'patch_count'), 0)
    const unique = Object.values(usage).filter((e) => count(e, 'use_count') > 0 || count(e, 'view_count') > 0 || count(e, 'patch_count') > 0).length
    return { usage, skill_names: names, total_invocations: total, unique_skills_used: unique }
  }

  async view(profileHome: string, name: string): Promise<Dict> {
    const data = (await this.sidecar().call('skills.view', { profile_home: profileHome, name })) as Dict
    if (data.success === true && !isDict(data.linked_files)) data.linked_files = {}
    return data
  }

  /** `?file=` mode: one linked file inside the skill directory; a binary file carries only its size. */
  async linkedFile(profileHome: string, name: string, file: string): Promise<{ content: string; path: string } | { path: string; size: number; binary: true }> {
    if (/[*?[\]]/.test(name)) throw new HttpFailure(400, 'Invalid skill name')
    const found = await this.sidecar().call('skills.find', { profile_home: profileHome, name })
    if (!found.found || !found.skill_dir) throw new HttpFailure(404, 'Skill not found')
    const skillDir = resolvePathLikePython(found.skill_dir)
    const target = resolve(skillDir, file)
    if (target !== skillDir && !target.startsWith(skillDir + sep)) throw new HttpFailure(400, 'Invalid file path')
    // Anchored, symlink-free read: a linked file inside the skill directory never exposes its target.
    let fd: number
    try { fd = openAnchoredFd(skillDir, target, { wantDir: false }) } catch { throw new HttpFailure(404, 'File not found') }
    try {
      if (!fstatSync(fd).isFile()) throw new HttpFailure(404, 'File not found')
      const raw = readFileSync(fd)
      const content = decodeText(raw)
      return content === null ? { path: file, size: raw.length, binary: true } : { content, path: file }
    } finally { closeSync(fd) }
  }

  save(profileHome: string, nameRaw: string, content: string, categoryRaw: string): { ok: true; name: string; path: string } {
    const name = nameRaw.trim().toLowerCase().replaceAll(' ', '-')
    if (!name || name.includes('/') || name.includes('..')) throw new HttpFailure(400, 'Invalid skill name')
    const category = categoryRaw.trim()
    if (category && (category.includes('/') || category.includes('..'))) throw new HttpFailure(400, 'Invalid category')
    mkdirSync(SkillsService.skillsDir(profileHome), { recursive: true })
    const skillsDir = resolvePathLikePython(SkillsService.skillsDir(profileHome))
    const skillDir = resolve(category ? join(skillsDir, category, name) : join(skillsDir, name))
    if (!skillDir.startsWith(skillsDir + sep)) throw new HttpFailure(400, 'Invalid skill path')
    const file = join(skillDir, 'SKILL.md')
    // Anchored creation: a symlinked skill or category directory (or SKILL.md) is refused instead of written through.
    let fd: number
    try {
      makeAnchoredDir(skillsDir, skillDir)
      let exists = false
      try { exists = lstatSync(file).isFile() } catch { exists = false }
      fd = exists ? openAnchoredWriteFd(skillsDir, file) : openAnchoredCreateFd(skillsDir, file)
    } catch (error) {
      if (error instanceof HttpFailure) throw error
      throw new HttpFailure(400, 'Cannot save to a symlinked skill file')
    }
    try { writeFileSync(fd, content, 'utf8') } finally { closeSync(fd) }
    return { ok: true, name, path: file }
  }

  delete(profileHome: string, nameRaw: string): { ok: true; name: string } {
    const name = nameRaw.trim().toLowerCase().replaceAll(' ', '-')
    if (!name || name.includes('/') || name.includes('..')) throw new HttpFailure(400, 'Invalid skill name')
    const skillsDir = SkillsService.skillsDir(profileHome)
    const match = walkSkillFiles(skillsDir).find((p) => relative(join(p, '..', '..'), join(p, '..')) === name)
    if (!match) throw new HttpFailure(404, 'Skill not found')
    // Delete through the anchored walk from the skills root so a symlinked root or category cannot redirect the removal.
    try { rmtreeAnchored(skillsDir, join(match, '..')) } catch { throw new HttpFailure(404, 'Skill not found') }
    return { ok: true, name: nameRaw }
  }

  async toggle(profileHome: string, name: string, enabled: boolean): Promise<{ ok: true; name: string; enabled: boolean }> {
    const found = await this.sidecar().call('skills.find', { profile_home: profileHome, name })
    if (!found.found) throw new HttpFailure(404, `Skill '${name}' not found`)
    // Python `_active_profile_config_path`: skill toggles follow the profile's own config.yaml, never HERMES_CONFIG_PATH —
    // the sidecar reads the disabled set from the same file.
    await this.deps.config.update(profileHome, (c) => {
      const skills = dict(c.skills)
      skills.disabled = toggleName(skills.disabled, name, enabled)
      const platform = skills.platform_disabled
      if (isDict(platform) && 'webui' in platform) platform.webui = toggleName(platform.webui, name, enabled)
      c.skills = skills
    }, { profileFile: true })
    return { ok: true, name, enabled }
  }
}

function normalizeNames(raw: unknown): string[] {
  const list: unknown[] = raw === null || raw === undefined ? [] : typeof raw === 'string' ? raw.split(/[,\n]/) : Array.isArray(raw) ? raw : []
  return [...new Set(list.map((v) => str(v).trim()).filter(Boolean))]
}

export function toggleName(raw: unknown, name: string, enabled: boolean): string[] {
  const names = normalizeNames(raw)
  if (enabled) return names.filter((n) => n !== name)
  if (!names.includes(name)) names.push(name)
  return names
}

/** Every `SKILL.md` under the skills root, skipping vendored trees (Python `_iter_skill_md_pruned`). */
export function walkSkillFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) out.push(join(dir, 'SKILL.md'))
    for (const e of entries) if (e.isDirectory() && !EXCLUDED_DIRS.has(e.name)) walk(join(dir, e.name))
  }
  walk(root)
  return out
}
