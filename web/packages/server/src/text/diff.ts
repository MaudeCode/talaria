import type { DiffHunk } from '@maudecode/talaria-web-contracts'

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * TAL-604: the server's one unified diff parser, shipped as `hunks` so clients never parse diffs. Each `@@` hunk runs for
 * the line counts its header gives, so file headers and `diff --git` preambles between hunks are no change; a `---` /
 * `+++` pair ends the hunk before it once either side has no line left (a final line without a newline leaves the other
 * side's count short). A diff without
 * `@@` headers is one hunk per `diff --git` file of its `+` / `-` / context lines, unnumbered.
 */
export function diffHunks(diff: string): DiffHunk[] {
  const lines = diff.replace(/\n$/, '').split('\n')
  if (!lines.some((line) => HUNK_HEADER_RE.test(line))) return unnumberedHunks(lines)
  const hunks: DiffHunk[] = []
  let hunk: DiffHunk | undefined
  let oldLine = 0
  let newLine = 0
  let oldLeft = 0
  let newLeft = 0
  for (const [i, text] of lines.entries()) {
    const header = HUNK_HEADER_RE.exec(text)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[3])
      oldLeft = Number(header[2] ?? 1)
      newLeft = Number(header[4] ?? 1)
      hunk = { header: text, old_start: oldLine, new_start: newLine, new_end: newLine + Math.max(newLeft, 1) - 1, additions: 0, deletions: 0, lines: [] }
      hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    // A `---` / `+++` pair is a file header unless the hunk still has a line left on both sides (`-- a` changed to `++ b`).
    if (text.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ') && (oldLeft <= 0 || newLeft <= 0)) { hunk = undefined; continue }
    if (text.startsWith('\\')) { hunk.lines.push({ kind: 'context', old_line: null, new_line: null, text }); continue }
    if (oldLeft <= 0 && newLeft <= 0) { hunk = undefined; continue }
    if (text.startsWith('+')) {
      hunk.lines.push({ kind: 'addition', old_line: null, new_line: newLine++, text })
      hunk.additions += 1
      newLeft -= 1
    } else if (text.startsWith('-')) {
      hunk.lines.push({ kind: 'deletion', old_line: oldLine++, new_line: null, text })
      hunk.deletions += 1
      oldLeft -= 1
    } else if (text.startsWith(' ') || text === '') {
      hunk.lines.push({ kind: 'context', old_line: oldLine++, new_line: newLine++, text })
      oldLeft -= 1
      newLeft -= 1
    }
  }
  return hunks
}

function unnumberedHunks(lines: string[]): DiffHunk[] {
  const files: string[][] = [[]]
  for (const text of lines) {
    if (text.startsWith('diff --git')) files.push([])
    else if (/^[-+ \\]/.test(text) && !/^(?:\+\+\+ (?:b\/|\/dev\/null$)|--- (?:a\/|\/dev\/null$))/.test(text)) files.at(-1)!.push(text)
  }
  return files.filter((file) => file.length).map((file) => {
    const hunk: DiffHunk = { header: '', old_start: null, new_start: null, new_end: null, additions: 0, deletions: 0, lines: [] }
    for (const text of file) {
      const kind = text.startsWith('+') ? 'addition' : text.startsWith('-') ? 'deletion' : 'context'
      if (kind === 'addition') hunk.additions += 1
      if (kind === 'deletion') hunk.deletions += 1
      hunk.lines.push({ kind, old_line: null, new_line: null, text })
    }
    return hunk
  })
}

/** A diff's added and removed line counts, over its parsed hunks. */
export function hunkTotals(hunks: DiffHunk[]): [number, number] {
  return [hunks.reduce((n, hunk) => n + hunk.additions, 0), hunks.reduce((n, hunk) => n + hunk.deletions, 0)]
}
