/** The Joplin Web Clipper adapter (Python `_joplin_*`). */
import { dict, isDict, type Config, type Dict } from '../../config/agent-config.js'
import { readCapped } from '../../http/capped.js'
import { redactString } from '../../redact.js'
import { str } from '../../util.js'
import { safeText } from '../mcp.js'
import { noteSnippet, NotesSourceError, previewBody, searchLimit, type NotesSource } from './source.js'

export interface JoplinDeps { config: Config; env: Record<string, string | undefined>; fetch: typeof fetch; redact: boolean }

/** The `joplin` MCP server's config (name matched case-insensitively), if any. */
export const joplinServer = (config: Config): [string, unknown] | undefined =>
  Object.entries(dict(config.mcp_servers)).find(([name]) => name.trim().toLowerCase() === 'joplin')

/** Python `_joplin_connection_from_config`: the `joplin` MCP server's env, then the process env. */
function joplinConnection(config: Config, env: Record<string, string | undefined>): { url: string; token: string } {
  const serverEnv = dict(dict(joplinServer(config)?.[1]).env)
  return { url: (str(serverEnv.JOPLIN_URL) || env.JOPLIN_URL || 'http://127.0.0.1:41184').replace(/\/+$/, ''), token: str(serverEnv.JOPLIN_TOKEN) || env.JOPLIN_TOKEN || '' }
}

/**
 * Python `_joplin_api_get`: the token rides in the `Authorization` header, and in the query only for `/search`, which
 * some Web Clipper builds refuse without it. 8 s timeout, 2,000,000-byte read cap; failures carry no URL or token.
 */
async function joplinGet(config: Config, env: Record<string, string | undefined>, fetchImpl: typeof fetch, path: string, params: Record<string, string | number>): Promise<Dict> {
  const { url, token } = joplinConnection(config, env)
  if (!token) throw new NotesSourceError('Joplin token is not configured')
  const safePath = '/' + path.replace(/^\/+/, '')
  const query = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]))
  if (safePath === '/search') query.set('token', token)
  let raw: Buffer | null
  try {
    const res = await fetchImpl(`${url}${safePath}?${query.toString()}`, { headers: { Authorization: `token ${token}` }, signal: AbortSignal.timeout(8000) })
    if (!res.ok) {
      await res.body?.cancel()
      throw new NotesSourceError(`Joplin API returned HTTP ${String(res.status)}`)
    }
    raw = await readCapped(res, 2_000_000)
  } catch (error) {
    if (error instanceof NotesSourceError) throw error
    throw new NotesSourceError('Joplin API is not reachable')
  }
  let data: unknown
  try { data = JSON.parse(raw?.toString('utf8') ?? '') } catch { throw new NotesSourceError('Joplin API returned invalid JSON') }
  return isDict(data) ? data : {}
}

/** Python `_joplin_search_notes`: up to `limit` (1-50) notes; an empty query asks Joplin nothing. */
export async function joplinSearch(deps: JoplinDeps, rawQuery: string, limit: number): Promise<Dict[]> {
  const query = rawQuery.trim()
  if (!query) return []
  const data = await joplinGet(deps.config, deps.env, deps.fetch, '/search', { query, type: 'note', fields: 'id,title,body,parent_id,updated_time', limit: searchLimit(limit) })
  const results: Dict[] = []
  for (const row of Array.isArray(data.items) ? data.items : []) {
    if (!isDict(row)) continue
    const id = safeText(row.id, 64)
    if (!id) continue
    results.push({ id, title: safeText(row.title || 'Untitled', 180), snippet: safeText(noteSnippet(str(row.body), query), 260), parent_id: safeText(row.parent_id, 64), updated_time: row.updated_time ?? null, source: 'joplin' })
  }
  return results
}

/** Python `_joplin_get_note`: the id is checked before it reaches the URL; the body is cut at 50,000 characters, then redacted. */
export async function joplinNote(deps: JoplinDeps, rawId: string): Promise<Dict> {
  const id = rawId.trim()
  if (!/^[A-Za-z0-9]{16,64}$/.test(id)) throw new NotesSourceError('Invalid Joplin note id')
  const data = await joplinGet(deps.config, deps.env, deps.fetch, `/notes/${id}`, { fields: 'id,title,body,parent_id,updated_time,created_time' })
  if (!data.id) throw new NotesSourceError('Joplin note not found')
  return { id: safeText(data.id, 64), title: safeText(data.title || 'Untitled', 180), body: redactString(previewBody(str(data.body)), deps.redact), parent_id: safeText(data.parent_id, 64), updated_time: data.updated_time ?? null, created_time: data.created_time ?? null, source: 'joplin' }
}

export function joplinSource(deps: JoplinDeps): NotesSource {
  return { id: 'joplin', name: 'Joplin', kind: 'joplin', search: (query, limit) => joplinSearch(deps, query, limit), item: (id) => joplinNote(deps, id) }
}
