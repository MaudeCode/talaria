import { describe, expect, it } from 'vitest'
import { diffHunks, unifiedDiff } from './diff.js'
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

describe('diffHunks (TAL-604)', () => {
  const kinds = (d: string): string[][] => diffHunks(d).map((h) => h.lines.map((l) => l.kind))

  it('drops the file preamble and numbers each line of each hunk', () => {
    const hunks = diffHunks('diff --git a/App.swift b/App.swift\nindex 1234567..89abcde 100644\n--- a/App.swift\n+++ b/App.swift\n@@ -1,3 +1,3 @@ func main\n context\n-removed\n+added\n\\ No newline at end of file\n@@ -10,2 +10,3 @@\n keep\n+new\n tail\n')
    expect(hunks).toMatchObject([
      { header: '@@ -1,3 +1,3 @@ func main', old_start: 1, new_start: 1, new_end: 3, additions: 1, deletions: 1 },
      { header: '@@ -10,2 +10,3 @@', old_start: 10, new_start: 10, new_end: 12, additions: 1, deletions: 0 },
    ])
    expect(hunks[0]!.lines).toEqual([
      { kind: 'context', old_line: 1, new_line: 1, text: ' context' },
      { kind: 'deletion', old_line: 2, new_line: null, text: '-removed' },
      { kind: 'addition', old_line: null, new_line: 2, text: '+added' },
      { kind: 'context', old_line: null, new_line: null, text: '\\ No newline at end of file' },
    ])
    expect(hunks[1]!.lines.map((l) => [l.old_line, l.new_line])).toEqual([[10, 10], [null, 11], [11, 12]])
  })

  it('keeps the next file\'s header and a removed `--` line apart in a multi-file diff', () => {
    // The Agent's multi-file patch result joins each file's diff with a blank line (TAL-448).
    const hunks = diffHunks('--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1 @@\n-old\n--- dashes\n+new\n\n--- a/b.txt\n+++ b/b.txt\n@@ -0,0 +1 @@\n+added\n')
    expect(hunks.map((h) => h.lines.map((l) => l.text))).toEqual([['-old', '--- dashes', '+new'], ['+added']])
    expect(hunks.map((h) => [h.additions, h.deletions])).toEqual([[1, 2], [1, 0]])
    // A pure deletion still covers its start line; a final line without a newline runs short, and the header pair ends it.
    expect(diffHunks('@@ -5,2 +4,0 @@\n-a\n-b')[0]).toMatchObject({ new_start: 4, new_end: 4 })
    expect(kinds('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a+b\n--- a/y\n+++ b/y\n@@ -0,0 +1 @@\n+c\n')).toEqual([['deletion'], ['addition']])
  })

  it('makes one unnumbered hunk per file of a diff without hunk headers', () => {
    expect(diffHunks('--- a/a.txt\n+++ b/a.txt\n---actual content\n+++actual content')).toEqual([{
      header: '', old_start: null, new_start: null, new_end: null, additions: 1, deletions: 1,
      lines: [{ kind: 'deletion', old_line: null, new_line: null, text: '---actual content' }, { kind: 'addition', old_line: null, new_line: null, text: '+++actual content' }],
    }])
    expect(kinds('diff --git a/a b/a\n-a\n+b\ndiff --git a/b b/b\n-c\n+d')).toEqual([['deletion', 'addition'], ['deletion', 'addition']])
    expect(diffHunks('')).toEqual([])
    expect(diffHunks('diff --git a/x b/x\nindex 1..2\n')).toEqual([])
  })
})
