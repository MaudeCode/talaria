/** LLM wiki allowlist cache, path resolution, and the identity rechecks that close swaps after the allowlist snapshot (TAL-264). */
import * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpFailure } from '../sessions/service.js'
import { resolveWikiLocation, WikiPages, type WikiLocation } from './wiki.js'

vi.mock('node:fs', { spy: true })
vi.mock('node:fs/promises', { spy: true })

const callsOf = (...fns: unknown[]): number => fns.reduce<number>((total, fn) => total + (vi.isMockFunction(fn) ? fn.mock.calls.length : 0), 0)
const pathChecks = (): number => callsOf(fs.statSync, fs.lstatSync, fs.realpathSync, fs.realpathSync.native, fsp.stat, fsp.lstat, fsp.realpath)
const dirReads = (): number => callsOf(fs.readdirSync, fs.opendirSync, fsp.readdir, fsp.opendir)

function write(path: string, text = '# Synthetic\n'): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

const failure = async (fn: () => Promise<unknown>): Promise<{ status: number; message: string } | null> => {
  try { await fn() } catch (error) { if (error instanceof HttpFailure) return { status: error.status, message: error.message }; throw error }
  return null
}

describe('LLM wiki', () => {
  let tmp = ''
  let wiki = ''
  let at: WikiLocation
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'talaria-wiki-')))
    wiki = join(tmp, 'wiki')
    at = { path: wiki, source: 'WIKI_PATH', configured: true }
  })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  describe('allowlist cache', () => {
    const listed = async (pages: WikiPages): Promise<string[]> => [...(await pages.pageFiles(wiki)).keys()]

    it('reuses the page list while no section changes [py:test_wiki_page_files_reuses_cache_with_unchanged_section_mtime]', async () => {
      const page = write(join(wiki, 'concepts', 'one.md'))
      const pages = new WikiPages({ ttlMs: 60_000 })
      const uncached = vi.spyOn(pages, 'pageFilesUncached')
      expect(await listed(pages)).toEqual([page])
      expect(await listed(pages)).toEqual([page])
      expect(uncached).toHaveBeenCalledTimes(1)
    })

    it('rebuilds when a section mtime changes [py:test_wiki_page_files_cache_invalidates_when_section_mtime_changes]', async () => {
      const first = write(join(wiki, 'concepts', 'one.md'))
      const pages = new WikiPages({ ttlMs: 60_000 })
      const uncached = vi.spyOn(pages, 'pageFilesUncached')
      expect(await listed(pages)).toEqual([first])
      const second = write(join(wiki, 'concepts', 'two.md'))
      utimesSync(join(wiki, 'concepts'), new Date(), new Date(Date.now() + 5000))
      expect((await listed(pages)).sort()).toEqual([first, second])
      expect(uncached).toHaveBeenCalledTimes(2)
    })

    it('stops walking after the file budget, counting entries that are not pages', async () => {
      for (let i = 0; i < 20; i++) write(join(wiki, 'entities', `asset-${String(i)}.txt`))
      write(join(wiki, 'concepts', 'a.md'))
      expect([...(await new WikiPages({ maxFiles: 5 }).pageFilesUncached(wiki)).keys()]).toEqual([])
      expect([...(await new WikiPages({ maxFiles: 50 }).pageFilesUncached(wiki)).keys()]).toEqual([join(wiki, 'concepts', 'a.md')])
    })

    it('expires after the TTL [py:test_wiki_page_files_cache_expires_after_ttl]', async () => {
      write(join(wiki, 'concepts', 'one.md'))
      const ticks = [100_000, 100_500, 101_500]
      const pages = new WikiPages({ ttlMs: 1000, now: () => ticks.shift() ?? 0 })
      const uncached = vi.spyOn(pages, 'pageFilesUncached')
      await pages.pageFiles(wiki)
      await pages.pageFiles(wiki)
      await pages.pageFiles(wiki)
      expect(uncached).toHaveBeenCalledTimes(2)
    })
  })

  describe('warm cache', () => {
    it('page() on a 2,000-page wiki checks only the requested page', async () => {
      for (let i = 0; i < 2000; i++) write(join(wiki, 'concepts', `p${String(i)}.md`), `# ${String(i)}\n`)
      const pages = new WikiPages({ ttlMs: 60_000 })
      expect(await pages.page(at, 'concepts/p7.md')).toEqual({ content: '# 7\n', path: 'concepts/p7.md' })
      vi.clearAllMocks()
      expect(await pages.page(at, 'concepts/p1999.md')).toEqual({ content: '# 1999\n', path: 'concepts/p1999.md' })
      expect(pathChecks()).toBeLessThanOrEqual(3)
    })

    it('status() walks an unchanged tree once and sees a new raw file once raw/ changes', async () => {
      write(join(wiki, 'concepts', 'one.md'))
      write(join(wiki, 'raw', 'a.txt'))
      write(join(wiki, 'raw', 'nested', 'b.txt'))
      const pages = new WikiPages({ ttlMs: 60_000 })
      vi.clearAllMocks()
      const first = await pages.status(at)
      expect(first).toMatchObject({ page_count: 1, raw_source_count: 2 })
      expect(dirReads()).toBeGreaterThan(0)
      vi.clearAllMocks()
      expect(await pages.status(at)).toEqual(first)
      expect(dirReads()).toBe(0)
      write(join(wiki, 'raw', 'c.txt'))
      utimesSync(join(wiki, 'raw'), new Date(), new Date(Date.now() + 5000))
      expect(await pages.status(at)).toMatchObject({ raw_source_count: 3 })
    })
  })

  describe('identity rechecks after the allowlist snapshot', () => {
    it('browse skips a page that vanished during listing [py:test_wiki_browse_skips_pages_that_disappear_during_listing]', async () => {
      const ok = write(join(wiki, 'ok.md'), '# ok\n')
      const pages = new WikiPages()
      const st = statSync(ok)
      vi.spyOn(pages, 'allowlistedEntries').mockResolvedValue(new Map([['gone.md', { target: join(wiki, 'gone.md'), dev: 0, ino: 0 }], ['ok.md', { target: ok, dev: st.dev, ino: st.ino }]]))
      expect(await pages.browse(at)).toEqual({ pages: [{ name: 'ok.md', path: 'ok.md', size: st.size, mtime: Math.floor(st.mtimeMs / 1000) }] })
    })

    it('a page that vanished before the read is 404, not 500 [py:test_wiki_page_vanished_between_check_and_read_returns_404_not_500]', async () => {
      const page = write(join(wiki, 'concepts', 'gone.md'))
      const pages = new WikiPages()
      const open = pages.openNoFollow.bind(pages)
      vi.spyOn(pages, 'openNoFollow').mockImplementation((path) => { unlinkSync(page); return open(path) })
      expect(await failure(() => pages.page(at, 'concepts/gone.md'))).toEqual({ status: 404, message: 'Page not found' })
    })

    it('a page listed in a warm cache is refused once a symlink leads it out of its section or out of the wiki', async () => {
      const page = write(join(wiki, 'concepts', 'real.md'), '# real\n')
      write(join(wiki, 'raw', 'private.md'), 'raw_marker')
      const outside = write(join(tmp, 'outside.md'), 'outside_marker')
      const pages = new WikiPages({ ttlMs: 60_000 })
      expect(await pages.page(at, 'concepts/real.md')).toEqual({ content: '# real\n', path: 'concepts/real.md' })
      unlinkSync(page)
      symlinkSync(join('..', 'raw', 'private.md'), page)
      expect(await failure(() => pages.page(at, 'concepts/real.md'))).toEqual({ status: 404, message: 'Page not found' })
      unlinkSync(page)
      symlinkSync(outside, page)
      expect(await failure(() => pages.page(at, 'concepts/real.md'))).toEqual({ status: 400, message: 'Invalid path' })
    })

    it('a parent swapped between the page checks never leads the read out of the wiki', async () => {
      const page = write(join(wiki, 'concepts', 'sub', 'p.md'), 'inside')
      write(join(tmp, 'outside', 'p.md'), 'outside_marker')
      const pages = new WikiPages({ ttlMs: 60_000 })
      await pages.page(at, 'concepts/sub/p.md')
      let swapped = false
      const afterCheck = <T>(path: unknown, result: T): T => {
        if (!swapped && String(path) === page) {
          swapped = true
          renameSync(join(wiki, 'concepts', 'sub'), join(wiki, 'concepts', 'sub-real'))
          symlinkSync(join(tmp, 'outside'), join(wiki, 'concepts', 'sub'))
        }
        return result
      }
      vi.mocked(fsp.stat).mockImplementation((path) => Promise.resolve(afterCheck(path, statSync(path))))
      vi.mocked(fsp.realpath).mockImplementation((path) => Promise.resolve(afterCheck(path, realpathSync(path))))
      const refused = await failure(() => pages.page(at, 'concepts/sub/p.md'))
      vi.mocked(fsp.stat).mockReset()
      vi.mocked(fsp.realpath).mockReset()
      expect(swapped).toBe(true)
      expect(refused).toEqual({ status: 400, message: 'Invalid path' })
    })

    it('a page added to a section is served right away even inside the TTL of a warm cache', async () => {
      write(join(wiki, 'concepts', 'one.md'))
      const pages = new WikiPages({ ttlMs: 60_000 })
      await pages.page(at, 'concepts/one.md')
      write(join(wiki, 'concepts', 'two.md'), '# two\n')
      utimesSync(join(wiki, 'concepts'), new Date(), new Date(Date.now() + 5000))
      expect(await pages.page(at, 'concepts/two.md')).toEqual({ content: '# two\n', path: 'concepts/two.md' })
    })

    it('browse and status drop a page swapped to a symlink after the snapshot [py:test_wiki_browse_rechecks_identity_after_allowlist_snapshot] [py:test_llm_wiki_status_last_writer_rechecks_identity]', async () => {
      const page = write(join(wiki, 'concepts', 'real.md'), '---\nauthor: public\n---\nbody\n')
      write(join(wiki, '.env'), '---\nauthor: hidden-author\n---\nPRIVATE=1\n')
      const pages = new WikiPages()
      const original = pages.allowlistedEntries.bind(pages)
      vi.spyOn(pages, 'allowlistedEntries').mockImplementation(async (root) => {
        const entries = await original(root)
        unlinkSync(page)
        symlinkSync(join('..', '.env'), page)
        return entries
      })
      expect(await pages.browse(at)).toEqual({ pages: [] })
      const status = await pages.status(at)
      expect(status).toMatchObject({ page_count: 0, last_updated: null, last_writer: 'ai-agent' })
      expect(JSON.stringify(status)).not.toContain('hidden-author')
      expect(await failure(() => pages.page(at, 'concepts/real.md'))).toEqual({ status: 404, message: 'Page not found' })
    })

    it('the log heading is not read when log.md is swapped between its check and open [py:test_llm_wiki_status_log_heading_rechecks_identity]', async () => {
      write(join(wiki, 'log.md'), '## [2026-06-19] update | safe\n')
      write(join(wiki, '.env'), '## [2026-06-19] leak | hidden\n')
      const pages = new WikiPages()
      const open = pages.openNoFollow.bind(pages)
      let swapped = false
      vi.spyOn(pages, 'openNoFollow').mockImplementation((path) => {
        if (!swapped && path === join(wiki, 'log.md')) {
          swapped = true
          unlinkSync(path)
          symlinkSync('.env', path)
        }
        return open(path)
      })
      expect(await pages.lastWriter(wiki, [])).toBe('ai-agent')
      expect(swapped).toBe(true)
    })

    it('the page read refuses a file whose identity changed after the snapshot', async () => {
      const page = write(join(wiki, 'concepts', 'real.md'), '# real\n')
      const pages = new WikiPages()
      const open = pages.openNoFollow.bind(pages)
      vi.spyOn(pages, 'openNoFollow').mockImplementation((path) => {
        // Written beside the page, then renamed over it, so the new file cannot reuse the old inode.
        renameSync(write(`${page}.new`, 'replaced_marker'), page)
        return open(path)
      })
      expect(await failure(() => pages.page(at, 'concepts/real.md'))).toEqual({ status: 404, message: 'Page not found' })
    })
  })

  describe('location', () => {
    const home = '/home/u'
    it('prefers the env, then the profile .env, then config, else ~/wiki', () => {
      const profile = join(tmp, 'profile')
      expect(resolveWikiLocation({ WIKI_PATH: '$BASE/w', BASE: '/data' }, profile, {}, home)).toEqual({ path: '/data/w', source: 'WIKI_PATH', configured: true })
      write(join(profile, '.env'), '# comment\nexport WIKI_PATH="~/from-dotenv"\n')
      expect(resolveWikiLocation({}, profile, { wiki: { path: '/cfg' } }, home)).toEqual({ path: '/home/u/from-dotenv', source: 'WIKI_PATH', configured: true })
      rmSync(join(profile, '.env'))
      expect(resolveWikiLocation({}, profile, { skills: { config: { wiki: { path: '${UNSET}/n' } } } }, home)).toEqual({ path: '${UNSET}/n', source: 'skills.config.wiki.path', configured: true })
      expect(resolveWikiLocation({}, profile, { 'wiki.path': '~/flat' }, home)).toEqual({ path: '/home/u/flat', source: 'skills.config.wiki.path', configured: true })
      expect(resolveWikiLocation({}, profile, {}, home)).toEqual({ path: '/home/u/wiki', source: 'default', configured: false })
    })
  })
})
