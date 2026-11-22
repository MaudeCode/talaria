import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ResetCreditRedemptionSchema, ResetCreditsSchema, type ResetCredit, type ResetCreditRedemption, type ResetCredits as Credits } from '@maudecode/talaria-web-contracts'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import type { UseQueryResult } from '@tanstack/react-query'
import type { z } from 'zod'
import { ProviderQuotasSchema } from '../../contracts'
import { ProviderQuotaRows } from './ProviderQuotaRows'
import { ResetCredits } from './ResetCredits'

vi.mock(import('../../api/endpoints'), async (importOriginal) => ({ ...(await importOriginal()), fetchResetCredits: vi.fn(), redeemResetCredit: vi.fn() }))

const grant = (id: string, title: string, covers: ResetCredit['covers'], expires_at: string | null, extra: Partial<ResetCredit> = {}): ResetCredit =>
  ({ id, state: 'available', redeemable: true, title, description: null, covers, granted_at: '2029-12-01T00:00:00Z', expires_at, redeemed_at: null, ...extra })
const listed = (credits: ResetCredit[], history: ResetCredit[] = []): Credits => ResetCreditsSchema.parse({ source_id: 'qsrc_codex', computed_at: '2030-01-01T00:00:00Z', status: 'available', message: null, available_count: credits.length, credits, history })
const FULL_A = grant('rc_full_a', 'Full reset (Weekly + 5 hr)', ['session', 'weekly'], '2030-02-10T00:00:00Z')
const FULL_B = grant('rc_full_b', 'Full reset (Weekly + 5 hr)', ['session', 'weekly'], '2030-03-10T00:00:00Z')
const WEEKLY = grant('rc_weekly', 'Weekly reset', ['weekly'], null)
const USED = grant('rc_used', 'Full reset (Weekly + 5 hr)', ['session', 'weekly'], null, { state: 'redeemed', redeemable: false, redeemed_at: '2029-12-20T10:00:00Z' })
const EXPIRED = grant('rc_expired', '5 hr reset', ['session'], '2029-12-01T00:00:00Z', { state: 'expired', redeemable: false })

function setup(first: Credits) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const invalidated = { get keys() { return invalidate.mock.calls.map(([filters]) => filters?.queryKey) } }
  vi.mocked(api.fetchResetCredits).mockResolvedValue(first)
  render(<QueryClientProvider client={client}><ResetCredits sourceId="qsrc_codex" account="work@example.test" locale="en-US" /></QueryClientProvider>)
  return { invalidated, user: userEvent.setup() }
}
const row = (id: string): HTMLElement => document.querySelector(`[data-reset-credit="${id}"]`)!
const useButtons = (): HTMLElement[] => screen.getAllByRole('button', { name: 'Use reset' })
/** A redemption the test answers when it chooses. */
function heldRedemption() {
  let answer: (value: ResetCreditRedemption) => void = () => undefined
  let fail: (error: Error) => void = () => undefined
  vi.mocked(api.redeemResetCredit).mockImplementationOnce(() => new Promise((resolve, reject) => { answer = resolve; fail = reject }))
  return { answer: (value: ResetCreditRedemption) => { answer(ResetCreditRedemptionSchema.parse(value)) }, fail: (error: Error) => { fail(error) } }
}

