/**
 * Joplin note preview and search, and the LLM wiki status, browse, and page routes (TAL-264): the pre-rewrite status
 * codes and shapes, the Joplin token kept out of every non-search URL, and only allowlisted wiki pages ever served.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'

type Json = Record<string, unknown>
const json = async (res: Response): Promise<Json> => (await res.json()) as Json
const NOTE_ID = 'abc123def4567890'

function write(path: string, text = '# Synthetic\n'): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

describe('notes and wiki routes', () => {
  let s: TestServer
  const configs = new Map<string, Json>()
  let joplin: Server
  let joplinUrl = ''
  const seen: { url: string; authorization: string | undefined }[] = []
  let reply: (req: IncomingMessage) => { status: number; body: string } = () => ({ status: 404, body: '{}' })
  let tmp = ''

  beforeAll(async () => {
    joplin = createServer((req, res) => {
      seen.push({ url: req.url ?? '', authorization: req.headers.authorization })
      const { status, body } = reply(req)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body)
    })
    await new Promise<void>((done) => joplin.listen(0, '127.0.0.1', done))
    joplinUrl = `http://127.0.0.1:${String((joplin.address() as AddressInfo).port)}/`
    const sidecar = new FakeSidecar()
    sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: configs.get(params.profile_home) ?? {} }))
    s = await bootTestServer({ sidecar })
  })
  afterAll(async () => {
    await s.close()
    await new Promise((done) => joplin.close(done))
  })
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'talaria-notes-wiki-')))
    seen.length = 0
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    Reflect.deleteProperty(s.deps.config.env, 'HERMES_WEBUI_EXTERNAL_NOTES_SOURCES')
    Reflect.deleteProperty(s.deps.config.env, 'WIKI_PATH')
    configs.clear()
  })

  const enableJoplin = (env: Json = { JOPLIN_URL: joplinUrl, JOPLIN_TOKEN: 'secret-token' }): void => {
    s.deps.config.env.HERMES_WEBUI_EXTERNAL_NOTES_SOURCES = '1'
    configs.set(s.state, { mcp_servers: { Joplin: { command: 'joplin-mcp', env } } })
    // config.yaml reads are memoised on the file's identity; a fresh body evicts them.
    writeFileSync(join(s.state, 'config.yaml'), `# ${String(Math.random())}\n`)
  }

  describe('GET /api/notes/item', () => {
    it('is 404 while external notes sources are disabled', async () => {
      const res = await s.get(`/api/notes/item?id=${NOTE_ID}`)
      expect(res.status).toBe(404)
      expect(await json(res)).toEqual({ error: 'External notes sources are disabled.', source: 'disabled' })
    })

    it('validates the id, truncates the body, and keeps the token out of the URL [py:test_joplin_get_note_validates_id_and_truncates_body] [py:test_joplin_api_get_keeps_non_search_token_out_of_url]', async () => {
      enableJoplin()
      reply = () => ({ status: 200, body: JSON.stringify({ id: NOTE_ID, title: 'Big Note', body: 'x'.repeat(60_000), parent_id: 'folder123', updated_time: 456, created_time: 123 }) })
      const res = await s.get(`/api/notes/item?id=${NOTE_ID}`)
      expect(res.status).toBe(200)
      const body = await json(res)
      const note = body.note as Json
      expect(body.source).toBe('joplin')
      expect(note).toMatchObject({ id: NOTE_ID, title: 'Big Note', parent_id: 'folder123', updated_time: 456, created_time: 123, source: 'joplin' })
      expect((note.body as string).length).toBeLessThan(51_000)
      expect(note.body).toContain('[Preview truncated at 50,000 characters]')
      expect(seen).toHaveLength(1)
      expect(seen[0]?.url).toBe(`/notes/${NOTE_ID}?fields=id%2Ctitle%2Cbody%2Cparent_id%2Cupdated_time%2Ccreated_time`)
      expect(seen[0]?.url).not.toContain('token=')
      expect(seen[0]?.authorization).toBe('token secret-token')
    })

    it('rejects a malformed id before any request, and other sources', async () => {
      enableJoplin()
      for (const id of ['../search', 'short', 'abc123def4567890/../x', 'a'.repeat(65)]) {
        const res = await s.get(`/api/notes/item?id=${encodeURIComponent(id)}`)
        expect(res.status).toBe(502)
        expect(await json(res)).toEqual({ error: 'Invalid Joplin note id', source: 'joplin' })
      }
      expect(seen).toEqual([])
      const res = await s.get(`/api/notes/item?source=obsidian&id=${NOTE_ID}`)
      expect(res.status).toBe(400)
      expect(await json(res)).toEqual({ error: 'Preview is currently implemented for Joplin sources only.', source: 'obsidian' })
    })

    it('redacts the body and bounds the display fields', async () => {
      enableJoplin()
      reply = () => ({ status: 200, body: JSON.stringify({ id: NOTE_ID, title: `Authorization: Bearer abcdef ${'t'.repeat(300)}`, body: 'export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789', parent_id: 'p'.repeat(100) }) })
      const note = (await json(await s.get(`/api/notes/item?id=${NOTE_ID}`))).note as Json
      expect(note.body).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789')
      expect(note.title).not.toContain('abcdef')
      expect((note.title as string).length).toBeLessThanOrEqual(180)
      expect((note.parent_id as string).length).toBeLessThanOrEqual(64)
    })

    it('maps Joplin failures to 502 with a fixed message', async () => {
      enableJoplin()
      reply = () => ({ status: 500, body: 'boom' })
      let res = await s.get(`/api/notes/item?id=${NOTE_ID}`)
      expect(res.status).toBe(502)
      expect(await json(res)).toEqual({ error: 'Joplin API returned HTTP 500', source: 'joplin' })
      reply = () => ({ status: 200, body: 'not json' })
      expect(await json(await s.get(`/api/notes/item?id=${NOTE_ID}`))).toEqual({ error: 'Joplin API returned invalid JSON', source: 'joplin' })
      reply = () => ({ status: 200, body: '{}' })
      expect(await json(await s.get(`/api/notes/item?id=${NOTE_ID}`))).toEqual({ error: 'Joplin note not found', source: 'joplin' })
      enableJoplin({ JOPLIN_URL: 'http://127.0.0.1:9', JOPLIN_TOKEN: 'secret-token' })
      expect(await json(await s.get(`/api/notes/item?id=${NOTE_ID}`))).toEqual({ error: 'Joplin API is not reachable', source: 'joplin' })
      enableJoplin({ JOPLIN_URL: joplinUrl })
      res = await s.get(`/api/notes/item?id=${NOTE_ID}`)
      expect(res.status).toBe(502)
      expect(await json(res)).toEqual({ error: 'Joplin token is not configured', source: 'joplin' })
      expect(s.logs.join('\n')).not.toContain('secret-token')
    })
  })

  describe('GET /api/notes/search', () => {
    it('sends the header and the query token for Web Clipper search compatibility [py:test_joplin_api_get_sends_header_and_query_token_for_clip_search_compat]', async () => {
      enableJoplin()
      reply = () => ({ status: 200, body: JSON.stringify({ items: [{ id: NOTE_ID, title: 'Hermes Context', body: 'This is a long Hermes context note with useful details.', parent_id: 'folder123', updated_time: 123 }, { title: 'no id' }] }) })
      const res = await s.get('/api/notes/search?q=hello%20world&limit=500')
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({ source: 'joplin', query: 'hello world', results: [{ id: NOTE_ID, title: 'Hermes Context', snippet: 'This is a long Hermes context note with useful details.', parent_id: 'folder123', updated_time: 123, source: 'joplin' }] })
      expect(seen[0]?.url).toContain('token=secret-token')
      expect(seen[0]?.url).toContain('query=hello+world')
      expect(seen[0]?.url).toContain('limit=50')
      expect(seen[0]?.authorization).toBe('token secret-token')
    })

    it('answers an empty query without calling Joplin, and maps failures to 502', async () => {
      enableJoplin()
      expect(await json(await s.get('/api/notes/search?q=%20'))).toEqual({ source: 'joplin', query: '', results: [] })
      expect(seen).toEqual([])
      enableJoplin({ JOPLIN_URL: 'http://127.0.0.1:9', JOPLIN_TOKEN: 'secret-token' })
      const res = await s.get('/api/notes/search?q=x')
      expect(res.status).toBe(502)
      expect(await json(res)).toEqual({ error: 'Joplin API is not reachable', source: 'joplin', query: 'x', results: [] })
      expect((await s.get('/api/notes/search?source=notion&q=x')).status).toBe(400)
    })
  })

  describe('GET /api/wiki/status', () => {
    it('summarizes a synthetic wiki without exposing page text or the path [py:test_llm_wiki_status_reads_synthetic_fixture_without_exposing_content] [py:test_api_wiki_status_route_is_registered]', async () => {
      const wiki = join(tmp, 'wiki')
      write(join(wiki, 'SCHEMA.md'), '# Schema\n')
      write(join(wiki, 'index.md'), '# Index\n')
      write(join(wiki, 'log.md'), '# Log\n## [2026-05-04] update | Secret project name\n- Details stay private\n')
      write(join(wiki, 'entities', 'private-agent.md'), '---\ntitle: Private Agent\nupdated: 2026-05-04\n---\nSensitive body text must not ship.\n')
      write(join(wiki, 'concepts', 'safe-summary.md'), '---\ntitle: Safe Summary\n---\nMore private text\n')
      write(join(wiki, 'raw', 'articles', 'source.md'), 'Raw source body should not count as wiki page\n')
      s.deps.config.env.WIKI_PATH = wiki
      const res = await s.get('/api/wiki/status')
      expect(res.status).toBe(200)
      const status = await json(res)
      expect(status).toMatchObject({ available: true, enabled: true, status: 'ready', entry_count: 2, page_count: 2, raw_source_count: 1, last_writer: 'ai-agent (update)', path_configured: true, path_source: 'WIKI_PATH', toggle_available: false })
      expect(status.last_updated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{6})?Z$/)
      expect(String(status.docs_url)).toMatch(/\/research-llm-wiki$/)
      const serialized = JSON.stringify(status)
      expect(serialized).not.toContain('Sensitive body text')
      expect(serialized).not.toContain('Secret project name')
      expect(serialized).not.toContain(wiki)
    })

    it('reports a missing path as unavailable [py:test_llm_wiki_status_reports_unavailable_when_path_missing]', async () => {
      s.deps.config.env.WIKI_PATH = join(tmp, 'does-not-exist')
      expect(await json(await s.get('/api/wiki/status'))).toMatchObject({ available: false, enabled: false, status: 'missing', entry_count: 0, page_count: 0, raw_source_count: 0, last_updated: null })
      s.deps.config.env.WIKI_PATH = write(join(tmp, 'file'))
      expect(await json(await s.get('/api/wiki/status'))).toMatchObject({ available: false, status: 'not_directory' })
    })

    it('reads the last writer from page frontmatter [py:test_last_writer_reads_frontmatter]', async () => {
      const wiki = join(tmp, 'wiki')
      write(join(wiki, 'entities', 'a.md'), '---\ntitle: A\nupdated_by: alice\n---\nbody\n')
      s.deps.config.env.WIKI_PATH = wiki
      expect(await json(await s.get('/api/wiki/status'))).toMatchObject({ status: 'ready', last_writer: 'alice' })
    })

    it('rechecks cached page targets [py:test_llm_wiki_status_rechecks_cached_page_targets]', async () => {
      const wiki = join(tmp, 'wiki')
      const page = write(join(wiki, 'concepts', 'sub', 'real.md'), '---\nauthor: public\n---\nbody\n')
      write(join(wiki, '.env'), '---\nauthor: hidden-author\n---\nPRIVATE=1\n')
      s.deps.config.env.WIKI_PATH = wiki
      expect(await json(await s.get('/api/wiki/status'))).toMatchObject({ page_count: 1, last_writer: 'public' })
      unlinkSync(page)
      symlinkSync(join('..', '..', '.env'), page)
      const status = await json(await s.get('/api/wiki/status'))
      expect(status).toMatchObject({ page_count: 0, last_writer: 'ai-agent' })
      expect(JSON.stringify(status)).not.toContain('hidden-author')
    })

    it('drops a cached entry replaced by a directory [py:test_llm_wiki_status_drops_cached_entry_replaced_by_directory]', async () => {
      const wiki = join(tmp, 'wiki')
      const page = write(join(wiki, 'concepts', 'sub', 'real.md'), '---\nauthor: public\n---\nbody\n')
      s.deps.config.env.WIKI_PATH = wiki
      expect(await json(await s.get('/api/wiki/status'))).toMatchObject({ page_count: 1 })
      unlinkSync(page)
      mkdirSync(page)
      expect(await json(await s.get('/api/wiki/status'))).toMatchObject({ page_count: 0, last_writer: 'ai-agent' })
    })

    it('never reads a log.md that is a symlink [py:test_llm_wiki_status_log_heading_rechecks_preopen_symlink_swap] [py:test_llm_wiki_status_last_updated_rechecks_status_file_identity]', async () => {
      const wiki = join(tmp, 'wiki')
      write(join(wiki, '.env'), '## [2026-06-19] leak | hidden\n')
      symlinkSync('.env', join(wiki, 'log.md'))
      s.deps.config.env.WIKI_PATH = wiki
      expect(await json(await s.get('/api/wiki/status'))).toMatchObject({ status: 'empty', last_writer: 'ai-agent', last_updated: null })
    })

    it('never reads frontmatter through a page symlinked outside the wiki [py:test_last_writer_rejects_symlink_outside_wiki]', async () => {
      write(join(tmp, 'outside', 'private.md'), '---\nauthor: outside-secret\n---\nprivate body\n')
      mkdirSync(join(tmp, 'wiki', 'entities'), { recursive: true })
      symlinkSync(join(tmp, 'outside', 'private.md'), join(tmp, 'wiki', 'entities', 'linked.md'))
      s.deps.config.env.WIKI_PATH = join(tmp, 'wiki')
      const status = await json(await s.get('/api/wiki/status'))
      expect(status).toMatchObject({ page_count: 0, last_writer: 'ai-agent' })
      expect(JSON.stringify(status)).not.toContain('outside-secret')
    })
  })

  describe('GET /api/wiki/browse and /api/wiki/page', () => {
    const page = async (path: string): Promise<{ status: number; text: string }> => {
      const res = await s.get(`/api/wiki/page?path=${path}`)
      return { status: res.status, text: await res.text() }
    }
    const browse = async (): Promise<string[]> => ((await json(await s.get('/api/wiki/browse'))).pages as Json[]).map((p) => String(p.path))

    it('lists allowlisted pages sorted case-insensitively and serves them', async () => {
      const wiki = join(tmp, 'wiki')
      write(join(wiki, 'concepts', 'b.md'), '# b\n')
      write(join(wiki, 'entities', 'A.md'), '# A\n')
      write(join(wiki, 'queries', 'nested', 'c.md'), '# c\n')
      write(join(wiki, 'concepts', 'notes.txt'), 'not a page')
      write(join(wiki, 'drafts', 'd.md'), 'not a section')
      s.deps.config.env.WIKI_PATH = wiki
      const res = await s.get('/api/wiki/browse')
      expect(res.status).toBe(200)
      const pages = (await json(res)).pages as Json[]
      expect(pages.map((p) => p.path)).toEqual(['concepts/b.md', 'entities/A.md', 'queries/nested/c.md'])
      expect(pages[0]).toEqual({ name: 'b.md', path: 'concepts/b.md', size: 4, mtime: expect.any(Number) as number })
      expect(await json(await s.get('/api/wiki/page?path=queries/nested/c.md'))).toEqual({ content: '# c\n', path: 'queries/nested/c.md' })
      for (const path of ['concepts/notes.txt', 'drafts/d.md']) expect((await page(path)).status).toBe(404)
    })

    it('is 404 when the root is missing and 400 without a path', async () => {
      s.deps.config.env.WIKI_PATH = join(tmp, 'missing')
      const res = await s.get('/api/wiki/browse')
      expect(res.status).toBe(404)
      expect(await json(res)).toEqual({ error: 'Wiki not configured or directory not found' })
      const missing = await s.get('/api/wiki/page')
      expect(missing.status).toBe(400)
      expect(await json(missing)).toEqual({ error: 'Wiki not configured or path not provided' })
    })

    it('answers 4xx, never 500, when the root cannot be read', async () => {
      write(join(tmp, 'locked', 'wiki', 'concepts', 'real.md'))
      chmodSync(join(tmp, 'locked'), 0o000)
      try {
        s.deps.config.env.WIKI_PATH = join(tmp, 'locked', 'wiki')
        expect((await s.get('/api/wiki/browse')).status).toBe(404)
        expect((await page('concepts/real.md')).status).toBe(404)
        expect(await json(await s.get('/api/wiki/status'))).toMatchObject({ available: false, status: 'missing' })
      } finally {
        chmodSync(join(tmp, 'locked'), 0o755)
      }
    })

    it('rejects traversal segments and absolute paths [py:test_wiki_page_path_traversal_rejection] [py:test_wiki_browse_route_exists_in_routes] [py:test_wiki_page_route_exists_in_routes]', async () => {
      const wiki = join(tmp, 'wiki')
      write(join(wiki, 'concepts', 'real.md'))
      write(join(tmp, 'secret.md'), 'traversal_marker')
      s.deps.config.env.WIKI_PATH = wiki
      for (const path of ['../secret.md', 'concepts/../../secret.md', '..', encodeURIComponent(join(tmp, 'secret.md'))]) {
        const res = await page(path)
        expect(res.status).toBe(400)
        expect(res.text).not.toContain('traversal_marker')
      }
    })

    it('serves only listed pages: no .env, no .git/config [py:test_wiki_page_read_is_restricted_to_listed_pages]', async () => {
      const wiki = join(tmp, 'wiki')
      write(join(wiki, 'concepts', 'real.md'), '# real page\n')
      write(join(wiki, '.env'), 'DONOTLEAK=secretmarker_abc\n')
      write(join(wiki, '.git', 'config'), '[remote] secretmarker_git\n')
      write(join(wiki, 'concepts', '.hidden.md'), 'secretmarker_hidden\n')
      s.deps.config.env.WIKI_PATH = wiki
      for (const path of ['.env', '.git/config', 'concepts/.hidden.md']) {
        const res = await page(path)
        expect(res.status).toBe(404)
        expect(res.text).not.toContain('secretmarker')
      }
      const res = await page('concepts/real.md')
      expect(res.status).toBe(200)
      expect(res.text).toContain('real page')
    })

    it('refuses a page symlink that escapes its section [py:test_wiki_symlink_page_cannot_escape_section_root]', async () => {
      const wiki = join(tmp, 'wiki')
      write(join(wiki, 'concepts', 'real.md'), '# real\n')
      write(join(wiki, '.env'), 'DONOTLEAK=leak_marker_xyz\n')
      symlinkSync(join('..', '.env'), join(wiki, 'concepts', 'leak.md'))
      s.deps.config.env.WIKI_PATH = wiki
      expect(await browse()).toEqual(['concepts/real.md'])
      const res = await page('concepts/leak.md')
      expect(res.status).toBe(404)
      expect(res.text).not.toContain('leak_marker')
    })

    it('refuses a page symlink to a hidden file in the same section [py:test_wiki_symlink_to_hidden_same_section_target_blocked]', async () => {
      const wiki = join(tmp, 'wiki')
      write(join(wiki, 'concepts', '.hidden', 'secret.md'), 'DONOTLEAK=hidden_marker_q\n')
      write(join(wiki, 'concepts', 'real.md'), '# real\n')
      symlinkSync(join('.hidden', 'secret.md'), join(wiki, 'concepts', 'link.md'))
      s.deps.config.env.WIKI_PATH = wiki
      expect(await browse()).toEqual(['concepts/real.md'])
      const res = await page('concepts/link.md')
      expect(res.status).toBe(404)
      expect(res.text).not.toContain('hidden_marker_q')
    })

    it('rechecks a cached nested entry swapped to an escaping symlink [py:test_wiki_page_cached_nested_entry_rechecks_resolved_containment] [py:test_wiki_browse_cached_entry_rechecks_resolved_containment]', async () => {
      const wiki = join(tmp, 'wiki')
      const real = write(join(wiki, 'concepts', 'sub', 'real.md'), '# real\n')
      write(join(wiki, '.env'), 'DONOTLEAK=stale_cache_marker\n')
      s.deps.config.env.WIKI_PATH = wiki
      expect(await browse()).toEqual(['concepts/sub/real.md'])
      unlinkSync(real)
      symlinkSync(join('..', '..', '.env'), real)
      const res = await page('concepts/sub/real.md')
      expect(res.status).toBe(404)
      expect(res.text).not.toContain('stale_cache_marker')
      expect(await browse()).toEqual([])
    })

    it('refuses a cached page swapped to a hard link of an outside file [py:test_wiki_page_cached_entry_rejects_hardlink_swap_to_outside]', async () => {
      const wiki = join(tmp, 'wiki')
      const real = write(join(wiki, 'concepts', 'page.md'), '# real\n')
      const outside = write(join(tmp, 'outside_secret'), 'DONOTLEAK=hardlink_cache_marker\n')
      s.deps.config.env.WIKI_PATH = wiki
      expect(await browse()).toEqual(['concepts/page.md'])
      unlinkSync(real)
      linkSync(outside, real)
      const res = await page('concepts/page.md')
      expect(res.status).toBe(404)
      expect(res.text).not.toContain('hardlink_cache_marker')
      expect(await browse()).toEqual([])
    })

    it('drops a cached entry replaced by a directory [py:test_wiki_browse_drops_cached_entry_replaced_by_directory]', async () => {
      const wiki = join(tmp, 'wiki')
      const real = write(join(wiki, 'concepts', 'sub', 'real.md'), '# real\n')
      s.deps.config.env.WIKI_PATH = wiki
      expect(await browse()).toEqual(['concepts/sub/real.md'])
      unlinkSync(real)
      mkdirSync(real)
      expect(await browse()).toEqual([])
      expect((await page('concepts/sub/real.md')).status).toBe(404)
    })

    it('refuses a cached entry swapped to another section or another listed page [py:test_wiki_page_cached_entry_cannot_jump_sections] [py:test_wiki_page_cached_entry_cannot_jump_to_other_allowlisted_page]', async () => {
      const wiki = join(tmp, 'wiki')
      const real = write(join(wiki, 'concepts', 'sub', 'real.md'), '# real\n')
      write(join(wiki, 'drafts', 'page.md'), 'cross_section_marker')
      write(join(wiki, 'entities', 'page.md'), 'allowlisted_elsewhere_marker')
      s.deps.config.env.WIKI_PATH = wiki
      expect(await browse()).toEqual(['concepts/sub/real.md', 'entities/page.md'])
      for (const target of [join('..', '..', 'drafts', 'page.md'), join('..', '..', 'entities', 'page.md')]) {
        unlinkSync(real)
        symlinkSync(target, real)
        const res = await page('concepts/sub/real.md')
        expect(res.status).toBe(404)
        expect(res.text).not.toContain('_marker')
      }
    })

    it('serves pages through a symlinked wiki root [py:test_wiki_page_read_with_symlinked_root]', async () => {
      write(join(tmp, 'real-wiki', 'concepts', 'real.md'), '# real\n')
      symlinkSync(join(tmp, 'real-wiki'), join(tmp, 'link-wiki'))
      s.deps.config.env.WIKI_PATH = join(tmp, 'link-wiki')
      const res = await s.get('/api/wiki/page?path=concepts/real.md')
      expect(res.status).toBe(200)
      expect((await json(res)).content).toBe('# real\n')
    })

    it('exposes nothing through a symlinked section [py:test_wiki_symlinked_section_cannot_expose_outside_tree]', async () => {
      write(join(tmp, 'outside', 'leak.md'), 'DONOTLEAK=outside_marker_z\n')
      mkdirSync(join(tmp, 'wiki'))
      symlinkSync(join(tmp, 'outside'), join(tmp, 'wiki', 'concepts'))
      s.deps.config.env.WIKI_PATH = join(tmp, 'wiki')
      expect(await browse()).toEqual([])
      const res = await page('concepts/leak.md')
      expect(res.status).toBe(400)
      expect(res.text).not.toContain('outside_marker_z')
    })

    it('opens a filename that merely contains .. [py:test_wiki_legit_filename_with_dotdot_substring_opens]', async () => {
      write(join(tmp, 'wiki', 'concepts', 'v1..v2.md'), '# diff notes\n')
      s.deps.config.env.WIKI_PATH = join(tmp, 'wiki')
      const res = await page('concepts/v1..v2.md')
      expect(res.status).toBe(200)
      expect(res.text).toContain('diff notes')
    })

    it('rejects alias spellings [py:test_wiki_page_alias_spellings_are_rejected]', async () => {
      write(join(tmp, 'wiki', 'concepts', 'real.md'), '# real\n')
      s.deps.config.env.WIKI_PATH = join(tmp, 'wiki')
      for (const alias of ['concepts/./real.md', 'concepts//real.md', 'concepts/real.md/', 'concepts%5Creal.md']) expect((await page(alias)).status).toBe(400)
    })

    it('truncates a page at 2 MiB', async () => {
      write(join(tmp, 'wiki', 'concepts', 'big.md'), 'y'.repeat(2 * 1024 * 1024 + 10))
      s.deps.config.env.WIKI_PATH = join(tmp, 'wiki')
      expect(((await json(await s.get('/api/wiki/page?path=concepts/big.md'))).content as string).length).toBe(2 * 1024 * 1024)
    })

    it('refuses to walk a system root', async () => {
      s.deps.config.env.WIKI_PATH = '/etc'
      expect(await browse()).toEqual([])
      expect(await json(await s.get('/api/wiki/status'))).toMatchObject({ status: 'empty', page_count: 0, raw_source_count: 0 })
      expect(existsSync('/etc')).toBe(true)
    })
  })
})
