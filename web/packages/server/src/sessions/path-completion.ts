/**
 * TAL-1342: the decisions around a native owner's `complete.path`. The owner lists the session's frozen workspace; the
 * server picks the word, refuses one that names a root of its own, and turns the owner's candidates into display rows.
 */
import { PATH_COMPLETION_LIMIT, type GatewaySessionResult, type PathCompletions } from '@maudecode/talaria-web-contracts'

type Item = PathCompletions['items'][number]
type Raw = NonNullable<GatewaySessionResult['completion']>['items'][number]

// The native TUI's completion trigger (ui-tui useCompletion TAB_PATH_RE): a word at the caret that starts like a path or `@`.
const PATH_WORD = /((?:["']?(?:[A-Za-z]:[\\/]|\.{1,2}\/|~\/|\/|@|[^"'`\s]+\/))[^\s]*)$/
// The Agent's `format_reference_value`: a reference value with any of these is read back whole only when quoted.
const NEEDS_QUOTING = /[\s()[\]{}<>"'`]/

// An `@file:`/`@folder:` value whose quote is still open at the caret: its spaces belong to the path.
const OPEN_REFERENCE = /@(file|folder):([`"'])((?:(?!\2)[^\n])*)$/

/**
 * The word before the caret and where it starts, or null for prose and slash commands. `word` is what the owner is asked:
 * an open quoted reference goes as its unquoted path, and the whole reference, quote included, is replaced.
 */
export function pathCompletionWord(before: string): { word: string; replace_from: number } | null {
  if (before.trimStart().startsWith('/')) return null
  const open = OPEN_REFERENCE.exec(before)
  const bare = open ? undefined : PATH_WORD.exec(before)?.[1]
  const found = open ? { word: `@${open[1]!}:${open[3]!}`, replace_from: open.index } : bare ? { word: bare, replace_from: before.length - bare.length } : null
  return found && found.word.length <= 512 ? found : null
}

/** The path a word or candidate names, without its quote and `@file:`/`@folder:` prefix. */
function pathOf(text: string): string {
  let path = text.replace(/^["']/, '')
  if (path.startsWith('@')) {
    path = path.slice(1)
    const ref = /^(?:file|folder):/.exec(path)
    if (ref) path = path.slice(ref[0].length).replace(/^["'`]/, '')
  }
  return path
}

/** Absolute, home, drive or parent: a root other than the session's frozen workspace. */
export function outsideWorkspace(text: string): boolean {
  const path = pathOf(text)
  return /^(?:[A-Za-z]:|[\\/]|~)/.test(path) || path.split(/[\\/]/).includes('..')
}

function quoted(value: string): string {
  if (!NEEDS_QUOTING.test(value)) return value
  const quote = ['`', '"', "'"].find((q) => !value.includes(q))
  return quote ? `${quote}${value}${quote}` : value
}

/**
 * The owner's candidates as rows, in its order: never one outside the workspace or one the word already spells (picking it
 * would complete nothing, and the list would keep Enter from sending), at most the bounded count.
 */
export function pathCompletionItems(raw: readonly Raw[], word: string): Item[] {
  const items: Item[] = []
  for (const { text, display, meta } of raw) {
    if (!text || /[\u0000-\u001f\u007f]/.test(text) || outsideWorkspace(text)) continue
    const ref = /^@(file|folder):(.+)$/s.exec(text)
    const kind = ref ? ref[1] as 'file' | 'folder' : text.startsWith('@') ? 'reference' : text.endsWith('/') ? 'folder' : 'file'
    const insert = ref ? `@${ref[1]!}:${quoted(ref[2]!)}` : text
    if (insert === word) continue
    items.push({ label: display || text, detail: meta === 'dir' ? '' : meta, kind, insert })
    if (items.length === PATH_COMPLETION_LIMIT) break
  }
  return items
}
