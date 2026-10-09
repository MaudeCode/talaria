/** LLM wiki allowlist cache, path resolution, and the identity rechecks that close swaps after the allowlist snapshot (TAL-264). */
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpFailure } from '../sessions/service.js'
import { resolveWikiLocation, WikiPages, type WikiLocation } from './wiki.js'

function write(path: string, text = '# Synthetic\n'): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

const failure = (fn: () => unknown): { status: number; message: string } | null => {
  try { fn() } catch (error) { if (error instanceof HttpFailure) return { status: error.status, message: error.message }; throw error }
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
    it('reuses the page list while no section changes [py:test_wiki_page_files_reuses_cache_with_unchanged_section_mtime]', () => {
      const page = write(join(wiki, 'concepts', 'one.md'))
      const pages = new WikiPages({ ttlMs: 60_000 })
      const uncached = vi.spyOn(pages, 'pageFilesUncached')
      expect(pages.pageFiles(wiki)).toEqual([page])
      expect(pages.pageFiles(wiki)).toEqual([page])
      expect(uncached).toHaveBeenCalledTimes(1)
    })

    it('rebuilds when a section mtime changes [py:test_wiki_page_files_cache_invalidates_when_section_mtime_changes]', () => {
      const first = write(join(wiki, 'concepts', 'one.md'))
      const pages = new WikiPages({ ttlMs: 60_000 })
      const uncached = vi.spyOn(pages, 'pageFilesUncached')
      expect(pages.pageFiles(wiki)).toEqual([first])
      const second = write(join(wiki, 'concepts', 'two.md'))
      utimesSync(join(wiki, 'concepts'), new Date(), new Date(Date.now() + 5000))
      expect(pages.pageFiles(wiki).sort()).toEqual([first, second])
      expect(uncached).toHaveBeenCalledTimes(2)
    })

    it('stops walking after the file budget, counting entries that are not pages', () => {
      for (let i = 0; i < 20; i++) write(join(wiki, 'entities', `asset-${String(i)}.txt`))
      write(join(wiki, 'concepts', 'a.md'))
      expect(new WikiPages({ maxFiles: 5 }).pageFilesUncached(wiki)).toEqual([])
      expect(new WikiPages({ maxFiles: 50 }).pageFilesUncached(wiki)).toEqual([join(wiki, 'concepts', 'a.md')])
    })

    it('expires after the TTL [py:test_wiki_page_files_cache_expires_after_ttl]', () => {
      write(join(wiki, 'concepts', 'one.md'))
      const ticks = [100_000, 100_500, 101_500]
      const pages = new WikiPages({ ttlMs: 1000, now: () => ticks.shift() ?? 0 })
      const uncached = vi.spyOn(pages, 'pageFilesUncached')
      pages.pageFiles(wiki)
      pages.pageFiles(wiki)
      pages.pageFiles(wiki)
      expect(uncached).toHaveBeenCalledTimes(2)
    })
  })

  describe('identity rechecks after the allowlist snapshot', () => {
    it('browse skips a page that vanished during listing [py:test_wiki_browse_skips_pages_that_disappear_during_listing]', () => {
      const ok = write(join(wiki, 'ok.md'), '# ok\n')
      const pages = new WikiPages()
      const st = statSync(ok)
      vi.spyOn(pages, 'allowlistedEntries').mockReturnValue(new Map([['gone.md', { target: join(wiki, 'gone.md'), dev: 0, ino: 0 }], ['ok.md', { target: ok, dev: st.dev, ino: st.ino }]]))
      expect(pages.browse(at)).toEqual({ pages: [{ name: 'ok.md', path: 'ok.md', size: st.size, mtime: Math.floor(st.mtimeMs / 1000) }] })
    })

    it('a page that vanished before the read is 404, not 500 [py:test_wiki_page_vanished_between_check_and_read_returns_404_not_500]', () => {
      mkdirSync(wiki)
      const pages = new WikiPages()
      vi.spyOn(pages, 'allowlistedEntries').mockReturnValue(new Map([['gone.md', { target: join(wiki, 'gone.md'), dev: 0, ino: 0 }]]))
      expect(failure(() => pages.page(at, 'gone.md'))).toEqual({ status: 404, message: 'Page not found' })
    })

    it('browse and status drop a page swapped to a symlink after the snapshot [py:test_wiki_browse_rechecks_identity_after_allowlist_snapshot] [py:test_llm_wiki_status_last_writer_rechecks_identity]', () => {
      const page = write(join(wiki, 'concepts', 'real.md'), '---\nauthor: public\n---\nbody\n')
      write(join(wiki, '.env'), '---\nauthor: hidden-author\n---\nPRIVATE=1\n')
      const pages = new WikiPages()
      const original = pages.allowlistedEntries.bind(pages)
      vi.spyOn(pages, 'allowlistedEntries').mockImplementation((root) => {
        const entries = original(root)
        unlinkSync(page)
        symlinkSync(join('..', '.env'), page)
        return entries
      })
      expect(pages.browse(at)).toEqual({ pages: [] })
      const status = pages.status(at)
      expect(status).toMatchObject({ page_count: 0, last_updated: null, last_writer: 'ai-agent' })
      expect(JSON.stringify(status)).not.toContain('hidden-author')
      expect(failure(() => pages.page(at, 'concepts/real.md'))).toEqual({ status: 404, message: 'Page not found' })
    })

    it('the log heading is not read when log.md is swapped between its check and open [py:test_llm_wiki_status_log_heading_rechecks_identity]', () => {
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
      expect(pages.lastWriter(wiki, [])).toBe('ai-agent')
      expect(swapped).toBe(true)
    })

    it('the page read refuses a file whose identity changed after the snapshot', () => {
      const page = write(join(wiki, 'concepts', 'real.md'), '# real\n')
      const pages = new WikiPages()
      const open = pages.openNoFollow.bind(pages)
      vi.spyOn(pages, 'openNoFollow').mockImplementation((path) => {
        // Written beside the page, then renamed over it, so the new file cannot reuse the old inode.
        renameSync(write(`${page}.new`, 'replaced_marker'), page)
        return open(path)
      })
      expect(failure(() => pages.page(at, 'concepts/real.md'))).toEqual({ status: 404, message: 'Page not found' })
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
