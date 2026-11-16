import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FakeAuthenticator } from '../test/passkeys.js'
import { JsonDocuments } from '../test/storage.js'
import { cborDecode, PasskeyError, PasskeyStore } from './passkeys.js'

describe('cborDecode', () => {
  it('rejects deep nesting and oversized container lengths as PasskeyError', () => {
    expect(() => cborDecode(Buffer.alloc(200_000, 0x81))).toThrow(PasskeyError)
    expect(() => cborDecode(Buffer.from('9bffffffffffffffff', 'hex'))).toThrow(PasskeyError)
    expect(() => cborDecode(Buffer.from('bbffffffffffffffff', 'hex'))).toThrow(PasskeyError)
  })

  it('accepts nesting up to the limit', () => {
    expect(cborDecode(Buffer.concat([Buffer.alloc(15, 0x81), Buffer.from([0x00])]))).toBeDefined()
    expect(() => cborDecode(Buffer.concat([Buffer.alloc(16, 0x81), Buffer.from([0x00])]))).toThrow(PasskeyError)
  })
})

describe('available', () => {
  it('TAL-2209: reads the credential file once, and every register, delete, and clear refreshes the answer', async () => {
    const documents = new JsonDocuments(mkdtempSync(join(tmpdir(), 'talaria-passkeys-')))
    const reads = vi.spyOn(documents, 'get')
    const passkeys = new PasskeyStore(documents, () => 1000)
    expect([await passkeys.available(), await passkeys.available()]).toEqual([false, false])
    expect(reads.mock.calls.filter(([namespace]) => namespace === 'passkeys')).toHaveLength(1)
    const authenticator = new FakeAuthenticator()
    const register = async (): Promise<void> => { await passkeys.finishRegistration({ ...authenticator.register(await passkeys.registrationOptions('localhost', 'http://localhost'), 'http://localhost'), label: 'Test' }) }
    await register()
    expect(await passkeys.available()).toBe(true)
    await passkeys.delete(String((await passkeys.registered())[0]!.id))
    expect(await passkeys.available()).toBe(false)
    await register()
    expect(await passkeys.available()).toBe(true)
    await passkeys.clear()
    expect(await passkeys.available()).toBe(false)
  })
})

describe('challenges and user verification', () => {
  const origin = 'http://localhost'
  const setup = async (): Promise<{ passkeys: PasskeyStore; authenticator: FakeAuthenticator; clock: { t: number } }> => {
    const clock = { t: 1000 }
    const passkeys = new PasskeyStore(new JsonDocuments(mkdtempSync(join(tmpdir(), 'talaria-passkeys-'))), () => clock.t)
    const authenticator = new FakeAuthenticator()
    await passkeys.finishRegistration(authenticator.register(await passkeys.registrationOptions('localhost', origin), origin))
    return { passkeys, authenticator, clock }
  }

  it('TAL-2221: a full context evicts the requesting client\'s own challenges before another client\'s', async () => {
    const { passkeys, authenticator, clock } = await setup()
    const mine = await passkeys.authenticationOptions('localhost', origin, 'client-a')
    for (let i = 0; i < 12; i += 1) { clock.t += 1; await passkeys.authenticationOptions('localhost', origin, 'client-b') }
    await expect(passkeys.finishLogin(authenticator.assert(mine, origin))).resolves.toMatchObject({ ok: true })
  })

  it('TAL-2221: options require user verification and responses without it are refused', async () => {
    const { passkeys, authenticator } = await setup()
    const registration = await passkeys.registrationOptions('localhost', origin)
    expect(registration.authenticatorSelection).toMatchObject({ userVerification: 'required' })
    const unverified = new FakeAuthenticator()
    unverified.uv = false
    await expect(passkeys.finishRegistration(unverified.register(registration, origin))).rejects.toThrow('Passkey user verification was not performed')
    const login = await passkeys.authenticationOptions('localhost', origin)
    expect(login.userVerification).toBe('required')
    authenticator.uv = false
    await expect(passkeys.finishLogin(authenticator.assert(login, origin))).rejects.toThrow('Passkey user verification was not performed')
    expect(await passkeys.registered()).toHaveLength(1)
  })
})
