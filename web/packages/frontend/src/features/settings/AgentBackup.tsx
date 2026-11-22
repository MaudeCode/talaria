import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, Download, Trash2, X } from 'lucide-react'
import type { AgentBackupStatus } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { appUrl } from '../../lib/appRoot'
import { useLocale } from '../../i18n/useLocale'
import { resetTime } from '../../i18n/units'
import { IconButton, iconButtonClass } from '../../ui/Button'
import { ConfirmDialog } from '../../ui/Dialog'
import { HelpTip } from '../../ui/Field'
import { StatusDot } from '../../ui/Badge'
import { formatBytes } from '../../ui/States'
import { Tooltip } from '../../ui/Tooltip'
import { showErrorToast } from '../toast/errorToast'
import { SettingAction } from './SettingsRows'

const UNAVAILABLE: Record<NonNullable<AgentBackupStatus['unavailable_reason']>, () => string> = {
  named_profile: m.system_agent_backup_root_only, isolated_profile: m.system_agent_backup_isolated, agent_unavailable: m.system_agent_backup_no_agent,
}

/**
 * TAL-2661: the owner's full native Agent-home backup in System › Server: start it after naming the server and profile it
 * covers, follow the server's progress, then download or delete the archive. A start runs a job, so only its control is
 * busy; a cancel or delete shows at once and converges on the server's answer.
 */
export function AgentBackupRow() {
  const qc = useQueryClient()
  const locale = useLocale()
  const status = useQuery({ queryKey: keys.agentBackup, queryFn: () => api.fetchAgentBackup(), refetchInterval: (q) => (q.state.data?.job?.state === 'running' ? 1000 : false) })
  const [confirm, setConfirm] = useState(false)
  const set = (next: AgentBackupStatus) => { qc.setQueryData(keys.agentBackup, next) }
  // An unknown outcome reads the server's state before keeping or rolling back.
  const reconcile = (error: unknown, previous?: AgentBackupStatus) => {
    showErrorToast(error)
    void status.refetch().then((r) => { if (r.isError && previous) set(previous) })
  }
  const create = useMutation({ mutationFn: () => api.createAgentBackup(), onSuccess: set, onError: (error) => { reconcile(error) } })
  const discard = useMutation({
    mutationFn: (id: string) => api.discardAgentBackup(id),
    onMutate: () => {
      const previous = status.data
      if (previous?.job) set({ ...previous, job: previous.job.state === 'running' ? { ...previous.job, state: 'cancelled', phase: null } : null })
      return previous
    },
    onSuccess: set,
    onError: (error, _id, previous) => { reconcile(error, previous) },
  })
  const data = status.data
  if (!data) return null
  const job = data.job
  const start = <IconButton variant="default" label={m.system_agent_backup_start()} onClick={() => setConfirm(true)} disabled={create.isPending} aria-busy={create.isPending || undefined}><Archive aria-hidden="true" /></IconButton>
  let detail: ReactNode = null
  let actions: ReactNode = start
  if (!data.available && data.unavailable_reason) {
    actions = <HelpTip label={m.system_agent_backup_unavailable()}>{UNAVAILABLE[data.unavailable_reason]()}</HelpTip>
  } else if (job?.state === 'running') {
    detail = <StatusDot state="changed">{job.phase === 'archiving' && job.total !== null ? m.system_agent_backup_progress({ completed: (job.completed ?? 0).toLocaleString(locale), total: job.total.toLocaleString(locale) }) : m.system_agent_backup_scanning()}</StatusDot>
    actions = <IconButton variant="default" label={m.system_agent_backup_cancel()} onClick={() => discard.mutate(job.id)}><X aria-hidden="true" /></IconButton>
  } else if (job?.state === 'ready' && job.download_url) {
    const size = formatBytes(job.size_bytes)
    const until = job.expires_at === null ? '' : resetTime(locale, job.expires_at * 1000)
    detail = job.complete ? <StatusDot state="ok">{m.system_agent_backup_ready({ size, until })}</StatusDot> : <StatusDot state="warning">{m.system_agent_backup_incomplete({ size, until })}</StatusDot>
    actions = (
      <>
        <Tooltip label={m.system_agent_backup_download()} side="top"><a href={appUrl(job.download_url).href} download={job.file_name ?? undefined} aria-label={m.system_agent_backup_download()} className={iconButtonClass('default')}><Download aria-hidden="true" /></a></Tooltip>
        <IconButton variant="danger" label={m.system_agent_backup_delete()} onClick={() => discard.mutate(job.id)}><Trash2 aria-hidden="true" /></IconButton>
      </>
    )
  } else if (job?.state === 'failed') {
    detail = <StatusDot state="error" wrap>{job.error ?? m.system_agent_backup_failed()}</StatusDot>
  } else if (job?.state === 'cancelled') {
    detail = <StatusDot state="idle">{m.system_agent_backup_cancelled()}</StatusDot>
  }
  return (
    <>
      <SettingAction label={m.system_agent_backup()} icon={Archive} detail={detail}><div className="flex items-center gap-2" data-agent-backup={job?.state ?? 'none'}>{actions}</div></SettingAction>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={m.system_agent_backup_start()}
        description={m.system_agent_backup_confirm({ server: data.server, profile: data.profile, minutes: Math.round(data.retention_seconds / 60) })}
        confirmLabel={m.system_agent_backup_start()} cancelLabel={m.cancel()} onConfirm={() => create.mutate()} />
    </>
  )
}
