import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, RotateCcw, Upload } from 'lucide-react'
import type { AgentRestoreJob, AgentRestoreStatus } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { downloadFromApp } from '../../lib/appRoot'
import { StatusDot } from '../../ui/Badge'
import { ConfirmDialog } from '../../ui/Dialog'
import { RowContextMenu } from '../../ui/Menu'
import { RowActionButtons } from '../../ui/RowActionsMenu'
import { showErrorToast } from '../toast/errorToast'
import { SettingAction } from './SettingsRows'

const OUTCOME: Record<AgentRestoreJob['state'], () => string> = {
  staged: m.system_agent_restore_staged,
  running: m.system_agent_restore_running,
  restored: m.system_agent_restore_restored,
  invalid_archive: m.system_agent_restore_invalid,
  refused: m.system_agent_restore_refused,
  busy: m.system_agent_restore_busy,
  backup_failed: m.system_agent_restore_backup_failed,
  partial: m.system_agent_restore_partial,
  unknown: m.system_agent_restore_unknown,
  unavailable: m.system_agent_restore_unavailable,
}

export function AgentRestoreRow() {
  const qc = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const status = useQuery({
    queryKey: keys.agentRestore, queryFn: api.fetchAgentRestore,
    refetchInterval: (query) => {
      const data = query.state.data
      return data?.job?.state === 'running' || (data?.job?.state === 'unknown' && !data.can_upload) ? 1000 : false
    },
  })
  const set = (next: AgentRestoreStatus) => qc.setQueryData(keys.agentRestore, next)
  const reconcile = (error: unknown) => {
    showErrorToast(error)
    void status.refetch()
  }
  const upload = useMutation({
    mutationFn: api.uploadAgentRestore, onSuccess: (next) => {
      set(next)
      if (next.job?.can_confirm) setConfirmId(next.job.id)
    }, onError: reconcile,
  })
  const confirm = useMutation({ mutationFn: api.confirmAgentRestore, onSuccess: set, onError: reconcile })
  const data = status.data
  if (!data || (!data.available && !data.job)) return null

  const job = data.job
  const recovery = job?.recovery_url
  const actions = [
    ...(data.can_upload ? [{ label: m.system_agent_restore_upload(), icon: Upload, busy: upload.isPending, run: () => input.current?.click() }] : []),
    ...(job?.can_confirm ? [{ label: m.system_agent_restore_confirm_title(), icon: RotateCcw, busy: confirm.isPending, run: () => setConfirmId(job.id) }] : []),
    ...(recovery ? [{ label: m.system_agent_restore_recovery(), icon: Download, run: () => { downloadFromApp(recovery) } }] : []),
  ]
  return (
    <>
      <input type="file" accept=".zip,application/zip" hidden ref={input} onChange={(event) => {
        const file = event.currentTarget.files?.[0]
        event.currentTarget.value = ''
        if (file) upload.mutate(file)
      }} />
      <RowContextMenu label={m.system_agent_restore()} actions={actions} trigger={
        <div><SettingAction label={m.system_agent_restore()} icon={RotateCcw} detail={job && <StatusDot state={job.state === 'restored' ? 'ok' : 'idle'} wrap>{OUTCOME[job.state]()}</StatusDot>}>
          <RowActionButtons actions={actions} />
        </SettingAction></div>
      } />
      <ConfirmDialog open={!!job?.can_confirm && job.id === confirmId} onOpenChange={(open) => { if (!open) setConfirmId(null) }}
        title={m.system_agent_restore_confirm_title()} description={m.system_agent_restore_confirm_description({ file: job?.file_name ?? '', server: data.server, profile: data.profile })}
        confirmLabel={m.system_agent_restore_confirm_title()} cancelLabel={m.cancel()} danger onConfirm={() => { if (confirmId) confirm.mutate(confirmId) }} />
    </>
  )
}
