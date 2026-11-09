import { z } from 'zod'

/**
 * TAL-604: one row of a unified diff hunk as the server parsed it. `text` is the raw line, its `+` / `-` / space prefix kept;
 * `old_line` / `new_line` number it on each side (null on the side it is absent from, and on a `\ No newline` marker).
 * Its own module so `proposals.ts` (TAL-1967) can use it without importing `views.ts`, which imports the proposal ref.
 */
export const DiffLineSchema = z.object({ kind: z.enum(['addition', 'deletion', 'context']), old_line: z.number().int().nullable(), new_line: z.number().int().nullable(), text: z.string() })
