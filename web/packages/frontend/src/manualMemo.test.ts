import { resolve } from 'node:path'
import { ESLint, RuleTester } from 'eslint'
import { builtinRules } from 'eslint/use-at-your-own-risk'
import { describe, expect, it } from 'vitest'

const eslint = new ESLint({ cwd: resolve(import.meta.dirname, '..') })
const config = await eslint.calculateConfigForFile('src/features/chat/ChatView.tsx')
// ESLint exposes built-in rule modules only through this entry point, as required by RuleTester.
// eslint-disable-next-line @typescript-eslint/no-deprecated
const rule = builtinRules.get('no-restricted-syntax')!

RuleTester.describe = describe
RuleTester.it = it
new RuleTester().run('no manual React memoization', rule, {
  valid: ["import { useState } from 'react'", "import { memo } from 'react'"].map((code) => ({ code, options: config.rules['no-restricted-syntax'].slice(1) })),
  invalid: ['useMemo', 'useCallback'].flatMap((name) => [
    `import { ${name} } from 'react'`,
    `import { ${name} as cached } from 'react'`,
    `import * as React from 'react'; React.${name}(() => {}, [])`,
  ]).map((code) => ({ code, options: config.rules['no-restricted-syntax'].slice(1), errors: [{ message: /React Compiler/ }] })),
})

it('allows manual hooks only in the uncompiled virtualizer and test support', async () => {
  for (const file of ['src/features/chat/VirtualHistory.tsx', 'src/test/countRenders.tsx', 'src/manualMemo.test.ts']) {
    const allowed = await eslint.calculateConfigForFile(file)
    const selectors = JSON.stringify(allowed.rules['no-restricted-syntax'])
    expect(selectors).not.toContain('useMemo')
    expect(selectors).not.toContain('useCallback')
  }
})
