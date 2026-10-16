import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, platformDefaultHermesHome } from './config.js'
import { loadStartupEnv } from './cli/dotenv.js'

let home: string
beforeEach(() => { home = mkdtempSync(resolve(tmpdir(), 'talaria-config-')) })
afterEach(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }) })

it('selects JSON session storage by default and explicitly', () => {
  for (const storage of [undefined, 'json']) {
    expect(loadConfig({ home, webRoot: home, env: { TALARIA_STORAGE: storage } }).storage).toBe('json')
  }
})

it('rejects an unknown session storage backend without falling back', () => {
  expect(() => loadConfig({ home, webRoot: home, env: { TALARIA_STORAGE: 'missing' } })).toThrow('Unknown TALARIA_STORAGE="missing"; supported backends: json')
})

describe.each(['darwin', 'win32'])('Agent home on %s', (platform) => {
  beforeEach(() => { vi.spyOn(process, 'platform', 'get').mockReturnValue(platform as NodeJS.Platform) })

  it.each([undefined, '', '-desktop', ' beta.1 ', '/nested'])('uses the literal suffix %j for home and Web state', (suffix) => {
    const localAppData = resolve(home, 'AppData', 'Local')
    const config = loadConfig({ home, webRoot: home, env: { LOCALAPPDATA: localAppData, HERMES_DATA_DIR_SUFFIX: suffix } })
    const expected = platform === 'win32'
      ? resolve(localAppData, `hermes${suffix ?? ''}`)
      : resolve(home, `.hermes${suffix ?? ''}`)
    expect(config.hermesHome).toBe(expected)
    expect(config.stateDir).toBe(resolve(expected, 'webui'))
  })

  it('lets an explicit home override the suffix', () => {
    const config = loadConfig({ home, webRoot: home, env: { HERMES_HOME: '~/custom', HERMES_DATA_DIR_SUFFIX: '-desktop' } })
    expect(config.hermesHome).toBe(resolve(home, 'custom'))
  })
})

it('keeps unsuffixed Windows legacy state but never selects it for a suffix', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const localAppData = resolve(home, 'AppData', 'Local')
  mkdirSync(resolve(home, '.hermes', 'webui'), { recursive: true })
  expect(platformDefaultHermesHome({ LOCALAPPDATA: localAppData }, home)).toBe(resolve(home, '.hermes'))
  expect(platformDefaultHermesHome({ LOCALAPPDATA: localAppData, HERMES_DATA_DIR_SUFFIX: '-desktop' }, home))
    .toBe(resolve(localAppData, 'hermes-desktop'))
})

it('uses the native Windows suffix location even without LOCALAPPDATA', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  expect(platformDefaultHermesHome({ HERMES_DATA_DIR_SUFFIX: '-desktop' }, home))
    .toBe(resolve(home, 'AppData', 'Local', 'hermes-desktop'))
  expect(platformDefaultHermesHome({}, home)).toBe(resolve(home, '.hermes'))
})

it('loads credentials from the same suffixed home during launcher startup', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  const webRoot = resolve(home, 'web')
  mkdirSync(webRoot)
  writeFileSync(resolve(webRoot, '.env'), 'HERMES_DATA_DIR_SUFFIX=-desktop\n')
  for (const [directory, value] of [['.hermes', 'wrong'], ['.hermes-desktop', 'correct']] as const) {
    mkdirSync(resolve(home, directory))
    writeFileSync(resolve(home, directory, '.env'), `EXAMPLE_API_KEY=${value}\nHERMES_DATA_DIR_SUFFIX=-spoofed\n`)
  }
  const env: Record<string, string | undefined> = {}
  const startup = loadStartupEnv({ env, webRoot, home })
  expect(startup.hermesHome).toBe(resolve(home, '.hermes-desktop'))
  expect(env.EXAMPLE_API_KEY).toBe('correct')
  expect(env.HERMES_DATA_DIR_SUFFIX).toBe('-desktop')
  expect(loadConfig({ env, webRoot, home }).hermesHome).toBe(startup.hermesHome)
})
