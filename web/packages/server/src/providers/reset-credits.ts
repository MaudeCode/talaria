import type { ResetCredit, ResetCredits, SidecarResult } from '@maudecode/talaria-web-contracts'

type ProviderCredit = SidecarResult<'usage.reset_credits'>['credits'][number]
type Cover = NonNullable<ResetCredit['covers']>[number]

/**
 * TAL-2681: the quota windows a grant restores, from the provider's wording ("Full reset (Weekly + 5 hr)", "Weekly reset");
 * a full reset names no window and restores both. Null when the wording names neither.
 */
export function resetCreditCovers(title: string | null, description: string | null): Cover[] | null {
  const text = `${title ?? ''} ${description ?? ''}`.toLowerCase()
  const session = /\b5[\s-]?(h|hr|hrs|hour|hours)\b|\bfive[\s-]hours?\b|\bsession\b/.test(text)
  const weekly = /\bweek(ly)?\b|\b7[\s-]?days?\b/.test(text)
  if (session || weekly) return [...(session ? ['session' as const] : []), ...(weekly ? ['weekly' as const] : [])]
  return /\bfull\b/.test(text) ? ['session', 'weekly'] : null
}

/** One provider grant as Insights shows it: an `available` grant past its expiry is `expired` and cannot be spent. */
export function resetCreditView(c: ProviderCredit, at: number): ResetCredit {
  const status = (c.status ?? '').toLowerCase()
  const lapsed = c.expires_at !== null && Date.parse(c.expires_at) <= at * 1000
  const state: ResetCredit['state'] = status === 'available' ? (lapsed ? 'expired' : 'available') : status === 'redeeming' || status === 'redeemed' || status === 'expired' ? status : 'unknown'
  return { id: c.id, state, redeemable: state === 'available', title: c.title, description: c.description, covers: resetCreditCovers(c.title, c.description), granted_at: c.granted_at, expires_at: c.expires_at, redeemed_at: c.redeemed_at }
}

const time = (iso: string | null, missing: number): number => (iso === null ? missing : Date.parse(iso))

/** The `usage.reset_credits` answer as of `at` (seconds, `computed_at` in ISO), as `/api/provider/quotas/reset-credits` ships it; a failed or absent read says why. */
export function resetCreditsView(sourceId: string, read: SidecarResult<'usage.reset_credits'> | null, at: number, computed_at: string): ResetCredits {
  const base = { source_id: sourceId, computed_at, available_count: 0, credits: [], history: [] }
  if (read?.status === 'no_credentials') return { ...base, status: 'unsupported', message: 'Sign in to OpenAI Codex with a ChatGPT account to use banked resets.' }
  if (read?.status === 'http_error' && (read.http_status === 401 || read.http_status === 403)) return { ...base, status: 'unsupported', message: 'OpenAI Codex refused the reset list. Sign in again with a ChatGPT account.' }
  if (read?.status === 'http_error' && read.http_status === 404) return { ...base, status: 'unsupported', message: 'OpenAI Codex offers no usage limit resets for this account.' }
  if (read?.status !== 'ok') return { ...base, status: 'unavailable', message: 'Usage limit resets are temporarily unavailable.' }
  const views = read.credits.map((c) => resetCreditView(c, at))
  const credits = views.filter((c) => c.redeemable)
    .sort((a, b) => time(a.expires_at, Infinity) - time(b.expires_at, Infinity) || time(a.granted_at, 0) - time(b.granted_at, 0) || a.id.localeCompare(b.id))
  const recent = (c: ResetCredit): number => time(c.redeemed_at ?? c.expires_at ?? c.granted_at, 0)
  const history = views.filter((c) => !c.redeemable).sort((a, b) => recent(b) - recent(a) || a.id.localeCompare(b.id))
  return { ...base, status: 'available', message: null, available_count: read.available_count ?? credits.length, credits, history }
}
