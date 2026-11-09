import { z } from 'zod'

/**
 * TAL-1974: an embedded terminal the agent opened with the `harness` toolset's `terminal_open`, a Web host PTY in the
 * calling session's workspace that the user watches in the terminal pane. The tool result carries only this reference
 * (`result_view.terminal`); its card opens the session's terminal pane, which replays the output from the start.
 */
export const TerminalIdSchema = z.string().regex(/^term_[0-9a-f]{16}$/)
/** `command` is the command the agent typed, null when it typed none or the title is the command. */
export const TerminalRefSchema = z.object({ terminal_id: TerminalIdSchema, title: z.string(), command: z.string().nullable() })
export type TerminalRef = z.infer<typeof TerminalRefSchema>
