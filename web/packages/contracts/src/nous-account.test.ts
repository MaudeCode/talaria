import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { NousAccountSchema, OnboardingOAuthSchema, ProviderSchema } from './index.js'

it('preserves safe shared Nous account results and tolerates older responses', () => {
  const fixtures = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/nous-account.json', import.meta.url), 'utf8')) as Record<string, unknown>
  for (const account of Object.values(fixtures)) {
    expect(NousAccountSchema.parse(account)).toEqual(account)
    expect(OnboardingOAuthSchema.parse({ status: 'approved', nous_account: account }).nous_account).toEqual(account)
    expect(ProviderSchema.parse({ id: 'nous', nous_account: account }).nous_account).toEqual(account)
  }
  expect(OnboardingOAuthSchema.parse({ status: 'approved' }).nous_account).toBeUndefined()
  expect(ProviderSchema.parse({ id: 'nous' }).nous_account).toBeUndefined()
  expect(ProviderSchema.safeParse({ id: 'nous', nous_account_error: 123 }).success).toBe(false)
  expect(NousAccountSchema.parse({ ...fixtures.moved as object, anon_token: 'discarded' })).not.toHaveProperty('anon_token')
})
