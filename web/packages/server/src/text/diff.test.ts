import { describe, expect, it } from 'vitest'
import { unifiedDiff } from './diff.js'
import { renderMarkdown } from './markdown.js'

const keep = (s: string): string[] => s.match(/[^\n]*\n|[^\n]+$/g) ?? []

describe('unifiedDiff', () => {
  it('matches difflib for a small edit', () => {
    const a = keep('one\ntwo\nthree\nfour\nfive\nsix\nseven\n')
    const b = keep('one\ntwo\n3\nfour\nfive\nsix\nseven\neight\n')
    expect(unifiedDiff(a, b, 'a/f', 'b/f')).toEqual(['--- a/f', '+++ b/f', '@@ -1,7 +1,8 @@', ' one\n', ' two\n', '-three\n', '+3\n', ' four\n', ' five\n', ' six\n', ' seven\n', '+eight\n'])
  })

  it('emits nothing for equal inputs and separate hunks for distant edits', () => {
    expect(unifiedDiff(['a\n'], ['a\n'], 'a', 'b')).toEqual([])
    const a = keep(Array.from({ length: 20 }, (_, i) => `l${String(i)}`).join('\n') + '\n')
    const b = [...a]
    b[0] = 'X\n'
    b[19] = 'Y\n'
    const out = unifiedDiff(a, b, 'a/f', 'b/f')
    expect(out.filter((l) => l.startsWith('@@'))).toEqual(['@@ -1,4 +1,4 @@', '@@ -17,4 +17,4 @@'])
  })
})

describe('renderMarkdown', () => {
  it('renders the constructs the export relies on and escapes raw html', () => {
    const html = renderMarkdown('# Title\n\nSome *em* and `code` <script>x</script>\n\n- a\n- b\n\n| h |\n|---|\n| c |\n\n> quote\n\n[link](https://x.example) [bad](javascript:alert(1))')
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<em>em</em>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('<ul><li>a</li><li>b</li></ul>')
    expect(html).toContain('<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>')
    expect(html).toContain('<blockquote><p>quote</p></blockquote>')
    expect(html).toContain('<a href="https://x.example">link</a>')
    expect(html).not.toContain('javascript:')
  })
})
