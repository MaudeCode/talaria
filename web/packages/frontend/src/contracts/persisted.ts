import { z } from 'zod'
import { SKIN_KEYS } from '../theme/skins'
import { UploadResponseSchema } from './chat'

export const ThemeSchema = z.enum(['light', 'dark', 'system'])
export type Theme = z.infer<typeof ThemeSchema>
export const SkinSchema = z.enum(SKIN_KEYS)
export type Skin = z.infer<typeof SkinSchema>
export const FontSizeSchema = z.enum(['default', 'small', 'large', 'xlarge'])
export type FontSize = z.infer<typeof FontSizeSchema>
export const ChatWidthSchema = z.enum(['comfortable', 'wide', 'full'])
export type ChatWidth = z.infer<typeof ChatWidthSchema>

/** Sidebar/rail tab order and hidden tabs (`hermes-webui-tab-order`, `hermes-webui-hidden-tabs`). */
export const TabIdListSchema = z.array(z.string().trim().min(1).max(64)).max(32)

/** Per-session composer draft mirror kept locally before the server draft round-trips. */
export const LocalDraftSchema = z.object({ text: z.string().max(200_000), updatedAt: z.number() })

/** Sidebar collapsed groups (`hermes-webui-collapsed-groups`). */
export const CollapsedGroupsSchema = z.array(z.string().max(128)).max(200)


export const NumberPrefSchema = z.number()
export const BoolPrefSchema = z.boolean()

/** A message queued behind the running turn (`hermes-queue:<sid>`, TAL-562): its text, upload receipts and the request it was composed against. */
export const QueuedTurnSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string(),
  attachments: z.array(UploadResponseSchema),
  request: z.object({ model: z.string().optional(), model_provider: z.string().nullable().optional(), workspace: z.string().optional(), profile: z.string() }),
})
// No size caps: the composer queues without one, and a cap here would drop a whole queue the user built on reload.
export const QueuedTurnsSchema = z.array(QueuedTurnSchema)
