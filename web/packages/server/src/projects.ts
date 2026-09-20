/** `projects.json` (Python `load_projects`/`save_projects` with the one-time profile backfill). */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export interface Project { project_id: string; name: string; color?: string | null; profile?: string | null; created_at?: number; [key: string]: unknown }

export class ProjectStore {
  private migrated = false

  constructor(readonly file: string, private readonly readIndexRows: () => Record<string, unknown>[]) {}

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
