/** Path helpers matching Python `Path.expanduser().resolve()` semantics on a possibly missing path. */
import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

export function expandHome(path: string, home = homedir()): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith(`~${sep}`)) return resolve(home, path.slice(2))
  return path
}

/** Each existing-prefix candidate of an absolute path, longest first, with the tail a resolved prefix gets appended back. */
function* pathPrefixes(absolute: string): Generator<[string, string[]]> {
  let probe = absolute
  const tail: string[] = []
  for (;;) {
    yield [probe, tail]
    const parent = dirname(probe)
    if (parent === probe) return
    tail.unshift(probe.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
    probe = parent
  }
}

/** `Path(p).expanduser().resolve()`: symlinks in the existing prefix are resolved; a missing tail is appended lexically. */
export function resolvePathLikePython(path: string, home = homedir()): string {
  const absolute = resolve(expandHome(path, home))
  for (const [probe, tail] of pathPrefixes(absolute)) {
    try { return resolve(realpathSync.native(probe), ...tail) } catch { /* try the parent */ }
  }
  return absolute
}

/** `resolvePathLikePython` off the event loop. */
export async function resolvePathLikePythonAsync(path: string, home = homedir()): Promise<string> {
  const absolute = resolve(expandHome(path, home))
  for (const [probe, tail] of pathPrefixes(absolute)) {
    try { return resolve(await realpath(probe), ...tail) } catch { /* try the parent */ }
  }
  return absolute
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
