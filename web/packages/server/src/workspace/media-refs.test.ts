import { describe, expect, it } from 'vitest'
import { projectMediaRefs, type MediaRefResolver } from './media-refs.js'

const url = (path: string): string => `api/media?path=${encodeURIComponent(path)}`
/** Serves every absolute path under `/tmp` or `/srv`, as the allow-list would; anything else is refused. */
const resolver = (workspace: string | null = null, served = (p: string) => p.startsWith('/tmp/') || p.startsWith('/srv/')): MediaRefResolver & { asked: string[] } => {
  const asked: string[] = []
  return { workspace, asked, localUrl: (path) => { asked.push(path); return served(path) ? url(path) : null } }
}
const display = (text: string, r: MediaRefResolver = resolver()): string | null => projectMediaRefs(text, r)?.text ?? null
const A = url('/tmp/a.png')

describe('projectMediaRefs (TAL-186)', () => {
  it('keeps the emphasis, list item, block quote and link around a local Markdown image', () => {
    expect(display('**before ![x](/tmp/a.png) after**')).toBe(`**before ![x](${A}) after**`)
    expect(display('- ![x](/tmp/a.png)')).toBe(`- ![x](${A})`)
    expect(display('> ![x](/tmp/a.png)')).toBe(`> ![x](${A})`)
    expect(display('[![x](/tmp/a.png)](https://example.test)')).toBe(`[![x](${A})](https://example.test)`)
  })

  it('rewrites MEDIA: tokens and bare file URLs in place, inside emphasis, lists and quotes', () => {
    for (const ref of ['MEDIA:/tmp/a.png', 'file:///tmp/a.png']) {
      expect(display(`**${ref}**`)).toBe(`**![a.png](${A})**`)
      expect(display(`- ${ref}`)).toBe(`- ![a.png](${A})`)
      expect(display(`> ${ref}`)).toBe(`> ![a.png](${A})`)
    }
    expect(display('_MEDIA:/tmp/trade_journal.csv_')).toBe(`_[trade\\_journal.csv](${url('/tmp/trade_journal.csv')})_`)
  })

  it('lists every reference in content order with its kind, linking anything that is not a raster image', () => {
    const projected = projectMediaRefs('A MEDIA:/tmp/a.png then MEDIA:/tmp/song.mp3, MEDIA:/tmp/clip.mp4 and file:///tmp/report.pdf\n![data](/tmp/data.zip) MEDIA:/tmp/a.png', resolver())
    expect(projected?.text).toBe(`A ![a.png](${A}) then [song.mp3](${url('/tmp/song.mp3')}), [clip.mp4](${url('/tmp/clip.mp4')}) and [report.pdf](${url('/tmp/report.pdf')})\n[data](${url('/tmp/data.zip')}) ![a.png](${A})`)
    expect(projected?.media).toEqual([
      { url: A, name: 'a.png', mime: 'image/png', kind: 'image' },
      { url: url('/tmp/song.mp3'), name: 'song.mp3', mime: 'audio/mpeg', kind: 'audio' },
      { url: url('/tmp/clip.mp4'), name: 'clip.mp4', mime: 'video/mp4', kind: 'video' },
      { url: url('/tmp/report.pdf'), name: 'report.pdf', mime: 'application/pdf', kind: 'pdf' },
      { url: url('/tmp/data.zip'), name: 'data.zip', mime: 'application/octet-stream', kind: 'file' },
    ])
  })

  it('keeps sentence punctuation and Markdown delimiters outside a reference', () => {
    expect(display('Open MEDIA:/tmp/result.png, then MEDIA:/tmp/second.webp.')).toBe(`Open ![result.png](${url('/tmp/result.png')}), then ![second.webp](${url('/tmp/second.webp')}).`)
    expect(display('[MEDIA:/tmp/other.jpg]')).toBe(`[![other.jpg](${url('/tmp/other.jpg')})]`)
    expect(display('[view](MEDIA:/tmp/result.png)')).toBe(`[view](${url('/tmp/result.png')})`)
    expect(display('![tok](MEDIA:/tmp/token.png)')).toBe(`![tok](${url('/tmp/token.png')})`)
    expect(display('Created file:///tmp/report.csv, then shared file:///tmp/chart.webp!')).toBe(`Created [report.csv](${url('/tmp/report.csv')}), then shared ![chart.webp](${url('/tmp/chart.webp')})!`)
  })

  it('resolves image destinations: file URLs and percent-encoding decode once, titles drop, workspace paths join', () => {
    const r = resolver('/srv/workspaces/app')
    expect(display('![chart](file:///tmp/reports/Q3%20chart.png)', r)).toBe(`![chart](${url('/tmp/reports/Q3 chart.png')})`)
    expect(display('![shot](/tmp/final%20shot%20%28v2%29.png "Title")', r)).toBe(`![shot](${url('/tmp/final shot (v2).png')})`)
    expect(display('![](</tmp/shots/final shot.png>)', r)).toBe(`![final shot.png](${url('/tmp/shots/final shot.png')})`)
    expect(display('![Build \\[1\\] (final)](/tmp/build(1)/shot.png)', r)).toBe(`![Build \\[1\\] (final)](${url('/tmp/build(1)/shot.png')})`)
    expect(display('![a](./shots/login.png) ![b](../other/x.png) ![c](./../other/../app/y.png)', r)).toBe(`![a](${url('/srv/workspaces/app/shots/login.png')}) ![b](${url('/srv/workspaces/other/x.png')}) ![c](${url('/srv/workspaces/app/y.png')})`)
    expect(display('Created file:///tmp/Q3%20report%20%28final%29.csv')).toBe(`Created [Q3 report (final).csv](${url('/tmp/Q3 report (final).csv')})`)
    const home = resolver(null, () => true)
    display('![shot](~/shots/login.png) MEDIA:out/chart.png', home)
    expect(home.asked).toEqual(['~/shots/login.png', 'out/chart.png'])
  })

  it('leaves workspace-relative destinations as text without an absolute workspace', () => {
    expect(display('![shot](./shots/login.png)')).toBeNull()
    expect(display('![shot](./shots/login.png)', resolver('relative/root'))).toBeNull()
  })

  it('rewrites a remote MEDIA: token to its URL, and leaves remote, data and bare relative images as written', () => {
    const projected = projectMediaRefs('Generated MEDIA:https://cdn.example.test/output/image.png?variant=small and MEDIA:https://cdn.example.test/media/abc123', resolver())
    expect(projected?.text).toBe('Generated ![image.png](https://cdn.example.test/output/image.png?variant=small) and ![abc123](https://cdn.example.test/media/abc123)')
    expect(projected?.media.map((m) => m.kind)).toEqual(['image', 'image'])
    for (const text of ['![remote](https://cdn.example.test/image.png)', '![data](data:image/png;base64,AAAA)', '![bare](shots/login.png)', '![proto](//cdn.example.test/a.png)']) {
      expect(display(text, resolver('/srv/workspaces/app'))).toBeNull()
    }
  })

  it('leaves code, HTML comments and escaped syntax literal, and asks for no media', () => {
    const r = resolver()
    const literal = [
      'Use `![x](/tmp/inline.png)` and `MEDIA:/tmp/inline.png` and `open file:///tmp/inline.csv`',
      '```swift\nlet path = "MEDIA:/tmp/inside.png"\n![z](/tmp/fenced.png)\n```',
      '~~~\nfile:///tmp/fenced.png\n~~~',
      // TAL-186 review: an indented code block, and a code span across lines.
      'Para\n\n    ![example](/tmp/example.png)\n    MEDIA:/tmp/example.png',
      'Start `code\n![example](/tmp/example.png) MEDIA:/tmp/example.png\nend` done',
      'Hidden <!-- ![x](/tmp/inline-comment.png) MEDIA:/tmp/c.png --> tail',
      '<!--\n![z](/tmp/block-comment.png) file:///tmp/commented.png\n-->',
      '\\![escaped](/tmp/escaped.png)',
      'prefixfile:///tmp/hidden.txt and [report](file:///tmp/report.csv)',
      '![x](/tmp/a.png garbage) ![unterminated](/tmp/open.png ![no destination]()',
    ]
    for (const text of literal) expect(display(text, r), text).toBeNull()
    expect(r.asked).toEqual([])
  })

  it('rewrites only outside code in mixed text', () => {
    expect(display('Before\n```\nMEDIA:/tmp/inside.png\n```\nAfter MEDIA:/tmp/outside.png')).toBe(`Before\n\`\`\`\nMEDIA:/tmp/inside.png\n\`\`\`\nAfter ![outside.png](${url('/tmp/outside.png')})`)
    expect(display('<!--\n![hidden](/tmp/hidden.png)\nhidden --> ![visible](/tmp/visible.png) tail')).toBeNull()
    expect(display('Type `<!--` to start ![same](/tmp/same.png)')).toBe(`Type \`<!--\` to start ![same](${url('/tmp/same.png')})`)
  })

  it('leaves a reference the allow-list refuses as written, with no media item', () => {
    expect(projectMediaRefs('MEDIA:/etc/passwd.png ![x](/etc/a.png) file:///etc/b.png', resolver())).toBeNull()
    const projected = projectMediaRefs('MEDIA:/etc/x.png and MEDIA:/tmp/a.png', resolver())
    expect(projected?.text).toBe(`MEDIA:/etc/x.png and ![a.png](${A})`)
    expect(projected?.media.map((m) => m.url)).toEqual([A])
  })
})
