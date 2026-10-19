import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { removePersisted } from '../../lib/persisted'
import { closeMobileSidebar } from '../../shell/useShellState'
import type { ExecutionMode } from '@maudecode/talaria-web-contracts'
import { randomHex } from '../../lib/randomHex'

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

export async function createSessionNow(opts: { workspace?: string; model?: string; model_provider?: string | null; profile?: string; enabled_toolsets?: string[] | null; worktree?: boolean; execution_mode?: ExecutionMode; request_id?: string } = {}) {
  const diagnostic = opts.execution_mode !== undefined && opts.execution_mode !== 'normal'
  const { session } = await api.newSession({ ...(opts.workspace ? { workspace: opts.workspace } : {}), ...(opts.model ? { model: opts.model } : {}), ...(opts.model_provider !== undefined ? { model_provider: opts.model_provider } : {}), ...(opts.profile ? { profile: opts.profile } : {}), ...(opts.enabled_toolsets !== undefined ? { enabled_toolsets: opts.enabled_toolsets } : {}), worktree: opts.worktree ?? false, ...(diagnostic ? { execution_mode: opts.execution_mode, ...(opts.request_id ? { request_id: opts.request_id } : {}) } : {}) })
  return session
}

/**
 * TAL-1040: one creation identity per unsaved chat, like a turn's `submission_id`. A retry after a lost response reuses it so
 * the owner returns the chat it already created; a created chat or changed choices start a new one.
 */
export function useCreationId(choices: object) {
  const id = useRef<string | null>(null)
  useEffect(() => { id.current = null }, [choices])
  return useMemo(() => ({ next: () => (id.current ??= randomHex()), settle: () => { id.current = null } }), [])
}
