/**
 * A settled turn's file changes (`file_changes` on its activity scene): the files its file-mutating calls touched and the
 * strongest action on each, in first-touch order. Clients join these paths to `git/status` for line counts; they never
 * classify tool names or pick path arguments themselves.
 */
import type { TurnFileChange } from '@maudecode/talaria-web-contracts'
import { str } from '../util.js'
import { isDict } from './merge.js'

type Action = TurnFileChange['action']

/** Tools that change files. Reads, searches and shell commands are not attributed: their paths are not per-turn edits. */
const ACTIONS = new Map<string, Action>([
  ['create_file', 'added'],
  ['remove_file', 'deleted'], ['delete_file', 'deleted'], ['mcp_filesystem_remove_file', 'deleted'],
  ['move_file', 'renamed'], ['rename_file', 'renamed'], ['mcp_filesystem_move_file', 'renamed'],
  ['write_file', 'edited'], ['patch', 'edited'], ['edit_file', 'edited'], ['mcp_filesystem_write_file', 'edited'], ['mcp_filesystem_edit_file', 'edited'],
])

/** Generated and vendored trees, never attributed to a turn. */
const IGNORED = new Set(['.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.cache'])
const WRAPPING = /^[\s`"'<>()[\]{}]+|[\s`"'<>()[\]{}]+$/g
const PATH_MAX = 240

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** A tool path as the recap shows it, or null to drop it: unwrapped, without `~/` or `./`, and not a URL or ignored tree. */
export function normalizeChangedPath(raw: string): string | null {
  let path = raw.replace(WRAPPING, '')
  if (!path || Array.from(path).length > PATH_MAX || path.includes('://')) return null
  if (path.startsWith('~/')) path = path.slice(2)
  while (path.startsWith('./')) path = path.slice(2)
  path = path.trim()
  return path && !path.split('/').some((part) => IGNORED.has(part)) ? path : null
}

/** The raw paths one call changed. A rename yields only its destination: the source no longer exists to show. */
function rawPaths(action: Action, args: Record<string, unknown>): string[] {
  if (action === 'renamed') {
    const destination = ['destination', 'path', 'file_path', 'filename'].map((k) => text(args[k])).find(Boolean)
    return destination ? [destination] : []
  }
  return [
    ...['path', 'file_path', 'filename'].map((k) => text(args[k])),
    ...(Array.isArray(args.paths) ? args.paths.map(text) : []),
    ...(Array.isArray(args.edits) ? args.edits.map((edit) => (isDict(edit) ? text(edit.path) : '')) : []),
  ].filter(Boolean)
}

/** The turn's file changes from its scene rows' tool calls (raw arguments, before any snapshot or redaction). */
export function turnFileChanges(rows: readonly { tool?: { name: string; args: unknown } }[]): TurnFileChange[] {
  const changes = new Map<string, Action>()
  for (const { tool } of rows) {
    const action = ACTIONS.get(str(tool?.name).trim().toLowerCase())
    if (!action || !isDict(tool?.args)) continue
    for (const raw of rawPaths(action, tool.args)) {
      const path = normalizeChangedPath(raw)
      if (!path) continue
      const existing = changes.get(path)
      // A path edited and (re)created in one turn reads as the stronger action; a later plain edit never downgrades it.
      if (!existing || (existing === 'edited' && action !== 'edited')) changes.set(path, action)
    }
  }
  return [...changes].map(([path, action]) => ({ path, action }))
}
