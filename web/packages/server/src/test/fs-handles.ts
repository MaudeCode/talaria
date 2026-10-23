import * as fsp from 'node:fs/promises'
import { vi } from 'vitest'

/**
 * Patch the next promise file handle opened at a matching path. The calling test file must mock `node:fs/promises`
 * with `open: vi.fn(real.open)`; the wrapper restores the real `open` once it has matched.
 */
export function onNextOpen(patch: (handle: fsp.FileHandle) => void, matches: (path: string) => boolean = () => true): void {
  const open = vi.mocked(fsp.open)
  const real = open.getMockImplementation()!
  open.mockImplementation(async (...args) => {
    const handle = await real(...args)
    if (matches(String(args[0]))) { open.mockImplementation(real); patch(handle) }
    return handle
  })
}

/** Hold the next matching handle's fsync until `release`; `started` resolves once the fsync is reached. */
export function gateFsync(matches?: (path: string) => boolean): { release: () => void; started: Promise<void> } {
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  onNextOpen((handle) => {
    const sync = handle.sync.bind(handle)
    vi.spyOn(handle, 'sync').mockImplementationOnce(async () => { entered(); await gate; await sync() })
  }, matches)
  return { release, started }
}
