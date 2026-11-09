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
/**
 * TAL-1974: one read of a terminal's output (`server.terminal_read`), escape sequences removed. At most `max_lines` lines;
 * `next_event_id` is the cursor for the next read. `truncated` is true when output after the cursor is missing from
 * `output`: still unread past `next_event_id`, cut from one event longer than the cap, or already gone from the backlog.
 * `exit_code` is the shell's once it exited.
 */
export const TerminalSliceSchema = z.object({ terminal_id: TerminalIdSchema, output: z.string(), lines: z.number().int().nonnegative(), next_event_id: z.number().int().nonnegative(), truncated: z.boolean(), running: z.boolean(), exit_code: z.number().int().nullable() })
/**
 * TAL-1997: `GET /api/terminal/read`, the slice a client's read-only terminal view appends. When the cursor stopped inside
 * a line (its newline had not arrived), `replaces_last_line` is true and the first line of `output` is that line in full
 * as it now reads, which the view shows in place of the last line it holds.
 */
export const TerminalViewSliceSchema = TerminalSliceSchema.extend({ replaces_last_line: z.boolean() })
