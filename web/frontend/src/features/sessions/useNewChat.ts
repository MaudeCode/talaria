import { useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { removePersisted } from '../../lib/persisted'
import { closeMobileSidebar } from '../../shell/useShellState'

/**
 * Start a new conversation: navigate to `/` with a fresh (unsaved) chat. The
 * server session is minted lazily on the first message, as the legacy app did
 * for reusable empty chats; an explicit new-chat action clears the restored id.
 */
export function useNewChat() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  return useCallback(async () => {
    removePersisted('hermes-webui-session')
    closeMobileSidebar()
    await navigate({ to: '/', search: {} })
    await qc.invalidateQueries({ queryKey: keys.sessions.all })
  }, [navigate, qc])
}

export async function createSessionNow(opts: { workspace?: string; model?: string; model_provider?: string | null; profile?: string; enabled_toolsets?: string[] | null } = {}) {
  const { session } = await api.newSession({ ...(opts.workspace ? { workspace: opts.workspace } : {}), ...(opts.model ? { model: opts.model } : {}), ...(opts.model_provider !== undefined ? { model_provider: opts.model_provider } : {}), ...(opts.profile ? { profile: opts.profile } : {}), ...(opts.enabled_toolsets !== undefined ? { enabled_toolsets: opts.enabled_toolsets } : {}), worktree: false })
  return session
}
