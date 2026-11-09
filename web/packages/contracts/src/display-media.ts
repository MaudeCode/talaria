import { z } from 'zod'
import { MeshyModelRefSchema } from './meshy.js'

/**
 * TAL-186: one local or remote media reference the server recognized in a message's Markdown (a `MEDIA:` token, a bare
 * `file://` URL or a local image destination), in content order. `url` is relative to the app root (`./api/media?path=…&session_id=…`)
 * for a local file the `/api/media` allow-list serves, or the remote `http(s)` URL as written. Clients render `image`
 * items inline from the display text and every other kind as a tile after it. A remote URL without a file
 * extension has no known kind and is a `file`.
 *
 * TAL-1514: a `::meshy-model{…}` directive paragraph becomes a `model` item with an empty `url` and an opaque `model.ref`;
 * its line leaves the display text. Clients fetch `GET /api/meshy/card` with that ref and render the shared model preview.
 *
 * Its own module so `show.ts` (TAL-1968) can use it without importing `views.ts`, which imports the show block ref.
 */
export const DisplayMediaSchema = z.object({ url: z.string(), name: z.string(), mime: z.string(), kind: z.enum(['image', 'audio', 'video', 'pdf', 'file', 'model']), model: MeshyModelRefSchema.optional() })
export type DisplayMedia = z.infer<typeof DisplayMediaSchema>
