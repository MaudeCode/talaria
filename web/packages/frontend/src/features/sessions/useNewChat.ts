import { useEffect, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { removePersisted } from '../../lib/persisted'
import { closeMobileSidebar } from '../../shell/useShellState'
import type { ExecutionMode, SourceReference } from '@maudecode/talaria-web-contracts'
import { randomHex } from '../../lib/randomHex'

/**
 * Start a new conversation: navigate to `/` with a fresh (unsaved) chat. The
 * server session is minted lazily on the first message, as the legacy app did
 * for reusable empty chats; an explicit new-chat action clears the restored id.
 */
export function useNewChat() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  return async (project?: string) => {
    removePersisted('hermes-webui-session')
    closeMobileSidebar()
    await navigate({ to: '/', search: project ? { project } : {} })
    await qc.invalidateQueries({ queryKey: keys.sessions.all })
  }
}

export async function createSessionNow(opts: { source_references?: SourceReference[]; project_id?: string; workspace?: string; model?: string; model_provider?: string | null; profile?: string; enabled_toolsets?: string[] | null; worktree?: boolean; execution_mode?: ExecutionMode; request_id?: string } = {}) {
  const diagnostic = opts.execution_mode !== undefined && opts.execution_mode !== 'normal'
  const { session } = await api.newSession({ ...(opts.project_id ? { project_id: opts.project_id } : {}), ...(opts.workspace ? { workspace: opts.workspace } : {}), ...(opts.model ? { model: opts.model } : {}), ...(opts.model_provider !== undefined ? { model_provider: opts.model_provider } : {}), ...(opts.profile ? { profile: opts.profile } : {}), ...(opts.enabled_toolsets !== undefined ? { enabled_toolsets: opts.enabled_toolsets } : {}), worktree: opts.worktree ?? false, ...(opts.source_references?.length ? { source_references: opts.source_references.map(({ session_id, tip_session_id, profile }) => ({ session_id, tip_session_id, profile })) } : {}), ...(opts.source_references?.length && opts.request_id ? { request_id: opts.request_id } : {}), ...(diagnostic ? { execution_mode: opts.execution_mode, ...(opts.request_id ? { request_id: opts.request_id } : {}) } : {}) })
  return session
}

/**
 * TAL-1040: one creation identity per unsaved chat, like a turn's `submission_id`. A retry after a lost response reuses it so
 * the owner returns the chat it already created; a created chat or changed choices start a new one.
 */
export function useCreationId(choices: object) {
  const id = useRef<string | null>(null)
  useEffect(() => { id.current = null }, [choices])
  return ({ next: () => { const next = id.current ?? randomHex(); id.current = next; return next }, settle: () => { id.current = null } })
}
