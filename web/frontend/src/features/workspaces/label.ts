import type { Workspace } from '../../contracts/resources'

/** Display name of a workspace path: the registered friendly name, else the last path segment (legacy `getWorkspaceFriendlyName`). */
export function workspaceLabel(workspaces: readonly Workspace[] | undefined, path: string | null | undefined): string {
  if (!path) return ''
  return workspaces?.find((w) => w.path === path)?.name || (path.split('/').filter(Boolean).pop() ?? path)
}
