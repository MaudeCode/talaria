import { describe, expect, it } from 'vitest'
import { redactString } from '../redact.js'
import { HttpFailure } from '../sessions/service.js'
import { restoreMasks } from './memory-masks.js'

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabcdefgh\n-----END RSA PRIVATE KEY-----'
/** A save of `edit(shown)`, as the memory page submits it. */
const save = (original: string, edit: (shown: string) => string): string => restoreMasks(original, redactString(original), edit(redactString(original)))

describe('restoreMasks (TAL-886)', () => {
  it('keeps a multi-line private key, a URL password and a header credential through an edit elsewhere', () => {
    const original = `Deploy key:\n${PEM}\nafter\n§\npostgres://bob:s3cret@db.example/x\n§\nAuthorization: Digest username="bob", response="abc123"`
    expect(redactString(original)).toContain('[REDACTED PRIVATE KEY]')
    expect(save(original, (shown) => shown.replace('after', 'later'))).toBe(original.replace('after', 'later'))
    expect(save(original, (shown) => `New first line\n§\n${shown}`)).toBe(`New first line\n§\n${original}`)
  })

  it('moves a private key with its entry', () => {
    const original = `one\n§\nkey:\n${PEM}\n§\ntwo`
    expect(save(original, (shown) => { const [one, key, two] = shown.split('\n§\n'); return [key, one, two].join('\n§\n') })).toBe(`key:\n${PEM}\n§\none\n§\ntwo`)
  })

  it('drops a secret whose mask the save deletes, and keeps text the file holds literally', () => {
    const original = 'a token ghp_AbCDEFGHIJKLMNOP6789\n§\n***\n§\nb'
    expect(save(original, (shown) => shown.replace('a token ghp_Ab...6789\n§\n', ''))).toBe('***\n§\nb')
    expect(save(original, (shown) => shown.replace(/\nb$/, '\nc'))).toBe(original.replace(/\nb$/, '\nc'))
  })

  it('maps masks back by their text in a rewrite past the edit budget', () => {
    const original = `${'w '.repeat(3_000)}token ghp_AbCDEFGHIJKLMNOP6789`
    expect(save(original, (shown) => `${'z '.repeat(3_000)}${shown.slice(-19)}`)).toBe(`${'z '.repeat(3_000)}token ghp_AbCDEFGHIJKLMNOP6789`)
  })

  it('refuses a copied mask that stands for two secrets', () => {
    const original = 'password: hunter2\n§\npassword: other99'
    expect(save(original, (shown) => shown.replace('password', 'login password'))).toBe(original.replace('password', 'login password'))
    let refusal: unknown
    try { save(original, (shown) => `${shown}\n§\ncopy: ***`) } catch (error) { refusal = error }
    expect(refusal).toBeInstanceOf(HttpFailure)
    expect(refusal).toMatchObject({ status: 422, extra: { code: 'memory_mask_ambiguous', mask: '***' } })
  })

  it('refuses an edit inside a mask instead of writing the mask over its secret', () => {
    const refusal = (original: string, edit: (shown: string) => string): unknown => { try { save(original, edit) } catch (error) { return error } return null }
    expect(refusal('token ghp_AbCDEFGHIJKLMNOP6789', (shown) => `${shown}.`)).toMatchObject({ status: 422, extra: { code: 'memory_mask_edited', mask: 'ghp_Ab...6789' } })
    expect(refusal('OPENAI_API_KEY=hunter2secretvalue', (shown) => shown.replace('OPENAI_API_KEY', 'OPENAI_KEY'))).toMatchObject({ status: 422, extra: { code: 'memory_mask_edited', mask: '***' } })
  })

  it('never swaps the secrets of two entries that show the same mask', () => {
    const original = 'a: password: hunter2\n§\nb: password: other99'
    let refusal: unknown
    try { save(original, (shown) => shown.split('\n§\n').reverse().join('\n§\n')) } catch (error) { refusal = error }
    expect(refusal).toMatchObject({ status: 422, extra: { code: 'memory_mask_ambiguous', mask: '***' } })
    // A moved entry whose mask is unique keeps its value.
    expect(save('a: token ghp_AbCDEFGHIJKLMNOP6789\n§\nb: password: other99', (shown) => shown.split('\n§\n').reverse().join('\n§\n'))).toBe('b: password: other99\n§\na: token ghp_AbCDEFGHIJKLMNOP6789')
  })

  it('writes the submitted text when nothing is masked', () => {
    expect(restoreMasks('plain', 'plain', 'edited')).toBe('edited')
  })
})
