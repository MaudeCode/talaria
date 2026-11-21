/**
 * The decorations the server adds to a user prompt before the Agent sees it: the workspace prefix and the attached-files
 * line. A leaf module, so the state.db reader and its worker can normalise prompts without loading the session model.
 */
import { str } from '../util.js'

export function escapeWorkspacePrefixPath(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/]/g, '\\]')
}

// Paths are escaped like the workspace prefix (`\\` and `\]`), so a `]` in a path stays inside the line.
const ATTACHED_FILES_RE = /\n\n\[Attached files: ((?:\\.|[^\]\\])+)\]$/
export function stripAttachedFilesMarker(text: string): string {
  return text.replace(ATTACHED_FILES_RE, '').trim()
}

/** The escaped, comma-joined paths an attached-files line names, or null when the text carries none. */
export function attachedFilesNamed(text: string): string | null {
  return ATTACHED_FILES_RE.exec(text)?.[1] ?? null
}

export const WORKSPACE_PREFIX_RE = /^\s*\[Workspace::v1:\s*(?:\\.|[^\]\\])+\]\s*/
const LEGACY_WORKSPACE_PREFIX_RE = /^\s*\[Workspace:[^\]]+\]\s*/

export function stripWorkspacePrefix(text: string, includeLegacy = false): string {
  const value = str(text)
  let stripped = value.replace(WORKSPACE_PREFIX_RE, '')
  if (includeLegacy && stripped === value) stripped = value.replace(LEGACY_WORKSPACE_PREFIX_RE, '')
  return stripped.trim()
}

/** A user prompt as the user typed it: without the workspace prefix and the attached-files line the server adds. */
export const userPromptText = (text: string): string => stripWorkspacePrefix(stripAttachedFilesMarker(text), true)
