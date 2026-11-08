import { z } from 'zod'

/**
 * TAL-1691: the Settings sections both clients show, in menu order. Web routes them as `/settings/<id>`; the App keys
 * its categories and the update notification's `settings.<id>` destination by the same ids.
 */
export const SettingsSectionSchema = z.enum(['appearance', 'chat', 'sidebar', 'models', 'notifications', 'speech', 'agent', 'system', 'about'])
export type SettingsSectionId = z.infer<typeof SettingsSectionSchema>
