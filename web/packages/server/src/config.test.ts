import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, migrateLegacyWebEnv, platformDefaultHermesHome, type Env } from './config.js'
import { loadStartupEnv } from './cli/dotenv.js'
import { CONFIG_EXIT_CODE } from './cli/supervise.js'

let home: string
beforeEach(() => { home = mkdtempSync(resolve(tmpdir(), 'talaria-config-')) })
afterEach(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }) })

it('reads listener and child-process settings from the Talaria Web environment', () => {
  const env = { TALARIA_WEB_HOST: '127.0.0.2', TALARIA_WEB_PORT: '9876', TALARIA_WEB_STATE_DIR: resolve(home, 'state') }
  const config = loadConfig({ home, webRoot: home, env })
  expect(config.host).toBe('127.0.0.2')
  expect(config.port).toBe(9876)
  expect(config.stateDir).toBe(env.TALARIA_WEB_STATE_DIR)
})

it('normalizes legacy startup settings once, preserving explicit new values and reporting names without secrets', () => {
  for (const current of [undefined, 'new-secret', '']) {
    const env: Env = { HERMES_WEBUI_PASSWORD: 'old-secret', TALARIA_WEB_PASSWORD: current, HERMES_HOME: home, TALARIA_SIDECAR_LOG_LEVEL: 'INFO' }
    const warn = vi.fn()
    const used = migrateLegacyWebEnv(env, warn)
    expect(env.TALARIA_WEB_PASSWORD).toBe(current ?? 'old-secret')
    expect(used).toEqual(['HERMES_WEBUI_PASSWORD'])
    expect(env.HERMES_HOME).toBe(home)
    expect(env.TALARIA_SIDECAR_LOG_LEVEL).toBe('INFO')
    expect(warn).toHaveBeenCalledExactlyOnceWith(`[webui] WARNING: Deprecated environment variables: HERMES_WEBUI_PASSWORD -> TALARIA_WEB_PASSWORD${current === undefined ? '' : ' (TALARIA_WEB_PASSWORD wins)'}. Use the TALARIA_WEB_ names.`)
    // Canonical inherited settings do not warn again in supervisor/sidecar children.
    warn.mockClear()
    expect(migrateLegacyWebEnv(env, warn)).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  }
  for (const env of [{}, { TALARIA_WEB_PASSWORD: 'new-secret' }]) {
    const before = { ...env }
    const warn = vi.fn()
    expect(migrateLegacyWebEnv(env, warn)).toEqual([])
    expect(env).toEqual(before)
    expect(warn).not.toHaveBeenCalled()
  }
})

it('normalizes dotenv sources before precedence controls and home credential filtering, with one startup warning', () => {
  const webRoot = resolve(home, 'web')
  const agentHome = resolve(home, 'agent-home')
  mkdirSync(webRoot)
  mkdirSync(agentHome)
  writeFileSync(resolve(webRoot, '.env'), 'HERMES_WEBUI_PORT=9999\nHERMES_WEBUI_ALLOWED_HOSTS=talaria.test\n')
  writeFileSync(resolve(agentHome, '.env'), 'HERMES_WEBUI_OIDC_CLIENT_SECRET=untrusted-secret\nHERMES_WEBUI_MAX_UPLOAD_MB=50\n')
  const env: Env = { HERMES_HOME: agentHome, HERMES_WEBUI_PORT: '8787', HERMES_WEBUI_PRESERVE_ENV: '1' }
  const warn = vi.fn()
  migrateLegacyWebEnv(env, warn, (normalizeEnv) => { loadStartupEnv({ env, webRoot, home, normalizeEnv }) })
  expect(env.TALARIA_WEB_PORT).toBe('8787')
  expect(env.TALARIA_WEB_ALLOWED_HOSTS).toBe('talaria.test')
  expect(env.TALARIA_WEB_MAX_UPLOAD_MB).toBe('50')
  expect(env.TALARIA_WEB_OIDC_CLIENT_SECRET).toBeUndefined()
  expect(env.HERMES_WEBUI_OIDC_CLIENT_SECRET).toBeUndefined()
  expect(warn).toHaveBeenCalledOnce()
  const line = warn.mock.calls[0]![0] as string
  expect(line).toContain('HERMES_WEBUI_ALLOWED_HOSTS -> TALARIA_WEB_ALLOWED_HOSTS')
  expect(line).toContain('HERMES_WEBUI_MAX_UPLOAD_MB -> TALARIA_WEB_MAX_UPLOAD_MB')
  expect(line).not.toContain('untrusted-secret')
})

