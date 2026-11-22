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
import { expandVars, WikiPages, type PageRule } from '../wiki.js'
import { noteSnippet, NotesSourceError, previewBody, searchLimit, type NotesSource } from './source.js'

/** Every page under the root but Logseq's `logseq/bak` (dot directories are never listed). */
export const FOLDER_RULE = { sections: [''], include: (rel: string): boolean => rel !== 'logseq/bak' && !rel.startsWith('logseq/bak/') } satisfies PageRule

/** The process-wide allowlist cache for notes folders, apart from the wiki's (a different page rule over the same roots). */
export const folderPages = new WikiPages({ rule: FOLDER_RULE })

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

/** Text one search reads at most, newest pages first; a vault past it is searched only as far back as it reaches. */
export const MAX_SCAN_BYTES = 64 * 1024 * 1024

/** The scan running or queued last per folder root: one search reads a folder at a time. */
const scans = new Map<string, Promise<unknown>>()

function oneScanAt<T>(root: string, scan: () => Promise<T>): Promise<T> {
  const next = (scans.get(root) ?? Promise.resolve()).catch(() => undefined).then(scan)
  scans.set(root, next)
  const forget = (): void => { if (scans.get(root) === next) scans.delete(root) }
  next.then(forget, forget)
  return next
}

export function folderSource(folder: { name: string; path: string }, redact: boolean, pages = folderPages, scanBytes = MAX_SCAN_BYTES): NotesSource {
  const id = `folder:${folder.name}`
  return {
    id, name: folder.name, kind: 'folder',
    /**
     * Newest first; a note matches when its title (the file stem) or its body holds every term. Pages are read newest
     * first until `limit` match or `scanBytes` is spent, one search per folder at a time, stopping once `signal` aborts.
     */
    search(rawQuery, limit, signal) {
      const query = rawQuery.trim()
      const terms = sessionSearchTerms(query)
      if (!terms.length) return Promise.resolve([])
      return oneScanAt(folder.path, async () => {
        const want = searchLimit(limit)
        const entries = await Promise.all([...await pages.allowlistedEntries(folder.path)].map(async ([rel, entry]) => ({ rel, entry, mtimeMs: await pages.mtimeOf(entry) ?? 0 })))
        const hits: Dict[] = []
        let left = scanBytes
        // ponytail: reads pages per search within the byte budget; add an mtime-keyed text cache if large vaults feel slow.
        for (const { rel, entry } of entries.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
          if (signal?.aborted) throw new NotesSourceError('Search was cancelled')
          if (hits.length >= want || left <= 0) break
          const page = await pages.readEntry(entry)
          if (!page) continue
          left -= Buffer.byteLength(page.content)
          const title = basename(rel, '.md')
          if (sessionSearchMatches(title, terms) || sessionSearchMatches(page.content, terms)) hits.push({ id: rel, title: safeText(title || 'Untitled', 180), snippet: safeText(noteSnippet(page.content, query), 260), parent_id: parentOf(rel), updated_time: Math.round(page.mtimeMs), source: id })
        }
        return hits
      })
    },
    /** `rel` under the root, checked by the wiki page rules; the body is cut at 50,000 characters, then redacted. */
    async item(rel) {
      if (!rel) throw new HttpFailure(400, 'Invalid path')
      const page = await pages.read(folder.path, rel)
      return { id: rel, title: safeText(basename(rel, '.md') || 'Untitled', 180), body: redactString(previewBody(page.content), redact), parent_id: parentOf(rel), updated_time: Math.round(page.mtimeMs), created_time: null, source: id }
    },
  }
}
