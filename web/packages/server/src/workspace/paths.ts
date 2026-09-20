/** Path helpers matching Python `Path.expanduser().resolve()` semantics on a possibly missing path. */
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

export function expandHome(path: string, home = homedir()): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith(`~${sep}`)) return resolve(home, path.slice(2))
  return path
}

/** `Path(p).expanduser().resolve()`: symlinks in the existing prefix are resolved; a missing tail is appended lexically. */
export function resolvePathLikePython(path: string, home = homedir()): string {
  const absolute = resolve(expandHome(path, home))
  let probe = absolute
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpathSync.native(probe)
      return tail.length ? resolve(real, ...tail.reverse()) : real
    } catch {
      const parent = dirname(probe)
      if (parent === probe) return absolute
      tail.push(probe.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
      probe = parent
    }
  }
}

/** `child.relative_to(root)` succeeds. Both must already be resolved. */
export function isWithin(child: string, root: string): boolean {
  if (child === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return child.startsWith(prefix)
}

export function isAbsolutePath(path: string): boolean {
  return isAbsolute(path)
}
