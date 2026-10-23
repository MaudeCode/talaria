import type { QueryKey } from '@tanstack/react-query'
import { isApiError, isDefiniteRefusal } from '../../contracts/common'
import { showErrorToast } from '../toast/errorToast'
import { useResourceEffects, useResourceMutation } from '../sessions/useResourceMutation'

/**
 * Answers a prompt only the server clears: an approval, a clarification, a vault prompt, a pending steer. The prompt
 * leaves at once and a refusal brings it back with the error. A 409 (already answered or expired, or a relay that could
 * not reach the run) and an unknown outcome both ask the server whether the prompt still waits before keeping or
 * restoring it, and the answer is never sent again.
 */
export function usePromptAnswer<V, R>(options: {
  resource: (variables: V) => string
  /**
   * Reread when `waiting` cannot be read either. A prompt held only in the stream (approval, steer) has no query here,
   * so it comes back for another answer, which the server refuses if it already took the first (409, `withdrawn: false`).
   */
  queryKey: QueryKey
  send: (variables: V) => Promise<R>
  /** Whether the server still waits on this prompt. */
  waiting: (variables: V) => Promise<boolean>
  /** The server took the answer; `undefined` when a 409 or a read showed the prompt gone. */
  onAnswered?: (result: R | undefined, variables: V) => void
}) {
  const effects = useResourceEffects()
  const { mutate } = useResourceMutation({
    resource: options.resource, queryKey: options.queryKey, effect: () => ({ remove: true }),
    mutationFn: async (variables: V): Promise<R | undefined> => {
      try { return await options.send(variables) } catch (error) {
        const conflict = isApiError(error) && error.status === 409
        if (isDefiniteRefusal(error) && !conflict) throw error
        // Still waiting: the answer never took, so the prompt comes back (as a refusal) for the user to answer again.
        // A conflict the server cannot confirm either way also brings it back; a second answer is refused if it is gone.
        const waiting = await options.waiting(variables).catch(() => { if (conflict) return true; throw error })
        if (waiting) throw new Error(error instanceof Error ? error.message : String(error))
        if (conflict) showErrorToast(error)
        return undefined
      }
    },
    onSuccess: (result, variables) => options.onAnswered?.(result, variables),
    onError: showErrorToast,
  })
  return { answer: mutate, answered: (resource: string) => !!effects[resource]?.remove }
}
