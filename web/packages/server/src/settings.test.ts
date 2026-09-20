import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { atomicWriteText } from './fs/atomic.js'
import { normalizeAppearance, SettingsStore } from './settings.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'talaria-settings-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function store(env: Record<string, string> = {}): SettingsStore {
  const s = new SettingsStore({ file: join(dir, 'settings.json'), env, stateDir: dir, defaultWorkspace: join(dir, 'workspace'), botName: 'Hermes' })
  s.hooks = { hashPassword: (pw) => Promise.resolve(`hashed:${pw}`) }
  return s
}
const write = (value: unknown) => { writeFileSync(join(dir, 'settings.json'), JSON.stringify(value)) }
const onDisk = () => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<string, unknown>

describe('atomicWriteText', () => {
  it('replaces contents without temp debris and creates new files', () => {
    const target = join(dir, 'settings.json')
    writeFileSync(target, '{"theme": "old"}')
    atomicWriteText(target, '{"theme": "new"}')
    expect(readFileSync(target, 'utf8')).toBe('{"theme": "new"}')
    expect(readdirSync(dir)).toEqual(['settings.json'])
    atomicWriteText(join(dir, 'fresh.json'), '{"created": true}')
    expect(readFileSync(join(dir, 'fresh.json'), 'utf8')).toBe('{"created": true}')
  })

  it('preserves a hardened 0600 mode', () => {
    const target = join(dir, 'settings.json')
    writeFileSync(target, '{"password_hash": "x"}')
    chmodSync(target, 0o600)
    atomicWriteText(target, '{"password_hash": "y"}')
    expect(statSync(target).mode & 0o777).toBe(0o600)
  })

  it('writes through a symlink to its referent', () => {
    mkdirSync(join(dir, 'real'))
    mkdirSync(join(dir, 'link'))
    const target = join(dir, 'real', 'settings.json')
    const link = join(dir, 'link', 'settings.json')
    writeFileSync(target, '{"theme": "old"}')
    symlinkSync(target, link)
    atomicWriteText(link, '{"theme": "new"}')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('{"theme": "new"}')
    expect(readdirSync(join(dir, 'link'))).toEqual(['settings.json'])
  })

  it('leaves the original intact when the write fails before the rename', () => {
    const target = join(dir, 'settings.json')
    writeFileSync(target, '{"theme": "keep-me"}')
    expect(() => { atomicWriteText(join(dir, 'missing-dir', 'settings.json'), '{}') }).toThrow()
    expect(readFileSync(target, 'utf8')).toBe('{"theme": "keep-me"}')
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })
})

describe('load', () => {
  it('uses the defaults when no file exists and normalises appearance', () => {
    const s = store().load()
    expect(s.theme).toBe('dark')
    expect(s.skin).toBe('default')
    expect(s.show_cli_sessions).toBe(true)
    expect(s.default_workspace).toBe(join(dir, 'workspace'))
    expect(s.default_model).toBe('')
    expect(s.password_hash).toBeNull()
  })

  it.each([
    [{ theme: 'light' }, ['light', 'default']],
    [{ theme: 'light', skin: 'mono' }, ['light', 'mono']],
    [{ skin: 'mono' }, ['dark', 'mono']],
    [{ theme: 'slate' }, ['dark', 'slate']],
    [{ theme: 'solarized' }, ['dark', 'poseidon']],
    [{ theme: 'monokai' }, ['dark', 'sisyphus']],
    [{ theme: 'nord' }, ['dark', 'slate']],
    [{ theme: 'oled' }, ['dark', 'default']],
    [{ theme: 'weird', skin: 'nope' }, ['dark', 'default']],
  ])('stored appearance %j resolves to %j', (stored, expected) => {
    write(stored)
    const s = store().load()
    expect([s.theme, s.skin]).toEqual(expected)
  })

  it('applies the legacy-key migrations', () => {
    write({ activity_feed_expanded_default: 1, busy_input_mode: 'queue', simplified_tool_calling: false, assistant_language: 'fr', virtualize_transcript: true, onboarding_completed: true })
    const s = store().load()
    expect(s.worklog_details_expanded_default).toBe(true)
    expect(s.default_message_mode).toBe('queue')
    expect(s).not.toHaveProperty('busy_input_mode')
    expect(s).not.toHaveProperty('assistant_language')
    expect(s.simplified_tool_calling).toBe(true)
    expect(s.virtualize_transcript).toBe(false)
    // Established install without the CLI-sessions key is grandfathered off.
    expect(s.show_cli_sessions).toBe(false)
    write({ virtualize_transcript: true, virtualize_transcript_optin: true })
    expect(store().load().virtualize_transcript).toBe(true)
    write({ onboarding_completed: false })
    expect(store().load().show_cli_sessions).toBe(true)
  })

  it('treats a malformed file as empty unless strict', () => {
    writeFileSync(join(dir, 'settings.json'), '{oops')
    const s = store()
    expect(s.readRaw()).toEqual({})
    expect(() => s.readRaw({ strict: true })).toThrow()
    expect(s.load().theme).toBe('dark')
  })
})

