import { z } from 'zod'

/**
 * TAL-1691, TAL-2100, TAL-2101: the Settings sections both clients show, in menu order. Web routes them as `/settings/<id>`; the
 * App keys its categories and the update notification's `settings.<id>` destination by the same ids.
 */
export const SettingsSectionSchema = z.enum(['appearance', 'chat', 'navigation', 'notifications', 'speech', 'models', 'providers', 'tools', 'profiles', 'workspaces', 'extensions', 'access', 'system', 'logs', 'about'])
export type SettingsSectionId = z.infer<typeof SettingsSectionSchema>

/** TAL-2100: what a section's settings apply to: this interface, the active profile, or the whole server. */
export const SettingsSectionGroupSchema = z.enum(['interface', 'profile', 'server'])
export type SettingsSectionGroup = z.infer<typeof SettingsSectionGroupSchema>

/** TAL-2100: each section's group. The menu shows the groups in this order, each holding its sections in menu order. */
export const SETTINGS_SECTION_GROUPS: Readonly<Record<SettingsSectionId, SettingsSectionGroup>> = {
  appearance: 'interface', chat: 'interface', navigation: 'interface', notifications: 'interface', speech: 'interface',
  models: 'profile', providers: 'profile', tools: 'profile',
  profiles: 'server', workspaces: 'server', extensions: 'server', access: 'server', system: 'server', logs: 'server', about: 'server',
}
