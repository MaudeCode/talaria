import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { walkSkillFiles } from '../tools/skills.js'
import { persistentStateChanges, persistentStateSnapshot } from './state-saved.js'

vi.mock('../tools/skills.js', { spy: true })
vi.mock('node:fs/promises', { spy: true })

const homes: string[] = []
function home(): string {
  const path = mkdtempSync(join(tmpdir(), 'talaria-state-saved-'))
  homes.push(path)
  return path
}
function skill(profile: string, name: string, content = '# skill'): string {
  const dir = join(profile, 'skills', name)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  writeFileSync(file, content)
  return file
}
afterEach(() => {
  vi.clearAllMocks()
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true })
})

it('refreshes file signatures without walking unchanged directories or mutating the previous snapshot', async () => {
  const profile = home()
  const file = skill(profile, 'custom/deploy')
  mkdirSync(join(profile, 'memories'))
  writeFileSync(join(profile, 'memories', 'MEMORY.md'), 'old memory')
  const before = await persistentStateSnapshot(profile)
  const directoryStamp = statSync(join(file, '..'), { bigint: true }).mtimeNs
  writeFileSync(file, '# updated skill content')
  writeFileSync(join(profile, 'memories', 'MEMORY.md'), 'new memory content')
  expect(statSync(join(file, '..'), { bigint: true }).mtimeNs).toBe(directoryStamp)
  const after = await persistentStateSnapshot(profile)
  expect(persistentStateChanges(before, after)).toEqual({ memory_saved: true, skills: [{ name: 'deploy', path: 'custom/deploy/SKILL.md', action: 'updated' }] })
  expect(before.skills).not.toEqual(after.skills)
  expect(walkSkillFiles).toHaveBeenCalledTimes(1)
})

it('discovers changes inside deep and previously empty directories, and removes deleted paths', async () => {
  const profile = home()
  skill(profile, 'custom/group/deploy')
  mkdirSync(join(profile, 'skills/custom/group/empty'))
  const before = await persistentStateSnapshot(profile)
  skill(profile, 'custom/group/empty/new')
  rmSync(join(profile, 'skills/custom/group/deploy'), { recursive: true })
  const after = await persistentStateSnapshot(profile)
  expect(persistentStateChanges(before, after).skills).toEqual([{ name: 'new', path: 'custom/group/empty/new/SKILL.md', action: 'created' }])
  expect(Object.keys(after.skills)).toEqual(['custom/group/empty/new/SKILL.md'])
  expect(walkSkillFiles).toHaveBeenCalledTimes(2)
  expect(await persistentStateSnapshot(profile)).toEqual(after)
  expect(walkSkillFiles).toHaveBeenCalledTimes(2)
})

it('isolates profile caches and notices missing roots being created, removed and recreated', async () => {
  const a = home()
  const b = home()
  expect(await persistentStateSnapshot(null)).toEqual({ memory: {}, skills: {} })
  expect(await persistentStateSnapshot(a)).toEqual({ memory: {}, skills: {} })
  skill(a, 'alpha')
  skill(b, 'beta')
  expect(Object.keys((await persistentStateSnapshot(a)).skills)).toEqual(['alpha/SKILL.md'])
  expect(Object.keys((await persistentStateSnapshot(b)).skills)).toEqual(['beta/SKILL.md'])
  rmSync(join(a, 'skills'), { recursive: true })
  expect((await persistentStateSnapshot(a)).skills).toEqual({})
  skill(a, 'replacement')
  expect(Object.keys((await persistentStateSnapshot(a)).skills)).toEqual(['replacement/SKILL.md'])
})

it('keeps vendored trees and symlinked directories or skill files out of the scan', async () => {
  const profile = home()
  skill(profile, 'real')
  skill(profile, 'node_modules/ignored')
  skill(profile, '.git/ignored')
  const outside = home()
  const target = skill(outside, 'outside')
  symlinkSync(join(outside, 'skills'), join(profile, 'skills/linked-directory'))
  mkdirSync(join(profile, 'skills/linked-file'))
  symlinkSync(target, join(profile, 'skills/linked-file/SKILL.md'))
  expect(Object.keys((await persistentStateSnapshot(profile)).skills)).toEqual(['real/SKILL.md'])
  rmSync(join(profile, 'skills/real/SKILL.md'))
  symlinkSync(target, join(profile, 'skills/real/SKILL.md'))
  expect((await persistentStateSnapshot(profile)).skills).toEqual({})
})

it('retries an incomplete directory scan rather than retaining it in the cache', async () => {
  const profile = home()
  skill(profile, 'deploy')
  vi.mocked(readdir).mockRejectedValueOnce(new Error('transient directory read failure'))
  expect((await persistentStateSnapshot(profile)).skills).toEqual({})
  expect(Object.keys((await persistentStateSnapshot(profile)).skills)).toEqual(['deploy/SKILL.md'])
  expect(walkSkillFiles).toHaveBeenCalledTimes(2)
})

it('bounds retained profile inventories and rebuilds an evicted profile', async () => {
  const first = home()
  skill(first, 'deploy')
  const before = await persistentStateSnapshot(first)
  for (let i = 0; i < 32; i += 1) {
    const profile = home()
    skill(profile, 'other')
    await persistentStateSnapshot(profile)
  }
  vi.mocked(walkSkillFiles).mockClear()
  expect(await persistentStateSnapshot(first)).toEqual(before)
  expect(walkSkillFiles).toHaveBeenCalledTimes(1)
})
