/** `projects.json` (Python `load_projects`/`save_projects` with the one-time profile backfill). */
import type { DocumentBackend } from './sessions/storage/backend.js'
import { updateDocument } from './sessions/storage/document.js'
import { randomUUID } from 'node:crypto'

export interface Project {
  project_id: string; name: string; color?: string | null; profile?: string | null; created_at?: number
  /** TAL-1032: trusted workspaces bound to the project, and the one its new chats start in. */
  workspaces?: string[]; default_workspace?: string | null
  /** TAL-1032: the model and its provider new chats in the project start on; never one without the other. */
  model?: string | null; model_provider?: string | null
  [key: string]: unknown
}

/** TAL-1032: the bindings as stored, reading an upstream single `workspace` row as one bound default. */
export function projectBindings(p: Project): { workspaces: string[]; default_workspace: string | null; model: string | null; model_provider: string | null } {
  const legacy = typeof p.workspace === 'string' && p.workspace ? p.workspace : null
  const workspaces = Array.isArray(p.workspaces) ? p.workspaces.filter((w): w is string => typeof w === 'string' && !!w) : legacy ? [legacy] : []
  const chosen = 'default_workspace' in p ? p.default_workspace : legacy
  const model = typeof p.model === 'string' && p.model ? p.model : null
  return {
    workspaces, default_workspace: typeof chosen === 'string' && workspaces.includes(chosen) ? chosen : null,
    model, model_provider: model && typeof p.model_provider === 'string' && p.model_provider ? p.model_provider : null,
  }
}

/** Python `CRON_PROJECT_NAME` / `WEBHOOK_PROJECT_NAME`: system projects that group background sessions per profile. */
export const SYSTEM_PROJECTS: Record<'cron' | 'webhook', { name: string; color: string }> = { cron: { name: 'Cron Jobs', color: '#6366f1' }, webhook: { name: 'Webhooks', color: '#0ea5e9' } }

export class ProjectStore {
  private migrated = false
  private operations: Promise<void> = Promise.resolve()

  constructor(private readonly documents: DocumentBackend, private readonly readIndexRows: () => Record<string, unknown>[] | Promise<Record<string, unknown>[]>, private readonly isRootProfile: (name: string) => boolean = (name) => name === 'default') {}

  private sameProfile(row: string | null | undefined, active: string): boolean {
    const r = row || 'default'
    return r === active || (this.isRootProfile(r) && this.isRootProfile(active))
  }

  /** Python `_profile_has_user_projects`: at least one non-system project belongs to the profile (or its root alias). */
  async hasUserProjects(profile: string): Promise<boolean> {
    const reserved = new Set(Object.values(SYSTEM_PROJECTS).map((p) => p.name))
    return (await this.load()).some((p) => !reserved.has(p.name) && this.sameProfile(p.profile, profile))
  }

  /**
   * Python `ensure_cron_project` / `ensure_webhook_project`: the profile's system project by (name, profile),
   * a renamed-root alias match, or a legacy untagged row back-tagged to the caller; minted only when `create`.
   */
  async ensureSystemProject(kind: keyof typeof SYSTEM_PROJECTS, profile: string, opts: { create?: boolean } = {}): Promise<string | null> {
    const spec = SYSTEM_PROJECTS[kind]
    const active = profile || 'default'
    // Raw rows: a legacy untagged system project is back-tagged to the caller here, not by the generic backfill.
    return this.mutate((projects) => {
      for (const p of projects) if (p.name === spec.name && this.sameProfile(p.profile, active) && (p.profile === active || this.isRootProfile(active))) return p.project_id
      for (const p of projects) if (p.name === spec.name && !p.profile) { p.profile = active; return p.project_id }
      if (opts.create === false) return null
      const project = { project_id: randomUUID().replace(/-/g, '').slice(0, 12), name: spec.name, color: spec.color, profile: active, created_at: Date.now() / 1000 }
      projects.push(project)
      return project.project_id
    }, { migrate: false })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation)
    this.operations = result.then(() => { /* retain ordering */ }, () => { /* retry on the next call */ })
    return result
  }

  load(opts: { migrate?: boolean } = {}): Promise<Project[]> { return this.serialize(() => this.loadNow(opts)) }

  /** The session-index backfill can yield; keep the whole project edit under the same lock. */
  mutate<T>(edit: (projects: Project[]) => T, opts: { migrate?: boolean } = {}): Promise<T> {
    return this.serialize(async () => (await updateDocument(this.documents, 'projects', 'projects', async (raw) => {
      const projects = Array.isArray(raw) ? raw as Project[] : []
      if ((opts.migrate ?? true) && !this.migrated) await this.backfillProfiles(projects)
      const result = edit(projects)
      return { value: projects, result }
    }, { replaceInvalid: true })))
  }

  private async loadNow(opts: { migrate?: boolean }): Promise<Project[]> {
    let raw: unknown
    try { raw = (await this.documents.get('projects', 'projects'))?.value } catch { return [] }
    const projects = Array.isArray(raw) ? raw as Project[] : []
    if ((opts.migrate ?? true) && !this.migrated && Array.isArray(raw)) {
      const result = await updateDocument(this.documents, 'projects', 'projects', async (value) => {
        const current = Array.isArray(value) ? value as Project[] : []
        await this.backfillProfiles(current)
        return { value: current, result: current }
      }, { replaceInvalid: true })
      this.migrated = true
      return result
    }
    return projects
  }

  async save(projects: Project[]): Promise<void> {
    await updateDocument(this.documents, 'projects', 'projects', () => ({ value: projects, result: undefined }), { replaceInvalid: true })
  }

  /** Tag legacy untagged projects with the profile of an assigned session, else `default`. */
  private async backfillProfiles(projects: Project[]): Promise<boolean> {
    const untagged = projects.filter((p) => !p.profile)
    if (!untagged.length) return false
    const byProject = new Map<string, string>()
    try {
      const ids = new Set(untagged.map((p) => p.project_id).filter(Boolean))
      for (const row of await this.readIndexRows()) {
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
