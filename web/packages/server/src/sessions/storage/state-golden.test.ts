import { createECDH, createPrivateKey, createPublicKey } from 'node:crypto'
import { FakeAuthenticator } from '../../test/passkeys.js'
import { testSessionDocuments } from '../../test/storage.js'
import { JsonJournal, JsonJournalWriter } from './json-journal.js'
import { JsonDocuments } from '../../test/storage.js'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DraftStore, DraftVersionConflict } from '../drafts.js'
import { ShareStore } from '../shares.js'
import { HeldWakeups } from '../wakeup-pause.js'
import { ProjectStore } from '../../projects.js'
import { SettingsStore } from '../../settings.js'
import { AuthStore } from '../../auth/store.js'
import { PasskeyStore } from '../../auth/passkeys.js'
import { UpdateNotificationStore } from '../../tools/update-notifications.js'
import { ExtensionService } from '../../tools/extensions.js'
import { ProfileService } from '../../profiles/profiles.js'
import { recoveryStampingSince } from '../recovery.js'
import { Session } from '../session.js'

vi.mock('node:crypto', async (original) => ({ ...await original<typeof import('node:crypto')>(), randomBytes: (size: number) => Buffer.alloc(size, 7), randomUUID: () => '00000000-0000-4000-8000-000000000007' }))

it('preserves main JSON bytes for every document namespace and run-journal compaction', async () => {
  const state = mkdtempSync(join(tmpdir(), 'talaria-state-golden-'))
  const sessions = join(state, 'sessions')
  const workspace = join(state, 'workspace')
  mkdirSync(sessions)
  mkdirSync(workspace)
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
  try {
    const drafts = new DraftStore(testSessionDocuments(sessions))
    await drafts.write('session', { text: 'draft', files: ['image.png'] }, '1000')
    await expect(Promise.resolve().then(async () => (await drafts.write('session', { text: 'stale', files: [] }, '999')))).rejects.toBeInstanceOf(DraftVersionConflict)
    const shares = new ShareStore(new JsonDocuments(dirname(join(state, 'shares'))), () => 1000)
    const session = new Session({ session_id: 'session' }, { workspace, model: null, modelProvider: null })
    const meta = await shares.createOrRefresh(session, { title: 'Shared', messages: [{ role: 'user', content: 'hello' }], message_count: 1 })
    session.share_token = meta.share_token
    await shares.revoke(session)
    await new HeldWakeups(testSessionDocuments(dirname(join(sessions, '_wakeup_held.json')))).hold('session', [{ process_id: 'process', wakeup_prompt: 'finished' }])
    await new ProjectStore(new JsonDocuments(dirname(join(state, 'projects.json'))), () => []).save([{ project_id: 'project', name: 'Project', profile: 'default' }])
    const settings = new SettingsStore({ documents: new JsonDocuments(state), stateDir: state, env: { HERMES_WEBUI_DEFAULT_WORKSPACE: workspace }, defaultWorkspace: workspace, botName: 'Hermes' })
    await settings.save({ theme: 'light' })
    const auth = new AuthStore({ documents: new JsonDocuments(state), env: {}, settings, now: () => 1000 })
    auth.setKeysForTest(Buffer.alloc(32, 1), Buffer.alloc(32, 2))
    await settings.load()
    await auth.initialize()
    auth.createSession({ username: 'synthetic' })
    auth.recordLoginAttempt('192.0.2.1')
    await auth.flushPersistence()
    const passkeys = new PasskeyStore(new JsonDocuments(state), () => 1000)
    const privateScalar = Buffer.alloc(32)
    privateScalar[31] = 1
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(privateScalar)
    const point = ecdh.getPublicKey()
    const privateKey = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: privateScalar.toString('base64url'), x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') }, format: 'jwk' })
    const authenticator = new FakeAuthenticator({ privateKey, publicKey: createPublicKey(privateKey) }, Buffer.alloc(16, 7))
    const registration = await passkeys.registrationOptions('localhost', 'http://localhost')
    await passkeys.finishRegistration({ ...authenticator.register(registration, 'http://localhost'), label: 'Test' })
    const notices = new UpdateNotificationStore(new JsonDocuments(state), () => new Date(1_000_000))
    await notices.initialize()
    const scope = { owner: 'synthetic', profile: 'default', serverOwner: true }
    const notice = await notices.create(scope, { kind: 'update', phase: 'succeeded', title: 'Updated', message: 'Done' })
    await notices.dismiss(scope, notice.id)
    const profiles = new ProfileService({ documents: new JsonDocuments(state), baseHome: state, isolatedProfileMode: () => false, streamsActive: () => false, profileRunsActive: () => false, sidecar: () => ({ call: () => Promise.resolve({ ok: true }) }), log: () => undefined } as never)
    await profiles.initialize()
    await profiles.delete('deleted', 'default')
    const extensions = new ExtensionService({ documents: new JsonDocuments(state), stateDir: state } as never) as unknown as { writeState(value: { disabled_extensions: string[]; sidecar_proxy_consents: Record<string, string> }): Promise<void>; writeInstallManifest(value: { version: 1; installed: Record<string, unknown> }): Promise<void> }
    await extensions.writeState({ disabled_extensions: ['sample'], sidecar_proxy_consents: {} })
    await extensions.writeInstallManifest({ version: 1, installed: {} })
    await recoveryStampingSince(new JsonDocuments(state))
    const journal = new JsonJournal(sessions)
    const writer = new JsonJournalWriter(journal, 'session', 'stream', 'terminal-only', () => 1000)
    await writer.appendSseEvent('token', { text: 'hello' })
    await writer.appendSseEvent('done', { terminal_state: 'completed' })
    await writer.close()
    const journalPath = join(sessions, '_run_journal/session/stream.jsonl')
    const journalBytes = readFileSync(journalPath, 'utf8')
    utimesSync(journalPath, 1000, 1000)
    await journal.pruneSettled({ now: 2000, retentionSeconds: 1, keepRecent: 0 })
    const settingsBytes = readFileSync(join(state, 'settings.json'), 'utf8')
    expect((JSON.parse(settingsBytes) as { default_workspace: string }).default_workspace).toBe(workspace)
    const files: Record<string, string> = {}
    const scan = (dir: string): void => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) scan(path); else files[relative(state, path)] = readFileSync(path, 'utf8').replaceAll(JSON.stringify(workspace), JSON.stringify('<workspace>')) } }
    scan(state)
    expect({ files, journalBytes }).toMatchSnapshot()
  } finally { vi.restoreAllMocks(); rmSync(state, { recursive: true, force: true }) }
})
