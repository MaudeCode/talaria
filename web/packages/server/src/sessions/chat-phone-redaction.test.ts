import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { Session } from './session.js'

type Row = Record<string, unknown>

// Synthetic: a reserved-for-fiction +1 555-01xx number and a GitHub-shaped key that was never issued.
const PHONE = '+15550100123'
const KEY = `ghp_${'Synth3ticKey0'.repeat(3)}`
const OPT_OUT = { security: { redact_phone_numbers: false } }

describe('chat phone numbers follow each session\'s own profile policy (TAL-2651)', () => {
  let s: TestServer
  const sidecar = new FakeSidecar()
  const configs = new Map<string, { config: Row; managed?: Row }>()
  let work = ''
  beforeAll(async () => {
    s = await bootTestServer({ sidecar })
    work = join(s.state, 'profiles', 'work')
    mkdirSync(work, { recursive: true })
    for (const home of [s.state, work]) writeFileSync(join(home, 'config.yaml'), '# synthetic phone policy\n')
    sidecar.respond('config.get', (params) => {
      const entry = configs.get(params.profile_home)
      if (!entry) throw new SidecarError('config unreadable', { condition: 'config_unreadable' })
      return { path: join(params.profile_home, 'config.yaml'), exists: true, config: entry.config, managed: entry.managed ?? {} }
    })
    sidecar.respond('config.declares_key', (params) => ({ declared: params.key === 'security.redact_phone_numbers' }))
    for (const [sid, profile] of [['root-chat', 'default'], ['work-chat', 'work']] as const) {
      await s.deps.sessionStore.save(new Session({ session_id: sid, title: 'chat', profile, workspace: s.workspace, updated_at: 1, messages: [
        { role: 'user', content: `What is ${PHONE}?` },
        { role: 'assistant', content: `Call ${PHONE} with ${KEY}` },
      ] }, { workspace: s.workspace, model: null }))
    }
  })
  afterAll(() => s.close())

  const policy = (root: { config: Row; managed?: Row } | null, profile: { config: Row; managed?: Row } | null): void => {
    for (const [home, entry] of [[s.state, root], [work, profile]] as const) {
      if (entry) configs.set(home, entry)
      else configs.delete(home)
    }
    s.deps.agentConfig.invalidate()
  }
  const reply = async (sid: string): Promise<string> => {
    const session = await s.deps.sessions.publicSession(await s.deps.sessionStore.get(sid))
    const shown = JSON.stringify(session)
    expect(shown).not.toContain(KEY)
    // The user's own message is no assistant reply: it stays masked whatever the profile says.
    expect(shown.split(PHONE).length).toBeLessThanOrEqual(2)
    return String((session.messages as Row[]).find((m) => m.role === 'assistant')!.content)
  }

  it('keeps the number in the opted-out profile\'s replies only, and masks it again once that profile opts back in', async () => {
    policy({ config: {} }, { config: OPT_OUT })
    expect(await reply('work-chat')).toContain(PHONE)
    expect(await reply('root-chat')).not.toContain(PHONE)
    policy({ config: OPT_OUT }, { config: { security: { redact_phone_numbers: true } } })
    expect(await reply('work-chat')).not.toContain(PHONE)
    expect(await reply('root-chat')).toContain(PHONE)
    // Exports and public shares leave the chat, so they keep the number masked for the opted-out profile too.
    // The masked form shows the reply was exported; HTML renders its `****` as emphasis, so it checks only the absence.
    const masked = (text: string, where: string, shown = true): void => {
      if (shown) expect(text, where).toContain('+155****0123')
      expect(text, where).not.toContain(PHONE)
    }
    for (const format of ['json', 'markdown', 'html']) masked(await (await s.get(`/api/session/export?session_id=root-chat&format=${format}`)).text(), format, format !== 'html')
    const share = await (await s.get('/api/share/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'root-chat' }) })).json() as { share: { token: string } }
    masked(await (await s.get(`/api/share/${share.share.token}`)).text(), 'share')
  })

  it.each([
    ['set to true', { config: { security: { redact_phone_numbers: true } } }],
    ['absent', { config: {} }],
    ['a quoted "false"', { config: { security: { redact_phone_numbers: 'false' } } }],
    ['the number 0', { config: { security: { redact_phone_numbers: 0 } } }],
    ['pinned on by the administrator', { config: OPT_OUT, managed: { security: { redact_phone_numbers: true } } }],
    ['unreadable', null],
  ])('masks the number when the profile\'s setting is %s', async (_name, entry) => {
    policy({ config: {} }, entry)
    expect(await reply('work-chat')).not.toContain(PHONE)
  })

  it('masks the number on an Agent without the opt-out', async () => {
    policy({ config: {} }, { config: OPT_OUT })
    sidecar.respond('config.declares_key', () => ({ declared: false }))
    try {
      expect(await reply('work-chat')).not.toContain(PHONE)
    } finally {
      sidecar.respond('config.declares_key', (params) => ({ declared: params.key === 'security.redact_phone_numbers' }))
    }
  })
})
