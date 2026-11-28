import { defaultParseSearch, defaultStringifySearch } from '@tanstack/react-router'
import { z } from 'zod'
import { DECISION_FILTERS, LogLevelFilterSchema, type SettingsSectionId } from '@maudecode/talaria-web-contracts'
import { SessionIdSchema } from './session'

/**
 * TAL-1898: a project ID is opaque hex, and one like 9235168978e0 reads as a JSON number. The router's defaults would
 * quote it in the URL and lose it when bare, so `project` stays raw text. A quoted value from an old URL still parses.
 */
export function parseAppSearch(search: string) {
  const parsed: Record<string, unknown> = defaultParseSearch(search)
  // Logs searches for the literal text, even when it looks like a JSON number, boolean or object.
  if (parsed.query !== undefined) parsed.query = new URLSearchParams(search).get('query')
  if (parsed.project === undefined || typeof parsed.project === 'string') return parsed
  return { ...parsed, project: new URLSearchParams(search).get('project') }
}

export function stringifyAppSearch(search: Record<string, unknown>) {
  const { project, query, ...rest } = search
  let url = defaultStringifySearch(typeof project === 'string' && project ? rest : { ...rest, project })
  for (const [key, value] of [['project', project], ['query', query]] as const) {
    if (typeof value === 'string' && value) url += `${url ? '&' : '?'}${key}=${encodeURIComponent(value)}`
  }
  return url
}

/** Search params accepted on `/`. Legacy launch flows redirect to canonical routes. */
export const IndexSearchSchema = z.object({
  session: SessionIdSchema.optional().catch(undefined),
  session_id: SessionIdSchema.optional().catch(undefined),
  source: z.enum(['pwa']).optional().catch(undefined),
  action: z.enum(['new-chat', 'show-chats']).optional().catch(undefined),
  profile: z.string().max(64).optional().catch(undefined),
  /** TAL-1032: the unsaved chat starts in this project, on its defaults. */
  project: z.string().max(64).optional().catch(undefined),
})
export type IndexSearch = z.infer<typeof IndexSearchSchema>

/** TAL-1762: `tab` picks Jobs (default) or the profile's Scripts. */
export const TasksTabSchema = z.enum(['jobs', 'scripts'])
export type TasksTab = z.infer<typeof TasksTabSchema>
export const TasksSearchSchema = z.object({ job: z.string().optional().catch(undefined), tab: TasksTabSchema.optional().catch(undefined) })

/** TAL-1691: the section ids, and since TAL-2100 their groups, are shared with the App through the contracts package. */
export { SettingsSectionSchema, SettingsSectionGroupSchema, SETTINGS_SECTION_GROUPS } from '@maudecode/talaria-web-contracts'
export type { SettingsSectionId as SettingsSection, SettingsSectionGroup } from '@maudecode/talaria-web-contracts'

/** TAL-1691, TAL-2100: Settings > Tools keeps each of its lists on a `?tab=`. */
export const ToolsTabSchema = z.enum(['toolsets', 'plugins', 'connectors', 'mcp'])
export type ToolsTab = z.infer<typeof ToolsTabSchema>
/** TAL-2138: Settings › Chat's sub-pages, `settings/chat/<page>`. */
export const ChatPageSchema = z.enum(['workspace-panel', 'advanced', 'tool-calls'])
export type ChatPage = z.infer<typeof ChatPageSchema>
/** TAL-2766: the tail sizes offered by the Logs filter. */
export const LOG_TAILS = [200, 500, 1000, 2000] as const
const LogsSearchSchema = z.object({
  file: z.string().min(1).max(64).optional().catch(undefined),
  level: LogLevelFilterSchema.optional().catch(undefined),
  query: z.string().optional().catch(undefined),
  tail: z.literal(LOG_TAILS).optional().catch(undefined),
})
export type LogsSearch = z.infer<typeof LogsSearchSchema>

/** Tools' `tab`, Profiles' `name`, and Logs' shareable filters. */
export const SettingsSearchSchema = LogsSearchSchema.extend({ tab: ToolsTabSchema.optional().catch(undefined), name: z.string().min(1).max(64).optional().catch(undefined) })

/**
 * TAL-1691, TAL-2100: where each retired `/settings/<id>` now lives, so bookmarks and older deep links keep working.
 * `/settings/agent` keeps its `?tab=` and has its own redirect route (`_app.settings.agent.tsx`).
 */
export const LEGACY_SETTINGS_SECTIONS: Readonly<Record<string, { section: SettingsSectionId; tab?: ToolsTab }>> = {
  sidebar: { section: 'navigation' }, preferences: { section: 'navigation' }, conversation: { section: 'chat' }, auxiliary: { section: 'models' },
  plugins: { section: 'tools', tab: 'plugins' }, connectors: { section: 'tools', tab: 'connectors' }, help: { section: 'about' },
}

export const InsightsTabSchema = z.enum(['quotas', 'usage'])
export type InsightsTab = z.infer<typeof InsightsTabSchema>
/** TAL-1750: `tab` picks Quotas (default) or Usage; `days` is the Usage period. TAL-1117: `start` or `end` selects a custom range, sent as typed. */
export const InsightsSearchSchema = z.object({
  tab: InsightsTabSchema.optional().catch(undefined), days: z.number().int().min(1).max(365).optional().catch(undefined),
  start: z.string().max(40).optional().catch(undefined), end: z.string().max(40).optional().catch(undefined),
})
export const KanbanSearchSchema = z.object({ board: z.string().max(128).optional().catch(undefined), assignee: z.string().max(128).optional().catch(undefined), archived: z.boolean().optional().catch(undefined), task: z.string().max(128).optional().catch(undefined) })
export const LoginSearchSchema = z.object({ next: z.string().max(2048).optional().catch(undefined) })
/** TAL-2326: `skill` opens that skill's detail, as a tool row's link does. */
export const SkillsSearchSchema = z.object({ q: z.string().max(200).optional().catch(undefined), category: z.string().max(64).optional().catch(undefined), skill: z.string().max(200).optional().catch(undefined) })
// The router parses `?msg=5` as a number; persisted message keys are integer ids, so the key accepts both and stays a string.
export const SessionSearchSchema = z.object({ msg: z.union([z.string().max(128), z.number().transform(String)]).optional().catch(undefined) })

/**
 * TAL-1964: a decision review's view (`answers`, else Decide), the item Decide shows (else the first) and the answers
 * filter. Item ids are the agent's text, so a numeric-looking one stays a string.
 */
export const DecisionsSearchSchema = z.object({
  view: z.enum(['answers']).optional().catch(undefined),
  item: z.union([z.string().max(64), z.number().transform(String)]).optional().catch(undefined),
  filter: z.enum(DECISION_FILTERS).optional().catch(undefined),
})
export type DecisionsSearch = z.infer<typeof DecisionsSearchSchema>

/** Legacy `#settings` / `#sessions` hashes map to routes. */
export function legacyHashRoute(hash: string): string | null {
  const h = hash.replace(/^#/, '').trim().toLowerCase()
  if (h === 'settings') return '/settings'
  if (h === 'sessions' || h === 'chat') return '/'
  return null
}
