import { useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, CircleArrowUp, Download, Power, RefreshCw, Sparkles } from 'lucide-react'
import type { WebUpdateChannel } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useBootstrap } from '../../app/bootstrap'
import { Button, IconButton } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { Select } from '../../ui/Select'
import { ConfirmDialog, Dialog, DialogFooter } from '../../ui/Dialog'
import { ErrorState, LoadingState, formatDate } from '../../ui/States'
import { SectionHeader } from '../../ui/List'
import { StatusDot } from '../../ui/Badge'

import { showErrorToast } from '../toast/errorToast'
import { useSettingField } from './useSettingField'
import { SettingAction, SettingToggle, SettingsGroup, SETTINGS_PAGE } from './SettingsRows'
import type { z } from 'zod'
import type { UpdateApplySchema, UpdateTargetSchema, UpdateVersionSchema } from '../../contracts'
import { useUpdateProgress } from '../notifications/UpdateNotificationCenter'
import { GatewayRestart } from './GatewayRestart'
import { markServerStopped } from '../notices/useRuntimeNotices'

const CHANNEL_LABELS: Record<WebUpdateChannel, () => string> = { stable: m.settings_update_channel_stable, nightly: m.settings_update_channel_nightly, experimental: m.settings_update_channel_experimental }

export function SystemSection() {
  const bootstrap = useBootstrap()
  const qc = useQueryClient()
  const { settings, save, str, bool } = useSettingField(['update_channel', 'update_channels', 'agent_update_channel', 'ignore_agent_updates', 'webui_version', 'check_for_updates', 'auto_apply_updates', 'agent_version', 'summarize_updates_automatically'])
  const health = useQuery({ queryKey: keys.health.system, queryFn: api.fetchSystemHealth, staleTime: 30_000 })
  const agent = useQuery({ queryKey: keys.health.agent, queryFn: api.fetchAgentHealth, staleTime: 15_000 })
  const updates = useQuery({ queryKey: keys.updates.check, queryFn: () => api.fetchUpdatesCheck(), staleTime: 30_000, refetchInterval: 30_000 })
  const [confirmShutdown, setConfirmShutdown] = useState(false)
  const fail = (e: unknown) => showErrorToast(e)
  const shutdown = useMutation({ mutationFn: api.shutdownServer, onSuccess: () => markServerStopped(qc), onError: fail })
  // The chosen channel is held locally until its save settles; the cache only catches up on success,
  // and a later save (e.g. ignore-agent) must not make the Select snap back meanwhile.
  const [channelDraft, setChannelDraft] = useState<string>()
  const channel = channelDraft ?? str('update_channel', 'stable')
  const webChannels = (settings.data as { update_channels?: WebUpdateChannel[] } | undefined)?.update_channels ?? []
  const setChannel = (v: string) => { setChannelDraft(v); save.mutate({ update_channel: v }, { onError: fail, onSettled: () => { setChannelDraft(undefined); void qc.invalidateQueries({ queryKey: keys.updates.check }) } }) }
  const [agentChannelDraft, setAgentChannelDraft] = useState<string>()
  const agentChannel = agentChannelDraft ?? str('agent_update_channel', 'stable')
  const setAgentChannel = (v: string) => { setAgentChannelDraft(v); save.mutate({ agent_update_channel: v }, { onError: fail, onSettled: () => { setAgentChannelDraft(undefined); void qc.invalidateQueries({ queryKey: keys.updates.check }) } }) }
  const [agentConfirmation, setAgentConfirmation] = useState<{ result: z.infer<typeof UpdateApplySchema>; request: ApplyRequest } | null>(null)
  const acceptedAgentConfirmation = useRef(false)
  // TAL-1629: the server's one-shot Update anyway for a Web update blocked only by this server's running chats.
  const [webInterrupt, setWebInterrupt] = useState<{ token: string; runs: number; request: ApplyRequest } | null>(null)
  // The server reads persisted settings (channel, ignore-agent) for the forced check, so let every
  // in-flight settings save settle first; the cache then holds whatever actually persisted.
  const settledChannel = () => { const v = qc.getQueryData<Record<string, unknown>>(keys.settings)?.update_channel; return typeof v === 'string' ? v : undefined }
  const settledAgentChannel = (): 'stable' | 'experimental' => qc.getQueryData<Record<string, unknown>>(keys.settings)?.agent_update_channel === 'experimental' ? 'experimental' : 'stable'
  const waitForSettings = async () => { while (qc.isMutating({ mutationKey: keys.settings })) await new Promise((r) => setTimeout(r, 50)) }
  const checkNow = useMutation({
    mutationFn: async () => {
      await waitForSettings()
      return api.checkUpdatesNow(settledChannel(), settledAgentChannel())
    },
    onSuccess: (d) => qc.setQueryData(keys.updates.check, d),
    onError: fail,
  })
  // The Updating dialog reports each apply; one mutation per target keeps the other target's action available.
  const progress = useUpdateProgress()
  // `version` names a listed Stable release (TAL-946); without it the server installs the newest.
  const applyTarget = (target: 'webui' | 'agent') => ({
    mutationFn: async (request: ApplyRequest) => {
      await waitForSettings()
      const version = request.version ? { version: request.version } : {}
      return target === 'webui' ? api.applyUpdates('apply', settledChannel() ?? channel, 'webui', { ...version, ...(request.interruptToken ? { interrupt_token: request.interruptToken } : {}) })
        : api.applyUpdates('apply', undefined, 'agent', { agent_channel: request.agentChannel ?? settledAgentChannel(), ...(request.confirmedRevision ? { confirmed_agent_revision: request.confirmedRevision } : {}), ...(request.refreshToken ? { agent_refresh_token: request.refreshToken } : {}), ...version })
    },
    onMutate: () => { progress?.begin(target) },
    onSuccess: (r: z.infer<typeof UpdateApplySchema>, request: ApplyRequest) => {
      if (r.confirmation_required && r.candidate_revision && r.agent_channel) {
        progress?.dismiss()
        acceptedAgentConfirmation.current = false
        setAgentConfirmation({ result: r, request: { ...request, agentChannel: r.agent_channel } })
      } else if (target === 'webui' && r.interrupt_confirmation) {
        progress?.dismiss()
        setWebInterrupt({ token: r.interrupt_confirmation.token, runs: r.interrupt_confirmation.runs, request })
      } else progress?.settle(target, r)
      void qc.invalidateQueries({ queryKey: keys.updates.check })
      void qc.invalidateQueries({ queryKey: keys.updateNotifications })
    },
    onError: (error: unknown) => { progress?.settle(target, { failure: error }); void qc.invalidateQueries({ queryKey: keys.updateNotifications }) },
  })
  const applyWeb = useMutation(applyTarget('webui'))
  const applyAgent = useMutation(applyTarget('agent'))
  /** One version's Install button; the one being applied is busy. */
  const install = (apply: typeof applyWeb) => (v: UpdateVersion) => (
    <IconButton variant="default" label={m.system_install_version({ version: v.version })} onClick={() => apply.mutate({ version: v.ref })} disabled={apply.isPending} aria-busy={(apply.isPending && apply.variables.version === v.ref) || undefined}><Download aria-hidden="true" /></IconButton>
  )
  if (settings.isPending) return <LoadingState />
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => { void settings.refetch() }} />
  const canManage = bootstrap.auth.can_manage_server
  const webUpdate = updates.data?.webui
  const agentUpdate = updates.data?.agent
  // One failed poll is a transport blip, not a failed check: keep rendering the last server payload
  // while it still answers the selected channels.
  const cachedCurrent = updates.data !== undefined && (updates.data.channel ?? channel) === channel && (updates.data.agent_channel ?? agentChannel) === agentChannel
  const webStatus = pathStatus(webUpdate, WEB, { failed: updates.isError && !cachedCurrent, pending: updates.isPending })
  const agentStatus = pathStatus(agentUpdate, AGENT, { failed: updates.isError && !cachedCurrent, pending: updates.isPending })
  const recheck = () => { void qc.invalidateQueries({ queryKey: keys.updates.check }) }
  return (
    <div className={SETTINGS_PAGE} data-section="system">
      <SettingsGroup id="updates" title={m.system_updates()} hint={m.system_updates_intro()}
        action={<IconButton variant="ghost" label={checkNow.isPending ? m.settings_checking() : bool('ignore_agent_updates') ? m.system_check_web() : m.system_check_both()} onClick={() => checkNow.mutate()} disabled={checkNow.isPending}><RefreshCw aria-hidden="true" /></IconButton>}>
        <div className="grid gap-x-10 gap-y-8 py-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,19rem),1fr))]">
          <UpdatePath id="systemWebPath" title={WEB} installed={webUpdate?.current_version ?? str('webui_version', bootstrap.webui_version)} status={webStatus}
            channel={<Select id="settingsUpdateChannel" aria-label={m.settings_label_web_update_channel()} disabled={!canManage} value={channel} onValueChange={setChannel}>
              {webChannels.map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]()}</option>)}
            </Select>}
            action={canManage && webUpdate?.can_apply ? <IconButton variant="default" label={applyWeb.isPending && !applyWeb.variables.version ? m.update_updating() : webUpdate.state === 'finish' ? m.system_finish_update() : m.system_apply_web_update()} onClick={() => applyWeb.mutate({})} disabled={applyWeb.isPending}><CircleArrowUp aria-hidden="true" /></IconButton> : null}
            folded={canManage ? webUpdate?.versions.filter((v) => v.folded) : undefined} install={install(applyWeb)}
            manualLink={webUpdate?.manual_link === true}
            summary={webUpdate?.summary_available ? <UpdateSummary target="webui" name={WEB} info={webUpdate} /> : null}>
            <SettingToggle label={m.settings_label_auto_apply_updates()} hint={m.system_auto_apply_hint()} id="settingsAutoApplyUpdates" settingKey="auto_apply_updates" disabled={!canManage || !bool('check_for_updates', true)} />
          </UpdatePath>
          <UpdatePath id="systemAgentPath" title={AGENT} installed={agentUpdate?.current_version ?? str('agent_version', '—')} status={agentStatus}
            channel={<Select id="settingsAgentUpdateChannel" aria-label={m.settings_label_agent_update_channel()} disabled={!canManage} value={agentChannel} onValueChange={setAgentChannel}>
              <option value="stable">{m.settings_update_channel_stable()}</option>
              <option value="experimental">{m.settings_update_channel_experimental()}</option>
            </Select>}
            action={canManage && agentUpdate?.can_apply ? <IconButton variant="default" label={applyAgent.isPending && !applyAgent.variables.version ? m.update_updating() : m.system_apply_agent_update()} onClick={() => applyAgent.mutate({})} disabled={applyAgent.isPending}><CircleArrowUp aria-hidden="true" /></IconButton> : null}
            folded={canManage ? agentUpdate?.versions.filter((v) => v.folded) : undefined} install={install(applyAgent)}
            /* Before TAL-946 the server sent no `support_label`; `unsupported` answers only for one that predates `support` (TAL-350). */
            support={agentUpdate?.can_apply ? agentSupport(agentUpdate) : null}
            installedNote={agentUpdate?.current_support === 'unchecked' ? m.system_agent_installed_unchecked() : null}
            summary={agentUpdate?.summary_available ? <UpdateSummary target="agent" name={AGENT} info={agentUpdate} /> : null}>
            <SettingToggle label={m.settings_label_ignore_agent_updates()} hint={m.system_agent_manual_hint()} id="settingsIgnoreAgentUpdates" settingKey="ignore_agent_updates" onSaved={recheck} />
          </UpdatePath>
        </div>
        <SettingToggle label={m.settings_label_summarize_updates_automatically()} id="settingsSummarizeUpdatesAutomatically" settingKey="summarize_updates_automatically" fallback disabled={!canManage || !bool('check_for_updates', true)} />
        <SettingToggle label={m.settings_label_check_updates()} hint={m.system_check_updates_hint()} id="settingsCheckUpdates" settingKey="check_for_updates" fallback disabled={!canManage} />
      </SettingsGroup>
      <SettingsGroup id="health" title={m.settings_group_health()}>
        <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-2 py-2 text-sm">
          <dt className="text-muted">{WEB}</dt>
          <dd className="text-text">{health.data?.status ?? '—'}{health.data?.disk?.percent !== undefined ? <span className="text-muted">{', '}{m.system_disk_used({ n: health.data.disk.percent.toFixed(0) })}</span> : null}</dd>
          <dd className="text-xs text-muted">{health.data?.checked_at ? formatDate(health.data.checked_at) : null}</dd>
          <dt className="text-muted">{AGENT}</dt>
          <dd className="text-text">{agent.data?.alive === true ? 'ok' : agent.data?.alive === false ? (agent.data.details?.reason ?? 'down') : agent.data?.details?.state ?? '—'}</dd>
          <dd>{canManage && <GatewayRestart />}</dd>
        </dl>
      </SettingsGroup>
      {canManage && (
        <SettingsGroup id="server" title={m.settings_group_server()}>
          <SettingAction label={m.system_shutdown()} hint={m.system_shutdown_hint()}><IconButton variant="danger" label={m.system_shutdown()} onClick={() => setConfirmShutdown(true)}><Power aria-hidden="true" /></IconButton></SettingAction>
        </SettingsGroup>
      )}
      <ConfirmDialog open={confirmShutdown} onOpenChange={setConfirmShutdown} title={m.system_shutdown()} description={m.system_shutdown_confirm()} confirmLabel={m.system_shutdown()} cancelLabel={m.cancel()} danger onConfirm={() => shutdown.mutate()} />
      {/* Cancel sends nothing; the confirmation is sent once, with the same update. */}
      <ConfirmDialog open={webInterrupt !== null} onOpenChange={(open) => { if (!open) setWebInterrupt(null) }} title={m.system_web_interrupt_title()} description={webInterrupt ? m.system_web_interrupt_warning({ n: webInterrupt.runs }) : ''} confirmLabel={m.system_agent_update_anyway()} cancelLabel={m.cancel()} danger onConfirm={() => { if (webInterrupt) applyWeb.mutate({ ...webInterrupt.request, interruptToken: webInterrupt.token }) }} />
      <ConfirmDialog open={agentConfirmation !== null} onOpenChange={(open) => { if (!open && agentConfirmation) { const pending = agentConfirmation; setAgentConfirmation(null); if (acceptedAgentConfirmation.current) { acceptedAgentConfirmation.current = false; return } if (pending.result.notification_id) void api.cancelUpdateNotification(pending.result.notification_id).catch(fail).finally(() => { void qc.invalidateQueries({ queryKey: keys.updateNotifications }) }) } }} title={agentConfirmation?.result.refresh_confirmation ? m.system_agent_refresh_title() : m.system_agent_unsupported_title()} description={agentConfirmation ? agentConfirmation.result.refresh_confirmation ? m.system_agent_refresh_warning({ services: agentConfirmation.result.refresh_confirmation.services.join(', '), revision: agentConfirmation.result.candidate_revision?.slice(0, 12) ?? '' }) : `${m.system_agent_unsupported_warning()} ${m.system_agent_unsupported_identity({ version: agentConfirmation.result.supported_version ?? '—', supported: (agentConfirmation.result.supported_revision ?? '—').slice(0, 12), candidate: (agentConfirmation.result.candidate_revision ?? '').slice(0, 12) })}` : ''} confirmLabel={agentConfirmation?.result.refresh_confirmation ? m.system_agent_refresh_confirm() : m.system_agent_update_anyway()} cancelLabel={m.cancel()} danger onConfirm={() => { if (agentConfirmation) { const pending = agentConfirmation; acceptedAgentConfirmation.current = true; setAgentConfirmation(null); applyAgent.mutate({ ...pending.request, ...(pending.result.refresh_confirmation ? { refreshToken: pending.result.refresh_confirmation.token } : pending.result.candidate_revision ? { confirmedRevision: pending.result.candidate_revision } : {}) }) } }} />
    </div>
  )
}

