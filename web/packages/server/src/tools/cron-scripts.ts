/**
 * TAL-1762: the profile's job scripts, read-only. The Agent runs a job's `script` only when it resolves inside
 * `<profile home>/scripts/` (`cron/scheduler_script.py` `_resolve_script_path`), so this lists exactly the `.py` and
 * `.sh` regular files that do: top level and one subdirectory deep, any entry whose real path leaves the directory
 * dropped. Each file is opened once through the anchored walk (`openAnchoredFd`: every component no-follow from `/`,
 * the scripts root pinned to the inode resolved first), so a directory swapped for a link after the check is refused;
 * the leaf open is `O_NONBLOCK` (a FIFO or device never blocks). It is listed only when it is a regular file, and read
 * for at most `DESCRIPTION_BYTES`.
 */
import { closeSync, fstatSync } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CronScripts } from '@maudecode/talaria-web-contracts'
import { isWithin } from '../workspace/paths.js'
import { openAnchoredFd, readFdUpTo, withPinnedRoot } from '../workspace/fs.js'
import { osErrorText } from '../util.js'

export const DESCRIPTION_BYTES = 8192
const isScript = (name: string): boolean => name.endsWith('.py') || name.endsWith('.sh')
type Row = CronScripts['scripts'][number]

export async function listCronScripts(profileHome: string): Promise<CronScripts> {
  const directory = join(profileHome, 'scripts')
  let root: string
  let id: { dev: number; ino: number }
  let top: string[]
  try {
    root = await realpath(directory)
    id = await stat(root)
    top = await readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { directory, scripts: [], unavailable_reason: null }
    return { directory, scripts: [], unavailable_reason: osErrorText(error) }
  }
  const scripts: Row[] = []
  for (const entry of top.sort()) {
    const real = await contained(join(root, entry), root)
    if (!real) continue
    if (isScript(entry)) { const row = readScript(root, id, real, entry); if (row) { scripts.push(row); continue } }
    if (!(await stat(real).then((st) => st.isDirectory(), () => false))) continue
    let inner: string[]
    try { inner = await readdir(real) } catch { continue }
    for (const child of inner.sort()) {
      if (!isScript(child)) continue
      const file = await contained(join(real, child), root)
      const row = file && readScript(root, id, file, `${entry}/${child}`)
      if (row) scripts.push(row)
    }
  }
  return { directory, scripts: scripts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), unavailable_reason: null }
}

/** The entry's real path when it stays inside `root`; a dangling link or an escape answers `null`. */
async function contained(path: string, root: string): Promise<string | null> {
  try {
    const real = await realpath(path)
    return real !== root && isWithin(real, root) ? real : null
  } catch { return null }
}

/** The row for a regular file at `real`, else `null` (a directory named `x.py`, a FIFO, a device, an unreadable file). */
function readScript(root: string, id: { dev: number; ino: number }, real: string, name: string): Row | null {
  let fd: number
  try { fd = withPinnedRoot(root, id, () => openAnchoredFd(root, real, { wantDir: false })) } catch { return null }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) return null
    const head = readFdUpTo(fd, DESCRIPTION_BYTES).toString('utf8')
    return { name, size: st.size, mtime: st.mtimeMs / 1000, description: describe(head, name.endsWith('.py')) }
  } catch { return null } finally { closeSync(fd) }
}

/** The first docstring line (Python) or leading comment line, skipping the shebang and encoding/editor lines. */
export function describe(head: string, python: boolean): string | null {
  const lines = head.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line || line.startsWith('#!')) continue
    if (line.startsWith('#')) {
      const text = line.replace(/^#+\s*/, '')
      if (text && !/^-\*-.*-\*-$|^(vim?|ex):|^shellcheck\s/.test(text)) return text
      continue
    }
    const quote = python ? /^[rRuU]?("""|''')/.exec(line) : null
    if (!quote) return null
    const rest = line.slice(quote[0].length)
    const end = rest.indexOf(quote[1]!)
    if (end >= 0) return rest.slice(0, end).trim() || null
    if (rest.trim()) return rest.trim()
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!.trim()
      const close = next.indexOf(quote[1]!)
      const text = (close >= 0 ? next.slice(0, close) : next).trim()
      if (text) return text
      if (close >= 0) return null
    }
    return null
  }
  return null
}
