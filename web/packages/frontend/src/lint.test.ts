import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'

// The Web lint config's frontend rules, run by the real Oxlint CLI on fixture files placed at app paths beside a copy of
// the config, so each path-scoped override applies exactly as it does to the source tree.
const web = resolve(import.meta.dirname, '../../..')
const SYNTAX = 'talaria(no-restricted-syntax)'
const app = 'packages/frontend/src/features/lint-fixture'
const fixtures: Record<string, [source: string, reported: string[]]> = {
  [`${app}/fetch.ts`]: ["export const load = () => fetch('/x')", ['eslint(no-restricted-globals)']],
  [`${app}/windowFetch.ts`]: ["export const load = () => window.fetch('/x')", ['eslint(no-restricted-properties)']],
  [`${app}/eventSource.ts`]: ["export const open = () => new EventSource('/x')", ['eslint(no-restricted-globals)']],
  [`${app}/innerHtml.ts`]: ["export const clear = (el: Element) => { el.innerHTML = '' }", [SYNTAX]],
  [`${app}/outerHtml.ts`]: ["export const clear = (el: Element) => { el.outerHTML = '' }", [SYNTAX]],
  [`${app}/insertHtml.ts`]: ["export const add = (el: Element) => { el.insertAdjacentHTML('beforeend', '') }", [SYNTAX]],
  [`${app}/rawHtml.tsx`]: ["export const Raw = () => <div dangerouslySetInnerHTML={{ __html: '' }} />", [SYNTAX]],
  [`${app}/useMemo.ts`]: ["import { useMemo } from 'react'\nexport { useMemo }", [SYNTAX]],
  [`${app}/useCallback.ts`]: ["import { useCallback as cached } from 'react'\nexport { cached }", [SYNTAX]],
  [`${app}/reactMember.ts`]: ["import * as React from 'react'\nexport const memo = React.useMemo", [SYNTAX]],
  [`${app}/nonNull.ts`]: ['export const first = (xs: string[]) => xs[0]!', ['typescript(no-non-null-assertion)']],
  [`${app}/hooks.ts`]: ["import { memo, useState } from 'react'\nexport { memo, useState }", []],
  // Exemptions: the typed network client, the uncompiled virtualizer (DOM sinks stay forbidden), and test code.
  'packages/frontend/src/api/client.ts': ["export const load = () => fetch('/x')", []],
  'packages/frontend/src/features/chat/VirtualHistory.tsx': ["import { useMemo } from 'react'\nexport { useMemo }\nexport const clear = (el: Element) => { el.innerHTML = '' }", [SYNTAX]],
  'packages/frontend/src/test/memo.tsx': ["import { useCallback } from 'react'\nexport { useCallback }", []],
  [`${app}/probe.test.ts`]: ["export const first = (xs: string[]) => xs[0]!\nexport const load = () => fetch('/x')", []],
}

const root = mkdtempSync(join(tmpdir(), 'talaria-lint-'))
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

it('reports each forbidden frontend pattern, and only outside its exempt files', () => {
  cpSync(join(web, '.oxlintrc.json'), join(root, '.oxlintrc.json'))
  cpSync(join(web, 'scripts/oxlint-restricted-syntax.mjs'), join(root, 'scripts/oxlint-restricted-syntax.mjs'))
  for (const [path, [source]] of Object.entries(fixtures)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), `${source}\n`)
  }
  const run = spawnSync(process.execPath, [join(web, 'node_modules/oxlint/bin/oxlint'), '-c', '.oxlintrc.json', '-f', 'json', 'packages'], { cwd: root, encoding: 'utf8' })
  const { diagnostics } = JSON.parse(run.stdout) as { diagnostics: { filename: string; code: string }[] }
  const reported = Object.fromEntries(Object.keys(fixtures).map((path) => [path, diagnostics.filter((d) => d.filename === path).map((d) => d.code)]))
  expect(reported).toEqual(Object.fromEntries(Object.entries(fixtures).map(([path, [, codes]]) => [path, codes])))
})