describe('save', () => {
  it('ignores unknown keys, validates enums, ranges, lists, and coerces bools', async () => {
    const s = store()
    const saved = await s.save({
      unknown_key: 1,
      send_key: 'bogus',
      font_size: 'large',
      pinned_sessions_limit: '7',
      inflight_state_max_sessions: 999,
      tts_rate: '1.5',
      tts_pitch: 9,
      tts_engine: ' browser ',
      tts_voice: 'x'.repeat(201),
      language: 'zh-CN',
      hidden_tabs: ['chat', 'tasks', ' tasks ', 'kanban', 3],
      composer_control_order: ['hide_composer_mic', 'nope', 'hide_composer_mic'],
      show_tps: 'yes',
      password_hash: 'forged',
      default_model: 'forged',
      provider_cost_budget: '12.345',
      dashboard_plugins: { a: 1, b: 0 },
    })
    expect(saved).not.toHaveProperty('unknown_key')
    expect(saved.send_key).toBe('enter')
    expect(saved.font_size).toBe('large')
    expect(saved.pinned_sessions_limit).toBe(7)
    expect(saved.inflight_state_max_sessions).toBe(8)
    expect(saved.tts_rate).toBe(1.5)
    expect(saved.tts_pitch).toBe(1.0)
    expect(saved.tts_engine).toBe('browser')
    expect(saved.tts_voice).toBe('')
    expect(saved.language).toBe('zh-CN')
    expect(saved.hidden_tabs).toEqual(['tasks', 'kanban'])
    expect(saved.composer_control_order).toEqual(['hide_composer_mic'])
    expect(saved.show_tps).toBe(true)
    expect(saved.password_hash).toBeNull()
    expect(saved.provider_cost_budget).toBe(12.35)
    expect(saved.dashboard_plugins).toEqual({ a: true, b: false })
    const disk = onDisk()
    expect(disk).not.toHaveProperty('default_model')
    // Speech keys persist only once explicitly applied.
    expect(disk).toHaveProperty('tts_rate')
    expect(disk).toHaveProperty('tts_engine')
    expect(disk).not.toHaveProperty('tts_voice')
    expect(disk).not.toHaveProperty('tts_enabled')
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
    expect(s.writeVersion).toBe(1)
  })

  it('normalises theme and skin on save, dropping the skin when a legacy theme is set alone', async () => {
    const s = store()
    expect((await s.save({ theme: 'light', skin: 'mono' })).skin).toBe('mono')
    const saved = await s.save({ theme: 'solarized' })
    expect([saved.theme, saved.skin]).toEqual(['dark', 'poseidon'])
    const kept = await s.save({ theme: 'light' })
    expect([kept.theme, kept.skin]).toEqual(['light', 'poseidon'])
  })

  it('hashes _set_password, clears with _clear_password, and notifies', async () => {
    const s = store()
    const changed: number[] = []
    s.hooks.onPasswordChanged = () => changed.push(1)
    expect((await s.save({ _set_password: ' hunter2 ' })).password_hash).toBe('hashed:hunter2')
    expect(onDisk().password_hash).toBe('hashed:hunter2')
    expect((await s.save({ _clear_password: true })).password_hash).toBeNull()
    expect(changed).toHaveLength(2)
    expect(onDisk()).not.toHaveProperty('_set_password')
  })

  it('rewrites an unusable default_workspace to the first usable fallback', async () => {
    const saved = await store().save({ default_workspace: '/dev/null/not-usable' })
    expect(saved.default_workspace).not.toBe('/dev/null/not-usable')
    expect(onDisk().default_workspace).toBe(saved.default_workspace)
  })

  it('applyStartupWorkspace rewrites a stale stored workspace once', () => {
    write({ default_workspace: join(dir, 'gone', 'x'), theme: 'light' })
    const s = store()
    s.applyStartupWorkspace()
    expect(s.defaultWorkspace).toBe(join(dir, 'gone', 'x'))
    expect(onDisk().default_workspace).toBe(join(dir, 'gone', 'x'))
    const env = store({ HERMES_WEBUI_DEFAULT_WORKSPACE: join(dir, 'env-ws') })
    env.defaultWorkspace = join(dir, 'env-ws')
    env.applyStartupWorkspace()
    expect(onDisk().default_workspace).toBe(join(dir, 'env-ws'))
  })
})

describe('normalizeAppearance', () => {
  it('matches the Python table', () => {
    expect(normalizeAppearance(' Light ', 'MONO')).toEqual(['light', 'mono'])
    expect(normalizeAppearance(null, null)).toEqual(['dark', 'default'])
    expect(normalizeAppearance('slate', 'nope')).toEqual(['dark', 'slate'])
  })
})