it('normalizes the container shell environment without evaluating setting values as commands', () => {
  const marker = resolve(home, 'executed')
  const password = `quote' and "double"\n$(touch ${marker})`
  const script = resolve(import.meta.dirname, '../../../scripts/lib/normalize-web-env.sh')
  const output = execFileSync('bash', ['-c', 'source "$1"; node -e \'console.log(JSON.stringify({port:process.env.TALARIA_WEB_PORT,password:process.env.TALARIA_WEB_PASSWORD,legacy:process.env.HERMES_WEBUI_PASSWORD}))\'', 'bash', script], {
    env: { PATH: process.env.PATH, HOME: home, HERMES_WEBUI_PORT: '9797', HERMES_WEBUI_PASSWORD: password }, encoding: 'utf8',
  })
  expect(JSON.parse(output)).toEqual({ port: '9797', password })
  expect(existsSync(marker)).toBe(false)
})

it('the standalone health probe honors legacy TLS settings in an independent process', () => {
  const bin = resolve(home, 'bin')
  mkdirSync(bin)
  // The network boundary answers only HTTPS, as a healthy TLS listener would.
  writeFileSync(resolve(bin, 'curl'), '#!/usr/bin/env bash\nif [[ "${*: -1}" == https://127.0.0.1:8787/health ]]; then printf \'{"ok":true}\'; else exit 22; fi\n', { mode: 0o755 })
  const script = resolve(import.meta.dirname, '../../../scripts/lib/health_probe.sh')
  const result = spawnSync('bash', [script, '127.0.0.1', '8787'], {
    env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home, HERMES_WEBUI_TLS_CERT: '/synthetic/cert.pem', HERMES_WEBUI_TLS_KEY: '/synthetic/key.pem' }, encoding: 'utf8',
  })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ ok: true })
  expect(result.stderr.match(/\[webui\] WARNING:/g)).toHaveLength(1)
})

it('rejects a partial direct TLS pair, naming the missing variable without echoing the configured path (TAL-2222)', () => {
  const path = resolve(home, 'synthetic-tls.pem')
  const advice = 'Set both to serve HTTPS directly, or neither to serve plain HTTP.'
  const refusal = (env: Env): unknown => { try { return loadConfig({ home, webRoot: home, env }) } catch (error) { return error } }
  // The whole message is matched, so it carries no configured value. Exit code 78 keeps a self-update from rolling back
  // to a release that served plain HTTP for this configuration.
  expect(refusal({ TALARIA_WEB_TLS_CERT: path })).toMatchObject({ exitCode: CONFIG_EXIT_CODE, message: `TALARIA_WEB_TLS_CERT is set but TALARIA_WEB_TLS_KEY is not. ${advice}` })
  expect(refusal({ TALARIA_WEB_TLS_KEY: path, TALARIA_WEB_TLS_CERT: ' ' })).toMatchObject({ exitCode: CONFIG_EXIT_CODE, message: `TALARIA_WEB_TLS_KEY is set but TALARIA_WEB_TLS_CERT is not. ${advice}` })
})

it('selects JSON session storage by default, and each backend explicitly', () => {
  expect(loadConfig({ home, webRoot: home, env: {} }).storage).toBe('json')
  const selected = (storage: string): string => { try { return loadConfig({ home, webRoot: home, env: { TALARIA_STORAGE: storage } }).storage } catch (error) { return (error as Error).message } }
  for (const storage of ['json', 'jsonl', 'sqlite', 'postgres']) expect(selected(storage)).toBe(storage)
})

it('rejects an unknown session storage backend without falling back', () => {
  expect(() => loadConfig({ home, webRoot: home, env: { TALARIA_STORAGE: 'missing' } })).toThrow('Unknown TALARIA_STORAGE="missing"; supported backends: json, jsonl, sqlite, postgres')
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
