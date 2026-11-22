import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, RotateCcw } from 'lucide-react'
import type { ResetCredit, ResetCreditRedemption } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { resetTime } from '../../i18n/units'
import { IconButton } from '../../ui/Button'
import { ConfirmDialog } from '../../ui/Dialog'
import { Row, RowList, SectionHeader } from '../../ui/List'
import { RowContextMenu } from '../../ui/Menu'
import { RowActionButtons } from '../../ui/RowActionsMenu'
import { randomUuid } from '../../lib/randomHex'

type Outcome = ResetCreditRedemption['outcome']
const OUTCOME: Record<Outcome, () => string> = {
  reset: m.reset_credits_outcome_reset, nothing_to_reset: m.reset_credits_outcome_nothing_to_reset, no_credit: m.reset_credits_outcome_no_credit,
  already_redeemed: m.reset_credits_outcome_already_redeemed, not_found: m.reset_credits_outcome_not_found, not_available: m.reset_credits_outcome_not_available,
  refused: m.reset_credits_outcome_refused, unknown: m.reset_credits_outcome_unknown, unavailable: m.reset_credits_outcome_unavailable,
  unsupported: m.reset_credits_outcome_unsupported, in_progress: m.reset_credits_outcome_in_progress,
}

/** The windows a grant restores, in words; the server read them from the provider's own wording. */
function coversText(covers: ResetCredit['covers']): string {
  if (!covers?.length) return m.reset_credits_covers_unknown()
  if (covers.length > 1) return m.reset_credits_covers_both()
  return covers[0] === 'weekly' ? m.reset_credits_covers_weekly() : m.reset_credits_covers_session()
}

function historyText(c: ResetCredit, locale: string): string {
  if (c.state === 'redeemed') return c.redeemed_at ? m.reset_credits_state_redeemed({ time: resetTime(locale, c.redeemed_at) }) : m.reset_credits_state_redeemed_untimed()
  if (c.state === 'expired' && c.expires_at) return m.reset_credits_state_expired({ time: resetTime(locale, c.expires_at) })
  return c.state === 'redeeming' ? m.reset_credits_state_redeeming() : m.reset_credits_state_unknown()
}

/**
 * TAL-2681: a Codex account's banked usage-limit resets under its quota row: the grants to spend, each with its own Use
 * reset, and a history of used and expired ones. A redemption's result is the provider's, so only the pressed control is
 * busy; every other Use reset of the account waits with it, and the grants and usage are reread before another attempt.
 */
export function ResetCredits({ sourceId, account, locale }: { sourceId: string; account: string; locale: string }) {
  const qc = useQueryClient()
  const key = keys.resetCredits(sourceId)
  const credits = useQuery({ queryKey: key, queryFn: () => api.fetchResetCredits(sourceId), staleTime: 60_000 })
  const [showHistory, setShowHistory] = useState(false)
  const [confirming, setConfirming] = useState<ResetCredit | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  // One attempt id per grant until the provider's answer is known, so retrying after a lost answer repeats that attempt.
  const attempts = useRef(new Map<string, string>())
  const redeem = useMutation({
    mutationFn: (credit: ResetCredit) => {
      const request_id = attempts.current.get(credit.id) ?? randomUuid()
      attempts.current.set(credit.id, request_id)
      return api.redeemResetCredit({ source: sourceId, credit_id: credit.id, request_id })
    },
    onSuccess: (result, credit) => {
      if (result.outcome !== 'unknown' && result.outcome !== 'in_progress') attempts.current.delete(credit.id)
      if (result.reset_credits) qc.setQueryData(key, result.reset_credits)
      setOutcome(result.outcome)
    },
    onError: () => { setOutcome('unknown') },
    // The button stays busy until the grants and every quota row show the provider's values again.
    onSettled: (result) => Promise.all([
      result?.reset_credits ? undefined : qc.invalidateQueries({ queryKey: key }),
      qc.invalidateQueries({ queryKey: keys.providerQuotas }),
    ]),
  })
  const data = credits.data
  if (!data) return null
  const busy = redeem.isPending ? redeem.variables.id : null
  return (
    <div className="flex w-full flex-col gap-1.5" data-quota-resets={sourceId} data-status={data.status}>
      <SectionHeader
        detail={data.status === 'available' ? m.reset_credits_available({ count: new Intl.NumberFormat(locale).format(data.available_count) }) : undefined}
        action={data.status === 'available' && (
          <IconButton variant="ghost" label={showHistory ? m.reset_credits_history_hide() : m.reset_credits_history_show()} aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          </IconButton>
        )}
      >
        {m.reset_credits_title()}
      </SectionHeader>
      {data.message && <p className="text-xs text-muted">{data.message}</p>}
      {outcome && <p role="status" className="text-xs text-muted" data-reset-outcome={outcome}>{OUTCOME[outcome]()}</p>}
      {data.status === 'available' && data.credits.length === 0 && <p className="text-xs text-muted">{m.reset_credits_none()}</p>}
      {data.credits.length > 0 && (
        <RowList>
          {data.credits.map((c) => {
            const use = { label: m.reset_credits_use(), icon: RotateCcw, run: () => setConfirming(c), busy: busy === c.id, disabled: busy !== null }
            return (
              <Row compact key={c.id} data-reset-credit={c.id} data-state={c.state}>
                <RowContextMenu label={c.title ?? m.reset_credits_untitled()} actions={[use]} trigger={
                  <div className="flex w-full min-w-0 items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-text">{c.title ?? m.reset_credits_untitled()}</div>
                      <div className="truncate text-muted">{coversText(c.covers)} · {c.expires_at ? m.reset_credits_expires({ time: resetTime(locale, c.expires_at) }) : m.reset_credits_no_expiry()}</div>
                    </div>
                    <RowActionButtons actions={[use]} />
                  </div>
                } />
              </Row>
            )
          })}
        </RowList>
      )}
      {showHistory && (data.history.length === 0 ? <p className="text-xs text-muted">{m.reset_credits_history_empty()}</p> : (
        <RowList data-reset-history={sourceId}>
          {data.history.map((c) => (
            <Row compact key={c.id} data-reset-credit={c.id} data-state={c.state}>
              <span className="text-text">{c.title ?? m.reset_credits_untitled()}</span>
              <span className="text-muted">{historyText(c, locale)}</span>
            </Row>
          ))}
        </RowList>
      ))}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => { if (!open) setConfirming(null) }}
        title={m.reset_credits_confirm_title()}
        description={confirming ? m.reset_credits_confirm_body({ covers: coversText(confirming.covers), account }) : undefined}
        confirmLabel={m.reset_credits_use()}
        cancelLabel={m.cancel()}
        onConfirm={() => { if (confirming && !redeem.isPending) { setOutcome(null); redeem.mutate(confirming) } }}
      />
    </div>
  )
}
