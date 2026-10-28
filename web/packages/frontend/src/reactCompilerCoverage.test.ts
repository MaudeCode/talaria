import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'oxc-transform-react'
import { describe, expect, it } from 'vitest'

const root = dirname(fileURLToPath(import.meta.url))

// Generated output and test support are not shipped components.
const sources = readdirSync(root, { recursive: true })
  .map(String)
  .filter((file) => /\.tsx?$/.test(file) && !/\.(test|d)\.tsx?$/.test(file))
  .filter((file) => !file.startsWith('paraglide/') && !file.startsWith('test/') && !file.endsWith('.gen.ts'))
  .sort()

// Files React Compiler may still skip. The list only shrinks: a listed file that starts compiling fails until it is removed.
// TanStack Virtual's `useVirtualizer` returns functions the compiler cannot memoize, so its one caller stays uncompiled.
const KNOWN_BAILOUTS = new Set(['features/chat/VirtualHistory.tsx'])

// The components and hooks that re-render while a reply streams.
const HOT_PATH = ['features/chat/ChatView.tsx', 'features/chat/Transcript.tsx', 'features/chat/LiveTurnView.tsx', 'features/chat/useTranscript.ts', 'features/composer/Composer.tsx']

async function compile(file: string) {
  const path = join(root, file)
  const result = await transform(path, readFileSync(path, 'utf8'), {
    jsx: { runtime: 'automatic', development: false, refresh: false },
    reactCompiler: true,
  })
  return { code: result.code, bailouts: result.errors.map((error) => error.codeframe ?? error.message) }
}

// Lint reports most compiler skips, but not `try` with `finally` or a `throw` inside `try`. A skipped function still
// builds, just unmemoized, so the compiler's own diagnostics are the check.
describe('React Compiler coverage', () => {
  it.each(sources.filter((file) => !KNOWN_BAILOUTS.has(file)))('compiles %s', async (file) => {
    expect((await compile(file)).bailouts).toEqual([])
  })

  it.each([...KNOWN_BAILOUTS])('still skips %s (remove it from KNOWN_BAILOUTS once it compiles)', async (file) => {
    expect(sources).toContain(file)
    expect((await compile(file)).bailouts).not.toEqual([])
  })

  it.each(HOT_PATH)('memoizes %s', async (file) => {
    expect((await compile(file)).code).toContain('react/compiler-runtime')
  })
})
