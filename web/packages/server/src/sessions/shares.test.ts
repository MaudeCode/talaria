/** Public share snapshots embed only images read through the anchored walk from an allowed root. */
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Session } from './session.js'
import { buildShareSnapshot, embedShareMedia } from './shares.js'

/** One-shot hook: right after `fstatSync` samples the armed file's inode, append `bytes` to that same file. */
const grow = vi.hoisted(() => ({ path: '', ino: 0, bytes: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const fstatSync = ((...args: Parameters<typeof fs.fstatSync>) => {
    const st = fs.fstatSync(...args)
    if (grow.path && st?.ino === grow.ino) {
      fs.appendFileSync(grow.path, Buffer.alloc(grow.bytes, 0))
      grow.path = ''
    }
    return st
  }) as typeof fs.fstatSync
  return { ...fs, fstatSync }
})

const SHARE_EMBED_MAX_BYTES = 512 * 1024

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)])

describe('embedShareMedia', () => {
  let root = ''
  let outside = ''
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'share-root-')))
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'share-outside-')))
    writeFileSync(join(root, 'inside.png'), png)
    writeFileSync(join(outside, 'private.png'), png)
    symlinkSync(join(outside, 'private.png'), join(root, 'leaf-link.png'))
    mkdirSync(join(root, 'sub'))
    symlinkSync(outside, join(root, 'dir-link'))
    writeFileSync(join(root, 'sub', 'not-an-image.png'), 'text')
    linkSync(join(outside, 'private.png'), join(root, 'hard-link.png'))
  })
  afterAll(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) })

  it('embeds a real image under the root and omits symlinked leaves, symlinked parents, hard links, absolute outside paths, and fakes', () => {
    const embed = (ref: string): string => embedShareMedia(`see MEDIA:${ref} here`, [root], root)
    expect(embed('inside.png')).toMatch(/<img src="data:image\/png;base64,/)
    expect(embed(join(root, 'inside.png'))).toMatch(/<img src="data:image\/png;base64,/)
    for (const ref of ['leaf-link.png', 'dir-link/private.png', 'hard-link.png', join(outside, 'private.png'), 'sub/not-an-image.png', '../private.png']) {
      expect(embed(ref), ref).toContain('Local attachment omitted')
      expect(embed(ref), ref).not.toContain('base64')
    }
  })

  it('omits an image that grows past the cap after its size is sampled, and still embeds one exactly at the cap', () => {
    writeFileSync(join(root, 'grows.png'), png)
    Object.assign(grow, { path: join(root, 'grows.png'), ino: statSync(join(root, 'grows.png')).ino, bytes: SHARE_EMBED_MAX_BYTES + 1 })
    const session = new Session({ title: 'Grown', messages: [] }, { workspace: root, model: null })
    const snapshot = buildShareSnapshot(session, [{ role: 'assistant', content: 'see MEDIA:grows.png here' }], { hermesHome: join(root, '.hermes'), attachmentRoot: root, home: root })
    expect(grow.path, 'the hook fired').toBe('')
    expect(statSync(join(root, 'grows.png')).size).toBeGreaterThan(SHARE_EMBED_MAX_BYTES)
    const text = JSON.stringify(snapshot)
    expect(text).toContain('Local attachment omitted')
    expect(text).not.toContain('base64')

    writeFileSync(join(root, 'at-cap.png'), Buffer.concat([png, Buffer.alloc(SHARE_EMBED_MAX_BYTES - png.length, 1)]))
    const atCap = embedShareMedia('MEDIA:at-cap.png', [root], root)
    expect(atCap).toMatch(/<img src="data:image\/png;base64,/)
    expect(Buffer.from(/base64,([^"]+)"/.exec(atCap)![1]!, 'base64').length).toBe(SHARE_EMBED_MAX_BYTES)
  })
})

describe('buildShareSnapshot inline data', () => {
  // Synthetic private bytes behind a valid PNG header: the credential redactor cannot read them once encoded.
  const secret = Buffer.concat([png.subarray(0, 8), Buffer.from('TAL1600-SYNTHETIC-PRIVATE-BYTES-'.repeat(4))])
  const payload = secret.toString('base64')
  const urlEncoded = encodeURIComponent(`<svg>${secret.toString('latin1')}</svg>`)
  // Any 24-character window of a payload is enough to prove it did not survive.
  const leaks = (text: string, value: string): boolean => {
    for (let i = 0; i + 24 <= value.length; i += 8) if (text.includes(value.slice(i, i + 24))) return true
    return false
  }
  let root = ''
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'share-inline-')))
    writeFileSync(join(root, 'chart.png'), png)
  })
  afterAll(() => { rmSync(root, { recursive: true, force: true }) })
  const snapshot = (content: string, title = 'Inline data') => buildShareSnapshot(
    new Session({ title, messages: [] }, { workspace: root, model: null }),
    [{ role: 'user', content }],
    { hermesHome: join(root, '.hermes'), attachmentRoot: root, home: root },
  )

  const supplied = [
    `![x](data:image/png;base64,${payload})`,
    `![x](  <data:image/png;base64,${payload}> "a title")`,
    `![x](data:image/png;base64,\n${payload})`,
    `<img src="data:image/png;base64,${payload}">`,
    `<IMG SRC='DATA:IMAGE/PNG;BASE64,${payload}'>`,
    `<img src=data:image/png;base64,${payload}>`,
    `&lt;img src="data:image/png;base64,${payload}"&gt;`,
    `&LT;img alt="x" src="data:image/png;base64\n,${payload}"&GT;`,
    `<img src="https://example.com/a.png" alt="data:image/png;base64\n,${payload}">`,
    `<img title="x" src="data:image/png;base64\n,${payload}">`,
    `<img alt="a<b" src="data:image/png;base64\n,${payload}">`,
    `<img src="data:image/svg+xml,${urlEncoded}">`,
    `[open](data:text/html;base64,${payload})`,
    `plain data:text/plain;base64,${payload} in prose`,
    `[ref]: data:application/octet-stream;base64,${payload}`,
    `MEDIA:data:image/png;base64,${payload} trailing`,
    `\`data:;base64,${payload}\``,
  ]

  it.each(supplied)('never publishes content-supplied data bytes: %s', (content) => {
    const text = JSON.stringify(snapshot(`before ${content} after`))
    expect(leaks(text, payload), text).toBe(false)
    expect(leaks(text, urlEncoded), text).toBe(false)
    expect(text).toContain('attachment omitted from public share')
    expect(text).toContain('before ')
  })

  it('never publishes data bytes from the share title', () => {
    const shared = snapshot('hello', `Look data:image/png;base64,${payload} ![x](data:image/png;base64,${payload})`)
    expect(leaks(shared.title, payload), shared.title).toBe(false)
    expect(shared.title).toContain('Look ')
  })

  it('keeps ordinary prose, remote images, and server-embedded local images', () => {
    const content = [
      'metadata: rows', 'data: 5 rows', 'the data:key,value pair', 'an image of an img tag',
      '![chart](https://example.com/c.png)', '<img src="https://example.com/a.png" alt="metadata: x">', 'MEDIA:chart.png',
    ].join('\n')
    const [message] = snapshot(content).messages
    const text = String(message!.content)
    for (const kept of content.split('\n').slice(0, -1)) expect(text).toContain(kept)
    expect(text).toMatch(/<img src="data:image\/png;base64,[^"]+" class="msg-media-img" alt="chart.png"/)
    expect(text).not.toContain('MEDIA:')
  })

  it('still masks local paths and drops tool output and reasoning around the scrub', () => {
    const shared = buildShareSnapshot(new Session({ title: 'Mixed', messages: [] }, { workspace: root, model: null }), [
      { role: 'user', content: `see ${join(root, 'notes.txt')} and data:image/png;base64,${payload}` },
      { role: 'tool', content: 'TAL1600-TOOL-OUTPUT' },
      { role: 'assistant', content: '<think>TAL1600-REASONING</think>The answer.', reasoning: 'TAL1600-REASONING-FIELD' },
    ], { hermesHome: join(root, '.hermes'), attachmentRoot: root, home: root })
    const text = JSON.stringify(shared)
    expect(text).not.toContain(root)
    expect(text).toContain('[redacted-path]')
    expect(leaks(text, payload)).toBe(false)
    expect(text).not.toContain('TAL1600-TOOL-OUTPUT')
    expect(text).not.toContain('TAL1600-REASONING')
    expect(text).toContain('The answer.')
  })

  it('stays linear on long malformed repeated input', () => {
    // A quadratic scan takes seconds on these inputs; a linear one takes milliseconds.
    const n = 40_000
    for (const content of [
      '<img '.repeat(n), '&lt;img '.repeat(n), '![x](data:a '.repeat(n), '![x](data:image/'.repeat(n), '![' + ' '.repeat(n * 5),
      '![x](' + ' '.repeat(n * 5), 'data:' + 'a'.repeat(n * 5), `<img alt="${'data: '.repeat(n)}`, `<img ${'alt="x '.repeat(n)}>`,
      'MEDIA:data:'.repeat(n), `${'<img '.repeat(n)}>`, `${'![x](data:image/'.repeat(n)})`,
    ]) {
      const started = performance.now()
      snapshot(content)
      expect(performance.now() - started, content.slice(0, 40)).toBeLessThan(1000)
    }
  })
})