describe('ResetCredits (TAL-2681)', () => {
  it('lists identical grants separately and spends exactly the chosen one once', async () => {
    const { invalidated, user } = setup(listed([FULL_A, FULL_B, WEEKLY]))
    await screen.findByText('Available 3')
    expect(row('rc_full_a')).toHaveTextContent('Restores the 5-hour and weekly limits · Expires')
    expect(row('rc_full_b')).toHaveTextContent('Full reset (Weekly + 5 hr)')
    expect(row('rc_weekly')).toHaveTextContent('Restores the weekly limit · No expiry')
    const held = heldRedemption()
    await user.click(within(row('rc_full_b')).getByRole('button', { name: 'Use reset' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Restores the 5-hour and weekly limits of work@example.test.')
    await user.click(within(dialog).getByRole('button', { name: 'Use reset' }))
    expect(vi.mocked(api.redeemResetCredit).mock.calls.map(([body]) => body.credit_id)).toEqual(['rc_full_b'])
    // While the provider decides, no grant of this account can be sent again.
    await waitFor(() => { expect(useButtons().every((b) => b.hasAttribute('disabled'))).toBe(true) })
    expect(within(row('rc_full_b')).getByRole('button', { name: 'Use reset' })).toHaveAttribute('aria-busy', 'true')
    held.answer({ outcome: 'reset', windows_reset: 2, credit: { ...FULL_B, state: 'redeemed', redeemable: false }, reset_credits: listed([FULL_A, WEEKLY]) })
    expect(await screen.findByRole('status')).toHaveTextContent('Reset used; limits reread')
    expect(document.querySelector('[data-reset-credit="rc_full_b"]')).toBeNull()
    expect(screen.getByText('Available 2')).toBeInTheDocument()
    expect(invalidated.keys).toContainEqual(keys.providerQuotas)
    await waitFor(() => { expect(useButtons().some((b) => b.hasAttribute('disabled'))).toBe(false) })
    expect(vi.mocked(api.redeemResetCredit)).toHaveBeenCalledTimes(1)
  })

  it('rereads the grants after a lost answer and retries the same attempt, never a new one', async () => {
    const { user } = setup(listed([FULL_A, FULL_B]))
    await screen.findByText('Available 2')
    const lost = heldRedemption()
    const use = async (id: string) => {
      await user.click(within(row(id)).getByRole('button', { name: 'Use reset' }))
      await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Use reset' }))
    }
    await use('rc_full_a')
    const reads = vi.mocked(api.fetchResetCredits).mock.calls.length
    lost.fail(new TypeError('Failed to fetch'))
    expect(await screen.findByRole('status')).toHaveTextContent('Reset not confirmed; list rechecked')
    await waitFor(() => { expect(vi.mocked(api.fetchResetCredits).mock.calls.length).toBe(reads + 1) })
    await waitFor(() => { expect(useButtons().some((b) => b.hasAttribute('disabled'))).toBe(false) })
    vi.mocked(api.redeemResetCredit).mockResolvedValueOnce(ResetCreditRedemptionSchema.parse({ outcome: 'already_redeemed', windows_reset: null, credit: null, reset_credits: listed([FULL_B]) }))
    await use('rc_full_a')
    await screen.findByText('This attempt was already processed')
    vi.mocked(api.redeemResetCredit).mockResolvedValueOnce(ResetCreditRedemptionSchema.parse({ outcome: 'reset', windows_reset: 2, credit: null, reset_credits: listed([]) }))
    await use('rc_full_b')
    const [first, retry, other] = vi.mocked(api.redeemResetCredit).mock.calls.map(([body]) => body)
    expect(retry).toEqual(first)
    expect(other?.credit_id).toBe('rc_full_b')
    expect(other?.request_id).not.toBe(first?.request_id)
  })

  it('shows used and expired grants in the history and an unsupported account without Use reset', async () => {
    const { user } = setup(listed([], [USED, EXPIRED]))
    await screen.findByText('No resets to use')
    expect(screen.queryByRole('button', { name: 'Use reset' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Show history' }))
    expect(row('rc_used')).toHaveAttribute('data-state', 'redeemed')
    expect(row('rc_used')).toHaveTextContent('Used')
    expect(row('rc_expired')).toHaveTextContent('Expired')
  })

  it('offers the resets of an exhausted account, which has no windows to show', async () => {
    vi.mocked(api.fetchResetCredits).mockResolvedValue(listed([FULL_A]))
    const quotas = ProviderQuotasSchema.parse({ version: 1, computed_at: '2030-01-01T00:00:00Z', scope_id: 'qscope_test', profile_id: 'default', active_provider: 'openai-codex', requested_source_id: null, missing_source: false, sources: [
      { source_id: 'qsrc_codex', provider_id: 'openai-codex', provider_label: 'OpenAI Codex', account_label: 'work@example.test', status: 'unavailable', status_message: 'OpenAI Codex credential is unavailable.', windows: [], reset_credits: true },
    ] })
    const query = { data: quotas, isPending: false, isError: false, isFetching: false, error: null } as unknown as UseQueryResult<z.infer<typeof ProviderQuotasSchema>>
    render(<QueryClientProvider client={new QueryClient()}><ProviderQuotaRows quotas={query} mode="used" onRefresh={vi.fn()} /></QueryClientProvider>)
    const unavailable = document.querySelector('[data-section="insights-quotas-unavailable"]') as HTMLElement
    expect(await within(unavailable).findByText('Available 1')).toBeInTheDocument()
    expect(within(unavailable).getByRole('button', { name: 'Use reset' })).toBeEnabled()
    expect(vi.mocked(api.fetchResetCredits)).toHaveBeenCalledWith('qsrc_codex')
  })
})