const WEB = 'Talaria Web'
const AGENT = 'Hermes Agent'
type Target = z.infer<typeof UpdateTargetSchema>
type UpdateVersion = z.infer<typeof UpdateVersionSchema>
interface ApplyRequest { refreshToken?: string; version?: string; confirmedRevision?: string; agentChannel?: 'stable' | 'experimental'; interruptToken?: string }
type Tone = 'update' | 'ok' | 'warn' | 'quiet'
interface Support { label: string; unchecked: boolean }

/** The newest Agent target's one-line support status. */
function agentSupport(t: Target): Support | null {
  const unchecked = (t.support ?? (t.unsupported === true ? 'unchecked' : 'supported')) === 'unchecked'
  const label = t.support_label ?? (unchecked ? m.system_agent_unsupported_warning() : null)
  return label ? { label, unchecked } : null
}
const versionSupport = (v: UpdateVersion): Support | null => (v.support_label ? { label: v.support_label, unchecked: v.support === 'unchecked' } : null)
interface PathStatus { tone: Tone; text: string; target?: string | undefined; detail?: string | undefined }

/** One component's update state in the words its channel uses: Stable names releases, Experimental counts commits. */
function pathStatus(t: Target | null | undefined, name: string, { failed, pending }: { failed: boolean; pending: boolean }): PathStatus {
  if (pending && !t) return { tone: 'quiet', text: m.system_checking_named({ name }) }
  if (failed) return { tone: 'warn', text: m.system_check_failed_named({ name }), detail: t?.error }
  if (!t) return { tone: 'quiet', text: m.system_status_unknown_named({ name }) }
  const target = t.target_version ?? undefined
  const detail = typeof t.message === 'string' ? t.message : undefined
  switch (t.state) {
    case 'off': return { tone: 'quiet', text: m.system_checks_off({ name }) }
    case 'check_failed': return { tone: 'warn', text: m.system_check_failed_named({ name }), detail: t.error }
    case 'local_changes': return { tone: 'warn', text: m.system_local_changes_named({ name }), detail }
    case 'finish': return { tone: 'update', text: m.system_finish_named({ name }), target, detail }
    case 'manual': return { tone: 'warn', text: m.system_manual_named({ name }), target, detail }
    case 'release_ready': return { tone: 'update', text: m.system_release_ready({ name }), target, detail: t.installed_unverified ? m.system_installed_unverified() : undefined }
    case 'commits_behind': return { tone: 'update', text: m.system_commits_behind({ name, n: t.behind ?? 0 }) }
    case 'up_to_date': return { tone: 'ok', text: m.system_up_to_date_named({ name }) }
    case 'unknown': return { tone: 'quiet', text: m.system_status_unknown_named({ name }) }
  }
}

