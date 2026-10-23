import type { QueryKey } from '@tanstack/react-query'
import { isApiError, isDefiniteRefusal } from '../../contracts/common'
import { showErrorToast } from '../toast/errorToast'
import { useResourceEffects, useResourceMutation } from '../sessions/useResourceMutation'

/**
 * Answers a prompt only the server clears: an approval, a clarification, a vault prompt, a pending steer. The prompt
 * leaves at once and a refusal brings it back with the error; a 409 means it is already gone. An unknown outcome asks
 * the server whether the prompt still waits before keeping or restoring it, and never sends the answer again.
 */
export function usePromptAnswer<V, R>(options: {
  resource: (variables: V) => string
  /** Reread when the outcome stays unknown (the owner's fallback when `waiting` cannot be read). */
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
        if (isApiError(error) && error.status === 409) { showErrorToast(error); return undefined }
        if (isDefiniteRefusal(error)) throw error
        // Still waiting: the answer never arrived, so the prompt comes back (as a refusal) for the user to answer again.
        if (await options.waiting(variables).catch(() => { throw error })) throw new Error(error instanceof Error ? error.message : String(error))
        return undefined
      }
    },
    onSuccess: (result, variables) => options.onAnswered?.(result, variables),
    onError: showErrorToast,
  })
  return { answer: mutate, answered: (resource: string) => !!effects[resource]?.remove }
}
