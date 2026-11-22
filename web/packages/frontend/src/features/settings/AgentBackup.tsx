import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, Download, Trash2, X, type LucideIcon } from 'lucide-react'
import type { AgentBackupStatus } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { downloadFromApp } from '../../lib/appRoot'
import { useLocale } from '../../i18n/useLocale'
import { resetTime } from '../../i18n/units'
import { ConfirmDialog } from '../../ui/Dialog'
import { HelpTip } from '../../ui/Field'
import { StatusDot } from '../../ui/Badge'
import { formatBytes } from '../../ui/States'
import { RowContextMenu, type RowAction } from '../../ui/Menu'
import { RowActionButtons } from '../../ui/RowActionsMenu'
import { showErrorToast } from '../toast/errorToast'
import { SettingAction } from './SettingsRows'

/** The longest delay a browser timer keeps; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1

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
  // A running backup polls its progress; a ready one is read again when the server deletes it, so the start returns.
  const status = useQuery({ queryKey: keys.agentBackup, queryFn: () => api.fetchAgentBackup(), refetchInterval: (q) => {
    const job = q.state.data?.job
    if (job?.state === 'running') return 1000
    return job?.state === 'ready' && job.expires_at !== null ? Math.min(MAX_TIMER_MS, Math.max(1000, job.expires_at * 1000 - Date.now())) : false
  } })
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
  // One list for the row's buttons and its right-click and long-press menu.
  let actions: (RowAction & { icon: LucideIcon })[] = [{ label: m.system_agent_backup_start(), run: () => setConfirm(true), busy: create.isPending, icon: Archive }]
  let detail: ReactNode = null
  if (!data.available) {
    actions = []
  } else if (job?.state === 'running') {
    detail = <StatusDot state="changed">{job.phase === 'archiving' && job.total !== null ? m.system_agent_backup_progress({ completed: (job.completed ?? 0).toLocaleString(locale), total: job.total.toLocaleString(locale) }) : m.system_agent_backup_scanning()}</StatusDot>
    actions = [{ label: m.system_agent_backup_cancel(), run: () => discard.mutate(job.id), icon: X }]
  } else if (job?.state === 'ready' && job.download_url) {
    const size = formatBytes(job.size_bytes)
    const until = job.expires_at === null ? '' : resetTime(locale, job.expires_at * 1000)
    detail = job.complete ? <StatusDot state="ok">{m.system_agent_backup_ready({ size, until })}</StatusDot> : <StatusDot state="warning">{m.system_agent_backup_incomplete({ size, until })}</StatusDot>
    const url = job.download_url
    actions = [{ label: m.system_agent_backup_download(), run: () => { downloadFromApp(url) }, icon: Download }, { label: m.system_agent_backup_delete(), run: () => discard.mutate(job.id), danger: true, icon: Trash2 }]
  } else if (job?.state === 'failed') {
    detail = <StatusDot state="error" wrap>{job.error ?? m.system_agent_backup_failed()}</StatusDot>
  } else if (job?.state === 'cancelled') {
    detail = <StatusDot state="idle">{m.system_agent_backup_cancelled()}</StatusDot>
  }
  return (
    <>
      <RowContextMenu label={m.system_agent_backup()} actions={actions} trigger={<div data-agent-backup={job?.state ?? 'none'}><SettingAction label={m.system_agent_backup()} icon={Archive} detail={detail}>
        {data.unavailable_reason ? <HelpTip label={m.system_agent_backup_unavailable()}>{UNAVAILABLE[data.unavailable_reason]()}</HelpTip> : <RowActionButtons actions={actions} />}
      </SettingAction></div>} />
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={m.system_agent_backup_start()}
        description={m.system_agent_backup_confirm({ server: data.server, profile: data.profile, minutes: Math.round(data.retention_seconds / 60) })}
        confirmLabel={m.system_agent_backup_start()} cancelLabel={m.cancel()} onConfirm={() => create.mutate()} />
    </>
  )
}