/** "Summarize with AI" and its dialog: the server's summary of this target's pending update, requested only once the dialog opens. */
function UpdateSummary({ target, name, info }: { target: 'webui' | 'agent'; name: string; info: Target }) {
  const [open, setOpen] = useState(false)
  const summary = useQuery({ queryKey: [...keys.updates.summary, target, info.current_sha, info.latest_sha, info.target_version, info.behind], queryFn: () => api.fetchUpdatesSummary(target), enabled: open, staleTime: Infinity, retry: false })
  return (
    <>
      <IconButton variant="default" label={m.system_summarize_with_ai()} onClick={() => setOpen(true)}><Sparkles aria-hidden="true" /></IconButton>
      <Dialog open={open} onOpenChange={setOpen} title={m.system_summary_title({ name })} description={summary.data?.current_version && summary.data.target_version ? `${summary.data.current_version} → ${summary.data.target_version}` : undefined} maxWidth={600}>
        <div className="max-h-[60vh] overflow-y-auto text-sm">
          {summary.isPending ? <p role="status" className="text-muted">{m.system_whats_new_loading()}</p>
            : summary.isError ? (
              <div className="flex flex-wrap items-center gap-3"><p role="alert" className="text-muted">{m.system_whats_new_failed()}</p><IconButton variant="default" label={m.retry()} onClick={() => { void summary.refetch() }}><RefreshCw aria-hidden="true" /></IconButton></div>
            ) : (
              <div className="flex flex-col gap-4">
                {summary.data.summary_sections.map((section) => (
                  <section key={section.title}>
                    <SectionHeader>{section.title}</SectionHeader>
                    <ul className="mt-1 list-disc pl-5 text-muted">{section.items.map((item) => <li key={item}>{item}</li>)}</ul>
                  </section>
                ))}
              </div>
            )}
        </div>
        <DialogFooter className="mt-4"><Button onClick={() => setOpen(false)}>{m.close()}</Button></DialogFooter>
      </Dialog>
    </>
  )
}

