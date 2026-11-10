/**
 * TAL-1647, TAL-2078: the reasoning query and write owners the composer chip and Settings › Models share. They stay out of
 * `app/queries.ts` because only lazy routes use them, and that module is part of the layout bundle.
 */
import type { ReasoningStatus } from '@maudecode/talaria-web-contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useResourceEffects, useResourceMutation } from '../sessions/useResourceMutation'
import { showErrorToast } from '../toast/errorToast'

/** TAL-2078: the profile default's reasoning status (the main model's), which a chat without a session starts from. */
export const PROFILE_REASONING = keys.reasoning(null, null, null)
type ReasoningKey = ReturnType<typeof keys.reasoning>
/** One effort's optimistic owner: one chat's key, or the profile default's. */
export const reasoningResource = (key: ReasoningKey) => JSON.stringify(key)

/** TAL-1647, TAL-2078: one chat's reasoning status, or without a chat the profile default; the composer and Settings share the key. */
export function useReasoningQuery(sessionId?: string | null, model?: string | null, provider?: string | null, enabled = true) {
  return useQuery({ queryKey: keys.reasoning(sessionId, model, provider), queryFn: () => api.fetchReasoning(sessionId ?? undefined, model, provider), enabled, staleTime: 30_000 })
}

/**
 * TAL-1647, TAL-2078: the one effort write owner. A key with a chat writes that chat's effort; without one, the profile default.
 * The pick shows at once; a refusal rolls it back with the error toast.
 */
export function useSetReasoningEffort(onSaved?: (status: ReasoningStatus) => void) {
  const qc = useQueryClient()
  return useResourceMutation({
    resource: ({ key }: { key: ReasoningKey; level: string | null }) => reasoningResource(key),
    queryKey: ['reasoning'], readKeys: ({ key }) => [{ queryKey: key, exact: true }],
    effect: ({ level }) => ({ value: level }),
    mutationFn: ({ key: [, sid, model, provider], level }) => api.setReasoningEffort(level ?? '', model, provider, sid ?? undefined),
    onSuccess: (status, { key }) => { qc.setQueryData(key, status); onSaved?.(status) },
    onError: showErrorToast,
  })
}

/** Whether Web shows thinking, as the user just chose it, until the server's reread confirms it. */
export function useReasoningDisplayChoice() {
  return useResourceEffects<'show' | 'hide'>()['reasoning-display']?.value
}

/** The one write owner for showing thinking; history is projected by the server under the same preference as the live stream. */
export function useSetReasoningDisplay() {
  const qc = useQueryClient()
  return useResourceMutation({
    resource: () => 'reasoning-display', queryKey: [], readKeys: () => [['reasoning'], keys.sessions.all, ['worklog-history'], keys.settings], effect: (display: 'show' | 'hide') => ({ value: display }),
    mutationFn: (display) => api.setReasoningDisplay(display),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.settings }) },
    onError: showErrorToast,
  })
}
