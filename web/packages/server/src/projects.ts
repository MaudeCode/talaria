/** `projects.json` (Python `load_projects`/`save_projects` with the one-time profile backfill). */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export interface Project { project_id: string; name: string; color?: string | null; profile?: string | null; created_at?: number; [key: string]: unknown }

/** Python `CRON_PROJECT_NAME` / `WEBHOOK_PROJECT_NAME`: system projects that group background sessions per profile. */
export const SYSTEM_PROJECTS: Record<'cron' | 'webhook', { name: string; color: string }> = { cron: { name: 'Cron Jobs', color: '#6366f1' }, webhook: { name: 'Webhooks', color: '#0ea5e9' } }

export class ProjectStore {
  private migrated = false

  constructor(readonly file: string, private readonly readIndexRows: () => Record<string, unknown>[], private readonly isRootProfile: (name: string) => boolean = (name) => name === 'default') {}

  private sameProfile(row: string | null | undefined, active: string): boolean {
    const r = row || 'default'
    return r === active || (this.isRootProfile(r) && this.isRootProfile(active))
  }

  /** Python `_profile_has_user_projects`: at least one non-system project belongs to the profile (or its root alias). */
  hasUserProjects(profile: string): boolean {
    const reserved = new Set(Object.values(SYSTEM_PROJECTS).map((p) => p.name))
    return this.load().some((p) => !reserved.has(p.name) && this.sameProfile(p.profile, profile))
  }

  /**
   * Python `ensure_cron_project` / `ensure_webhook_project`: the profile's system project by (name, profile),
   * a renamed-root alias match, or a legacy untagged row back-tagged to the caller; minted only when `create`.
   */
  ensureSystemProject(kind: keyof typeof SYSTEM_PROJECTS, profile: string, opts: { create?: boolean } = {}): string | null {
    const spec = SYSTEM_PROJECTS[kind]
    const active = profile || 'default'
    // Raw rows: a legacy untagged system project is back-tagged to the caller here, not by the generic backfill.
    const projects = this.load({ migrate: false })
    for (const p of projects) if (p.name === spec.name && this.sameProfile(p.profile, active) && (p.profile === active || this.isRootProfile(active))) return p.project_id
    for (const p of projects) if (p.name === spec.name && !p.profile) { p.profile = active; this.save(projects); return p.project_id }
    if (opts.create === false) return null
    const project = { project_id: randomUUID().replace(/-/g, '').slice(0, 12), name: spec.name, color: spec.color, profile: active, created_at: Date.now() / 1000 }
    projects.push(project)
    this.save(projects)
    return project.project_id
  }

  load(opts: { migrate?: boolean } = {}): Project[] {
    if (!existsSync(this.file)) return []
    let projects: Project[]
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      projects = Array.isArray(parsed) ? (parsed as Project[]) : []
    } catch {
      return []
    }
    if ((opts.migrate ?? true) && !this.migrated) {
      if (this.backfillProfiles(projects)) {
        try {
          this.save(projects)
          this.migrated = true
        } catch {
          /* retry on a later call */
        }
      } else {
        this.migrated = true
      }
    }
    return projects
  }

  save(projects: Project[]): void {
    writeFileSync(this.file, JSON.stringify(projects, null, 2), 'utf8')
  }

  /** Tag legacy untagged projects with the profile of an assigned session, else `default`. */
  private backfillProfiles(projects: Project[]): boolean {
    const untagged = projects.filter((p) => !p.profile)
    if (!untagged.length) return false
    const byProject = new Map<string, string>()
    try {
      const ids = new Set(untagged.map((p) => p.project_id).filter(Boolean))
      for (const row of this.readIndexRows()) {
        const pid = row.project_id
        if (typeof pid === 'string' && ids.has(pid) && typeof row.profile === 'string' && row.profile && !byProject.has(pid)) byProject.set(pid, row.profile)
      }
    } catch {
      /* index unreadable */
    }
    for (const p of untagged) p.profile = byProject.get(p.project_id) ?? 'default'
    return true
  }
}
