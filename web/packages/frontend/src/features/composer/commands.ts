/**
 * Slash commands. The server publishes the canonical catalog (`GET /api/commands`, TAL-314): which commands exist,
 * their aliases, order, and which clients run them. The browser keeps only the handlers, keyed by each entry's `name`.
 */
import type { Command } from '../../contracts'

export interface ParsedCommand { name: string; args: string; raw: string }

export function parseCommand(text: string): ParsedCommand | null {
  const t = text.trimStart()
  if (!t.startsWith('/')) return null
  const mm = /^\/([a-zA-Z][\w-]*)\s*([\s\S]*)$/.exec(t)
  if (!mm) return null
  return { name: (mm[1] ?? '').toLowerCase(), args: (mm[2] ?? '').trim(), raw: t }
}

export interface CommandSuggestion { name: string; desc: string; args?: string | undefined; category?: string | undefined }

const names = (c: Command) => [c.name, ...c.aliases].map((n) => n.toLowerCase())

/** The catalog entry a typed name or alias resolves to. */
export function resolveCommand(name: string, catalog: Command[]): Command | undefined {
  const n = name.toLowerCase()
  return catalog.find((c) => names(c).includes(n))
}

/** Catalog entries Web runs whose name or any alias starts with `prefix` (case-insensitive), in server order. */
export function suggestCommands(prefix: string, catalog: Command[]): CommandSuggestion[] {
  const p = prefix.toLowerCase()
  return catalog
    .filter((c) => c.clients.includes('web') && names(c).some((n) => n.startsWith(p)))
    .slice(0, 40)
    .map((c) => ({ name: c.name, desc: c.description ?? '', args: c.args_hint, category: c.category }))
}

/**
 * Whether `POST /api/commands/exec` runs this entry (TAL-561). ponytail: old-server fallback — a server before TAL-561
 * sends no `exec`; legacy Web's rule (plugin commands and the sidecar's runtime commands) stands in until every
 * supported server sends it.
 */
const LEGACY_EXEC = new Set(['reload-mcp', 'reload-skills', 'codex-runtime', 'credits'])
export const runsOnServer = (c: Command): boolean => c.exec ?? (c.handler === 'agent' && (c.category === 'Plugin' || LEGACY_EXEC.has(c.name)))
