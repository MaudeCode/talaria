import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BootstrapSchema } from './routes/core.js'

/** TAL-1712: the shared fixture for the bootstrap's optional `shell`. */
describe('bootstrap shell contract', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/bootstrap-shell.json', import.meta.url), 'utf8')) as Record<string, unknown>

  it('parses an authenticated bootstrap with the shell and an unauthenticated one without it', () => {
    const shell = BootstrapSchema.parse(fixture.authenticated).shell
    expect(Object.keys(shell ?? {}).sort()).toEqual(['profiles', 'projects', 'settings', 'workspaces'])
    expect(shell?.projects.projects.map((p) => p.name)).toEqual(['Synthetic project'])
    expect(BootstrapSchema.parse(fixture.unauthenticated).shell).toBeUndefined()
  })
})
