/**
 * Markdown-folder notes (Obsidian vaults, Logseq graphs) from the operator's `webui_notes_folders` in config.yaml.
 * Pages are read through the wiki's hardened allowlist reader: every `*.md` under the root outside dot directories
 * (`.obsidian`, `.trash`) and Logseq's `logseq/bak`, single-link, contained, identity-checked, 2 MiB per page.
 */
import { basename, dirname, isAbsolute } from 'node:path'
import { isDict, type Config, type Dict } from '../../config/agent-config.js'
import { redactString } from '../../redact.js'
import { HttpFailure } from '../../sessions/service.js'
import { sessionSearchMatches, sessionSearchTerms } from '../../sessions/storage/search-text.js'
import { str } from '../../util.js'
import { expandHome } from '../../workspace/paths.js'
import { safeText } from '../mcp.js'
import { expandVars, WikiPages } from '../wiki.js'
import { noteSnippet, previewBody, searchLimit, type NotesSource } from './source.js'

/** The process-wide allowlist cache for notes folders, apart from the wiki's (a different page rule over the same roots). */
export const folderPages = new WikiPages({ rule: { sections: [''], include: (rel) => rel !== 'logseq/bak' && !rel.startsWith('logseq/bak/') } })

/** The configured folders, `~` and env vars expanded; an entry without a name or an absolute path is skipped, and a repeated name keeps the first. */
export function notesFolders(config: Config, env: Record<string, string | undefined>, home: string): { name: string; path: string }[] {
  const folders = new Map<string, { name: string; path: string }>()
  for (const row of Array.isArray(config.webui_notes_folders) ? config.webui_notes_folders : []) {
    if (!isDict(row)) continue
    const name = str(row.name).trim()
    const path = expandHome(expandVars(str(row.path).trim(), env), home)
    if (name && isAbsolute(path) && !folders.has(name.toLowerCase())) folders.set(name.toLowerCase(), { name, path })
  }
  return [...folders.values()]
}

const parentOf = (rel: string): string => (dirname(rel) === '.' ? '' : dirname(rel))

export function folderSource(folder: { name: string; path: string }, redact: boolean, pages = folderPages): NotesSource {
  const id = `folder:${folder.name}`
  return {
    id, name: folder.name, kind: 'folder',
    /** Newest first; a note matches when its title (the file stem) or its body holds every term. */
    async search(rawQuery, limit) {
      const query = rawQuery.trim()
      const terms = sessionSearchTerms(query)
      if (!terms.length) return []
      const hits: { mtimeMs: number; row: Dict }[] = []
      // ponytail: reads every allowlisted page per search; add an mtime-keyed text cache if vaults near the 10,000-file cap feel slow.
      for (const [rel, entry] of await pages.allowlistedEntries(folder.path)) {
        const page = await pages.readEntry(entry)
        const title = basename(rel, '.md')
        if (!page || !(sessionSearchMatches(title, terms) || sessionSearchMatches(page.content, terms))) continue
        hits.push({ mtimeMs: page.mtimeMs, row: { id: rel, title: safeText(title || 'Untitled', 180), snippet: safeText(noteSnippet(page.content, query), 260), parent_id: parentOf(rel), updated_time: Math.round(page.mtimeMs), source: id } })
      }
      return hits.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, searchLimit(limit)).map((hit) => hit.row)
    },
    /** `rel` under the root, checked by the wiki page rules; the body is cut at 50,000 characters, then redacted. */
    async item(rel) {
      if (!rel) throw new HttpFailure(400, 'Invalid path')
      const page = await pages.read(folder.path, rel)
      return { id: rel, title: safeText(basename(rel, '.md') || 'Untitled', 180), body: redactString(previewBody(page.content), redact), parent_id: parentOf(rel), updated_time: Math.round(page.mtimeMs), created_time: null, source: id }
    },
  }
}
