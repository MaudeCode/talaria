import { z } from 'zod'
import { DisplayMediaSchema } from './display-media.js'

/**
 * TAL-1968: a block the agent shows the user in the transcript instead of describing it. The agent calls the `harness`
 * toolset's `show` with a kind and its payload; the server validates the payload, stores the block and answers with its
 * id. The tool result carries only the reference (`result_view.block`); clients load the block from
 * `GET /api/show/{block_id}` and render its fields. A block never changes once stored, so live and replay show the same.
 */
export const SHOW_KINDS = ['file', 'table', 'chart', 'html'] as const
export const ShowKindSchema = z.enum(SHOW_KINDS)
export type ShowKind = z.infer<typeof ShowKindSchema>
export const ShowBlockIdSchema = z.string().regex(/^sb_[0-9a-f]{12}$/)

/** Caps the server applies. A table past its caps is cut and says so; an HTML body past its cap is refused. */
export const SHOW_LIMITS = { title: 200, columns: 20, rows: 500, cell: 2000, series: 6, points: 200, html_bytes: 512 * 1024, deliver_bytes: 200 * 1024 * 1024 } as const

const ShowBase = z.object({ block_id: ShowBlockIdSchema, session_id: z.string(), title: z.string(), created_at: z.number() })

/**
 * TAL-1971: a file the agent handed over with `deliver`. `download_url` (relative to the app root) streams it as an
 * attachment from `/api/file/raw`; `mime` is its type. The row points at the live file: `changed` is true when its bytes
 * no longer match the digest the server recorded at delivery, or it is gone, checked on each read of the block.
 */
export const ShowDeliverySchema = z.object({ download_url: z.string(), mime: z.string(), changed: z.boolean() })
export type ShowDelivery = z.infer<typeof ShowDeliverySchema>

/**
 * `file`: a file of the session's workspace. An image, audio, video or PDF ships as a `media` row served by
 * `/api/file/raw`; a text or code file ships `focus_path`, the workspace path its Open action shows on the companion page.
 * A delivered file of any other type ships neither. `delivery` is set for a `deliver` block and null for a `show` one.
 */
export const ShowFileBlockSchema = ShowBase.extend({
  kind: z.literal('file'),
  file: z.object({ path: z.string(), name: z.string(), size: z.number().int().nonnegative() }),
  media: DisplayMediaSchema.nullable(),
  focus_path: z.string().nullable(),
  delivery: ShowDeliverySchema.nullable(),
})

/**
 * `table`: cells as text. `truncation` gives the agent's row and column counts when the server cut the table to its caps,
 * else null. `tsv` is the shown table as tab-separated text, header first, for Copy.
 */
export const ShowTableBlockSchema = ShowBase.extend({
  kind: z.literal('table'),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.string())),
  truncation: z.object({ total_rows: z.number().int().nonnegative(), total_columns: z.number().int().nonnegative() }).nullable(),
  tsv: z.string(),
})

/** One point of a chart series, with its value as the server formatted it (`unit` included). */
export const ShowChartPointSchema = z.object({ label: z.string(), value: z.number(), display: z.string() })
/**
 * `max_display` is the series' largest value (0 when none is positive) as the chart's scale label shows it; `peak` is
 * its largest point (the first of equal ones), which the chart's accessibility summary names.
 */
export const ShowChartSeriesSchema = z.object({ name: z.string(), points: z.array(ShowChartPointSchema), max_display: z.string(), peak: z.object({ label: z.string(), display: z.string() }) })
export const ShowChartBlockSchema = ShowBase.extend({
  kind: z.literal('chart'),
  chart: z.enum(['bar', 'line']),
  unit: z.string().nullable(),
  series: z.array(ShowChartSeriesSchema),
})

/**
 * `html`: a page shown in a sandboxed frame. `frame_url` (relative to the app root) is a grant minted for this request
 * that expires at `expires_at` (seconds); the frame's response carries `sandbox allow-scripts` and a CSP with no network
 * source, so the page runs without the session cookie and reaches nothing. `bytes` is the body's UTF-8 size.
 */
export const ShowHtmlBlockSchema = ShowBase.extend({
  kind: z.literal('html'),
  frame_url: z.string(),
  expires_at: z.number(),
  bytes: z.number().int().nonnegative(),
})

export const ShowBlockSchema = z.discriminatedUnion('kind', [ShowFileBlockSchema, ShowTableBlockSchema, ShowChartBlockSchema, ShowHtmlBlockSchema])
export type ShowBlock = z.infer<typeof ShowBlockSchema>

/** The transcript's reference from a `show` or `deliver` result, set by the server; the block loads from `GET /api/show/{block_id}`. */
export const ShowBlockRefSchema = z.object({ block_id: ShowBlockIdSchema, kind: ShowKindSchema, title: z.string() })
export type ShowBlockRef = z.infer<typeof ShowBlockRefSchema>
