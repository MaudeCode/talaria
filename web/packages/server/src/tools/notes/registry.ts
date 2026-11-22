/** The notes sources one request can use (TAL-1071): the adapters, then name-matched MCP servers no adapter reads. */
import { dict, type Config, type Dict } from '../../config/agent-config.js'
import { mcpServerEnabled } from '../mcp.js'
import { folderSource, notesFolders } from './folder.js'
import { joplinServer, joplinSource } from './joplin.js'
import type { NotesSource } from './source.js'

export interface NotesDeps { env: Record<string, string | undefined>; fetch: typeof fetch; redact: boolean; home: string }

/** A listed source; `source` is null for an MCP server without an adapter, which cannot be searched. */
export interface NotesSourceEntry { id: string; name: string; kind: 'joplin' | 'folder' | 'mcp'; enabled: boolean; source: NotesSource | null }

const MCP_HINTS = ['joplin', 'obsidian', 'notion', 'llm-wiki', 'llmwiki', 'wiki', 'notes', 'note', 'knowledge', 'kb', 'readwise', 'logseq']

/**
 * Joplin when a `joplin` MCP server or `JOPLIN_TOKEN` configures it, each `webui_notes_folders` folder, then every other
 * MCP server whose name hints at notes.
 */
export function notesSourcesFor(config: Config, deps: NotesDeps): NotesSourceEntry[] {
  const joplin = joplinServer(config)
  const adapters: NotesSource[] = [
    ...(joplin || deps.env.JOPLIN_TOKEN ? [joplinSource({ config, env: deps.env, fetch: deps.fetch, redact: deps.redact })] : []),
    ...notesFolders(config, deps.env, deps.home).map((folder) => folderSource(folder, deps.redact)),
  ]
  const mcp = Object.entries(dict(config.mcp_servers))
    .filter(([name]) => name !== joplin?.[0] && MCP_HINTS.some((h) => name.toLowerCase().includes(h)))
    .map(([name, cfg]): NotesSourceEntry => ({ id: name, name, kind: 'mcp', enabled: mcpServerEnabled(cfg), source: null }))
  return [...adapters.map((source): NotesSourceEntry => ({ id: source.id, name: source.name, kind: source.kind, enabled: true, source })), ...mcp]
}

/** `GET /api/notes/sources`: each source says whether it can be searched. */
export function notesSources(config: Config, enabled: boolean, deps: NotesDeps): Dict {
  if (!enabled) return { enabled: false, sources: [], source: 'disabled', inventory_scope: 'disabled_by_default', attach_supported: false, automatic_recall_unchanged: true, recent_ai_notes: [] }
  const sources = notesSourcesFor(config, deps).map(({ id, name, kind, enabled: on, source }) => ({ id, name, kind, enabled: on, searchable: source !== null, tools: [] }))
  return { enabled: true, sources, source: sources.length ? 'config' : 'none', inventory_scope: 'already_known_runtime_only', attach_supported: false, automatic_recall_unchanged: true, recent_ai_notes: [] }
}
