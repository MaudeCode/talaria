import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Session } from './session.js'
import { credentialStateFingerprint, recordWakeupPause, wakeupPaused } from './wakeup-pause.js'

const session = (): Session => ({ model_provider: 'openrouter', process_wakeup_pause: null }) as unknown as Session

describe('wakeup pause credential state (TAL-576)', () => {
  it('fingerprints the authoritative config file, even outside the profile home', () => {
    const home = mkdtempSync(join(tmpdir(), 'wakeup-home-'))
    const config = join(mkdtempSync(join(tmpdir(), 'wakeup-cfg-')), 'override.yaml')
    writeFileSync(config, 'model: a\n')
    const s = session()
    recordWakeupPause(s, home, 1, 'openrouter', config)
    expect(wakeupPaused(s, home, config)).toBe(true)
    writeFileSync(config, 'model: b\nprovider: deepseek\n')
    expect(wakeupPaused(s, home, config), 'a switched override lifts the pause').toBe(false)
  })

  it('keeps the pause while credential state cannot be read', () => {
    const home = mkdtempSync(join(tmpdir(), 'wakeup-home-'))
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ credential_pool: { openrouter: [{ api_key: 'k' }] } }))
    const s = session()
    recordWakeupPause(s, home, 1, 'openrouter')
    writeFileSync(join(home, 'auth.json'), '{"credential_pool": ')
    expect(() => credentialStateFingerprint(home)).toThrow()
    expect(wakeupPaused(s, home), 'malformed auth.json is unknown, not a change').toBe(true)
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ credential_pool: { openrouter: [{ api_key: 'k' }, { api_key: 'k2' }] } }))
    expect(wakeupPaused(s, home)).toBe(false)
  })
})
