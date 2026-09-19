import { z } from 'zod'
import { SessionIdSchema } from './session'

/** Search params accepted on `/`. Legacy launch flows redirect to canonical routes. */
export const IndexSearchSchema = z.object({
  session: SessionIdSchema.optional().catch(undefined),
  session_id: SessionIdSchema.optional().catch(undefined),
  source: z.enum(['pwa']).optional().catch(undefined),
  action: z.enum(['new-chat']).optional().catch(undefined),
  profile: z.string().max(64).optional().catch(undefined),
})
export type IndexSearch = z.infer<typeof IndexSearchSchema>

export const TasksSearchSchema = z.object({ job: z.string().optional().catch(undefined) })

export const SettingsSectionSchema = z.enum(['appearance', 'conversation', 'preferences', 'providers', 'plugins', 'extensions', 'system', 'help'])
export type SettingsSection = z.infer<typeof SettingsSectionSchema>

export const LogsSearchSchema = z.object({
  file: z.enum(['agent', 'webui', 'gateway', 'bootstrap']).optional().catch(undefined),
  tail: z.number().int().min(50).max(5000).optional().catch(undefined),
})
export const InsightsSearchSchema = z.object({ days: z.number().int().min(1).max(365).optional().catch(undefined) })
export const KanbanSearchSchema = z.object({ board: z.string().max(128).optional().catch(undefined), assignee: z.string().max(128).optional().catch(undefined), archived: z.boolean().optional().catch(undefined), task: z.string().max(128).optional().catch(undefined) })
export const LoginSearchSchema = z.object({ next: z.string().max(2048).optional().catch(undefined) })
export const SkillsSearchSchema = z.object({ q: z.string().max(200).optional().catch(undefined), category: z.string().max(64).optional().catch(undefined) })
export const SessionSearchSchema = z.object({ msg: z.string().max(128).optional().catch(undefined) })

/** Legacy `#settings` / `#sessions` hashes map to routes. */
export function legacyHashRoute(hash: string): string | null {
  const h = hash.replace(/^#/, '').trim().toLowerCase()
  if (h === 'settings') return '/settings'
  if (h === 'sessions' || h === 'chat') return '/'
  return null
}