// A node is a ring (inset, so it keeps its 11px), filled when it marks a version that is or will be installed.
const NODE: Record<Tone | 'installed', string> = {
  installed: 'ring-text bg-text',
  update: 'ring-accent bg-accent',
  ok: 'ring-success bg-success',
  warn: 'ring-warning bg-bg',
  quiet: 'ring-border2 bg-bg',
}

function PathNode({ tone, children }: { tone: Tone | 'installed'; children: ReactNode }) {
  return (
    <li className="relative pb-4 last:pb-0">
      <span aria-hidden="true" className={cn('absolute top-[5px] -left-[22px] size-[11px] rounded-full ring-2 ring-inset', NODE[tone])} />
      {children}
    </li>
  )
}

function SupportLine({ support }: { support: Support | null }) {
  return support ? <p className="mt-0.5 flex min-w-0 text-xs text-muted">{support.unchecked ? <StatusDot state="warning" title={support.label}>{support.label}</StatusDot> : support.label}</p> : null
}

/**
 * A component's update path: installed version, then where its channel leads, with its own controls underneath.
 * Older installable releases (TAL-946) fold into one node between them; opening it is this device's choice.
 */
function UpdatePath({ id, title, installed, installedNote, status, channel, action, folded = [], install, support, manualLink, summary, children }: {
  id: string; title: string; installed: string; installedNote?: string | null; status: PathStatus; channel: ReactNode; action: ReactNode
  folded?: UpdateVersion[] | undefined; install: (version: UpdateVersion) => ReactNode; support?: Support | null; manualLink?: unknown; summary?: ReactNode; children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const next = status.tone !== 'ok'
  return (
    <section aria-labelledby={`${id}Heading`} data-update-path={id} className="row-span-3 grid min-w-0 grid-rows-subgrid gap-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={`${id}Heading`} className="text-sm font-semibold text-text">{title}</span>
        {channel}
      </div>
      <ol className={cn('ml-[5px] self-start border-l pl-4', next && status.tone === 'update' ? 'border-accent' : 'border-border')}>
        <PathNode tone={next ? 'installed' : 'ok'}>
          <div className="text-xs text-muted">{m.system_path_installed()}</div>
          <div className="font-mono text-sm text-text break-all">{installed}</div>
          {installedNote ? <p className="mt-1 flex min-w-0"><StatusDot state="warning" title={installedNote}>{installedNote}</StatusDot></p> : null}
          {!next ? <p role="status" className="mt-1 text-xs text-muted">{status.text}</p> : null}
        </PathNode>
        {next && folded.length ? (
          <PathNode tone="quiet">
            <div className="-my-2 flex items-center gap-1 text-xs text-muted">
              <span>{m.system_more_versions({ n: folded.length })}</span>
              <IconButton variant="ghost" label={m.system_more_versions({ n: folded.length })} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</IconButton>
            </div>

          </PathNode>
        ) : null}
        {/* Oldest first, so the path reads down toward the newest release. */}
        {next && open ? [...folded].reverse().map((v) => (
          <PathNode key={v.ref} tone="quiet">
            <div className="font-mono text-sm text-text break-all">{v.version}</div>
            <SupportLine support={versionSupport(v)} />
            <div className="mt-2">{install(v)}</div>
          </PathNode>
        )) : null}
        {next ? (
          <PathNode tone={status.tone}>
            {status.target ? <div className="font-mono text-sm text-text break-all">{status.target}</div> : null}
            <p role="status" className={cn('text-xs', status.tone === 'update' ? 'text-accent-text' : status.tone === 'warn' ? 'text-warning' : 'text-muted')}>{status.text}</p>
            {status.detail ? <p className="mt-0.5 text-xs text-muted">{status.detail}</p> : null}
            {manualLink ? <a className="inline-flex min-h-11 items-center text-xs text-accent-text underline" href="https://github.com/MaudeCode/talaria/releases" target="_blank" rel="noreferrer">{m.system_manual_updates()}</a> : null}
            <SupportLine support={support ?? null} />
            {action || summary ? <div className="mt-2 flex flex-wrap items-center gap-2">{action}{summary}</div> : null}
          </PathNode>
        ) : null}
      </ol>
      <div className="self-end border-t border-border-subtle">{children}</div>
    </section>
  )
}
