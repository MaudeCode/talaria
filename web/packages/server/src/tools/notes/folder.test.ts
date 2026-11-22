import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WikiPages } from '../wiki.js'
import { FOLDER_RULE, folderSource } from './folder.js'

describe('Markdown-folder notes source', () => {
  let root = ''
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

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
})
