import { z } from 'zod'

/**
 * TAL-2380: a profile's Bot Screen, the headless desktop the Agent's `computer_use` drives, as the server decides it from
 * the profile's Agent owner. `available` is false when the owner has no screen to offer (no owner runs, an older owner
 * without `display.*`, or a host that cannot run one); clients then show no Screen action. `not_installed` is available:
 * its viewer shows `install_command`, the host command that installs the desktop packages (null when the host has no
 * supported package manager). `control` is who drives it: the agent, the asking viewer (`you`, only on `GET /api/screen/view`
 * and `POST /api/screen/lease`, which name it), or another viewer (`other`; the session detail, which names no viewer, never says `you`).
 */
export const ScreenStateSchema = z.enum(['unsupported', 'not_installed', 'stopped', 'running'])
export const ScreenControlSchema = z.enum(['agent', 'you', 'other'])
export const ScreenViewSchema = z.object({
  available: z.boolean(),
  state: ScreenStateSchema,
  control: ScreenControlSchema,
  install_command: z.string().nullable(),
})
export type ScreenView = z.infer<typeof ScreenViewSchema>

/**
 * TAL-2380: the viewer's raw RFB stream, a WebSocket upgrade of `GET SCREEN_STREAM_PATH?view_id=` for the active profile.
 * Binary frames both ways are RFB (noVNC). The server dials the Agent's display socket with a ticket it mints and never
 * sends to the client; keyboard and pointer reach the screen only while this viewer holds control. A close with
 * `SCREEN_CLOSE.controlTaken` means another viewer took control (reconnect to watch); `desktopGone` that the screen stopped;
 * `signedOut` that the login it opened with signed out or expired.
 */
export const SCREEN_STREAM_PATH = '/api/screen/ws'
export const SCREEN_CLOSE = { controlTaken: 4000, desktopGone: 4001, signedOut: 4401, unavailable: 4503 } as const
/** A client-chosen id for one open viewer, which `POST /api/screen/lease` names to take over or hand back. */
export const ScreenViewIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)
export const ScreenLeaseInputSchema = z.object({ view_id: ScreenViewIdSchema, action: z.enum(['acquire', 'release']) })
export type ScreenLeaseInput = z.infer<typeof ScreenLeaseInputSchema>
