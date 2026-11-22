import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WikiPages, type WikiEntry } from '../wiki.js'
import { FOLDER_RULE, folderSource } from './folder.js'
import { NotesSourceError } from './source.js'

describe('Markdown-folder notes source', () => {
  let root = ''
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  /** A vault of pages at fixed mtimes, read through a reader that logs each listing and page read; `hold` stalls listings until its release. */
  function vault(pages: Record<string, [text: string, mtime: number]>): { log: string[]; reader: WikiPages; hold: () => () => void } {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'talaria-notes-folder-')))
    for (const [rel, [text, mtime]] of Object.entries(pages)) {
      writeFileSync(join(root, rel), text)
      utimesSync(join(root, rel), mtime, mtime)
    }
    const log: string[] = []
    let gate: Promise<void> | null = null
    class Logged extends WikiPages {
      override async allowlistedEntries(at: string): Promise<Map<string, WikiEntry>> {
        log.push('list')
        if (gate) await gate
        return super.allowlistedEntries(at)
      }
      override readEntry(entry: WikiEntry) {
        log.push(entry.target.slice(root.length + 1))
        return super.readEntry(entry)
      }
    }
    const hold = (): (() => void) => {
      let release: () => void = () => undefined
      gate = new Promise((done) => { release = () => { gate = null; done() } })
      return release
    }
    return { log, reader: new Logged({ rule: FOLDER_RULE }), hold }
  }

  it('never reads into logseq/bak, so its backups spend none of the walk budget', async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'talaria-notes-folder-')))
    const write = (rel: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), 'alpha') }
    write('pages/current.md')
    for (let i = 0; i < 20; i++) write(`logseq/bak/old-${String(i)}.md`)
    const asked: string[] = []
    // The pruned walk spends 4 entries (logseq, bak, pages, current.md); reading the backups would spend 24.
    const pages = new WikiPages({ maxFiles: 5, rule: { ...FOLDER_RULE, include: (rel) => { asked.push(rel); return FOLDER_RULE.include(rel) } } })
    expect((await folderSource({ name: 'graph', path: root }, true, pages).search('alpha', 50)).map((hit) => hit.id)).toEqual(['pages/current.md'])
    expect(asked.filter((rel) => rel.startsWith('logseq/bak/'))).toEqual([])
  })

  it('reads pages newest first and stops at the limit or once the byte budget is spent', async () => {
    const { log, reader } = vault({ 'new.md': ['alpha', 3000], 'mid.md': ['alpha', 2000], 'old.md': ['alpha beta', 1000] })
    const ids = async (q: string, limit: number, budget?: number) => (await folderSource({ name: 'v', path: root }, true, reader, budget).search(q, limit)).map((hit) => hit.id)
    expect(await ids('alpha', 1)).toEqual(['new.md'])
    expect(log).toEqual(['list', 'new.md'])
    expect(await ids('beta', 50, 6)).toEqual([])
    expect(await ids('beta', 50)).toEqual(['old.md'])
  })

  it('scans a folder for one search at a time and stops a search whose request went away', async () => {
    const { log, reader, hold } = vault({ 'a.md': ['alpha', 2000], 'b.md': ['alpha', 1000] })
    const source = folderSource({ name: 'v', path: root }, true, reader)
    const release = hold()
    const first = source.search('alpha', 50)
    const cancel = new AbortController()
    const second = source.search('alpha', 50, cancel.signal)
    await vi.waitFor(() => { expect(log).toContain('list') })
    expect(log).toEqual(['list'])
    cancel.abort()
    release()
    expect((await first).map((hit) => hit.id)).toEqual(['a.md', 'b.md'])
    await expect(second).rejects.toThrow(NotesSourceError)
    expect(log).toEqual(['list', 'a.md', 'b.md', 'list'])
  })
})
