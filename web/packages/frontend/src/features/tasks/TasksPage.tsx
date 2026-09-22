/**
 * Tasks workbench: the sidebar lists scheduled jobs, the main view shows the
 * selected job (or the create/edit form). Selection lives in `?job=` so a task
 * can be linked and the browser back button works; the editor is transient.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Copy, Pause, Play, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import type { CronJob } from '../../contracts'
import { AppShell, HubPage } from '../../shell/AppShell'
import { PanelHead, PanelHeadButton } from '../../shell/Sidebar'
import { closeMobileSidebar, openMobileSidebar, useIsDesktop, useMediaQuery } from '../../shell/useShellState'
import { useLocale } from '../../i18n/useLocale'
import { Button } from '../../ui/Button'
import { RightPanel } from '../../shell/RightPanel'
import { ConfirmDialog } from '../../ui/Dialog'
import { EmptyState, ErrorState, LoadingState, formatBytes, formatDate } from '../../ui/States'
import { showToast } from '../toast/toast'
import { cn } from '../../ui/cn'
import { contextFromList, cronDiagnostics, cronState, jobId, lastRunAt, needsAttention, nextRunAt, runResponse, runningIds, scheduleText, usageStrip, type CronState } from './cronJob'
import { Markdown } from '../chat/render/Markdown'
import { JobForm, type EditorMode } from './JobForm'

type CronAction = Parameters<typeof api.cronAction>[0]
interface Editor { mode: EditorMode; job: CronJob | null }

export function statusLabel(state: CronState): { label: string; tone: string } {
  switch (state) {
    case 'running': return { label: m.cron_status_running(), tone: 'text-accent-text' }
    case 'needs_attention': case 'schedule_error': return { label: m.cron_status_needs_attention(), tone: 'text-warning' }
    case 'paused': return { label: m.cron_status_paused(), tone: 'text-muted' }
    case 'off': return { label: m.cron_status_off(), tone: 'text-muted' }
    case 'error': return { label: m.cron_status_error(), tone: 'text-error' }
    default: return { label: m.cron_status_active(), tone: 'text-success' }
  }
}

export function TasksRoute() {
  useLocale()
  const { job } = useSearch({ from: '/_app/tasks' })
  const navigate = useNavigate()
  const isDesktop = useIsDesktop()
  // On a phone the list is a drawer; landing here without a task means the user wants the list.
  useEffect(() => { if (!isDesktop && !job) openMobileSidebar() }, [isDesktop, job])
  const { sidebar, main } = useTasksWorkbench(job ?? null, (id) => { void navigate({ to: '/tasks', search: id ? { job: id } : {} }) })
  return <AppShell sidebar={sidebar} showing="tasks">{main}</AppShell>
}

/** Both panes over one query set; `selectedId` is owned by the caller (the URL in the app, state in tests). */
export function useTasksWorkbench(selectedId: string | null, onSelect: (id: string | null) => void): { sidebar: ReactNode; main: ReactNode } {
  const qc = useQueryClient()
  const [allProfiles, setAllProfiles] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<CronJob | null>(null)
  // The list polls because it carries `last_run_at`, the only completion signal that covers scheduled runs
  // (the status map below only tracks runs started from the UI).
  const crons = useQuery({ queryKey: keys.crons.list(allProfiles), queryFn: () => api.fetchCrons(allProfiles), staleTime: 15_000, refetchInterval: 30_000 })
  const status = useQuery({ queryKey: keys.crons.status, queryFn: api.fetchCronStatus, refetchInterval: 10_000, staleTime: 5_000 })
  const invalidate = () => qc.invalidateQueries({ queryKey: keys.crons.all })
  const action = useMutation({
    mutationFn: ({ action, body }: { action: CronAction; body: Record<string, unknown> }) => api.cronAction(action, body),
    onSuccess: (res, vars) => {
      if (res.error) showToast(res.error, 4000, 'error')
      else showToast(vars.action === 'run' ? m.cron_job_triggered() : vars.action === 'pause' ? m.cron_job_paused() : vars.action === 'resume' ? m.cron_job_resumed() : vars.action === 'delete' ? m.cron_job_deleted() : m.saved())
      void invalidate()
    },
    onError: (e) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error'),
  })
  const jobs = useMemo(() => crons.data?.jobs ?? [], [crons.data])
  const running = useMemo(() => runningIds(status.data), [status.data])
  // A run that just finished has written its output file and updated last_run/last_status:
  // the mutation's invalidation fired when /run started, so refetch again when the running set shrinks.
  const wasRunning = useRef(running)
  useEffect(() => {
    const finished = [...wasRunning.current].some((id) => !running.has(id))
    wasRunning.current = running
    if (finished) void qc.invalidateQueries({ queryKey: keys.crons.all })
  }, [running, qc])
  const selected = selectedId ? jobs.find((j) => jobId(j) === selectedId) ?? null : null
  // A new last_run_at on the selected job means a run wrote its output: refetch that job's history.
  const lastRun = selected ? lastRunAt(selected) : null
  const seenRun = useRef({ id: selectedId, lastRun })
  useEffect(() => {
    const changed = seenRun.current.id === selectedId && seenRun.current.lastRun !== lastRun
    seenRun.current = { id: selectedId, lastRun }
    if (changed && selectedId) void qc.invalidateQueries({ queryKey: keys.crons.history(selectedId) })
  }, [selectedId, lastRun, qc])
  const run = (act: CronAction, job: CronJob) => action.mutate({ action: act, body: { job_id: jobId(job) } })
  const select = (id: string | null) => { setEditor(null); onSelect(id); closeMobileSidebar() }
  const startEditor = (mode: EditorMode, job: CronJob | null) => { setEditor({ mode, job }); closeMobileSidebar() }

  const sidebar = (
    <TaskListPanel
      jobs={jobs}
      pending={crons.isPending}
      error={crons.isError ? crons.error : null}
      otherProfileCount={crons.data?.other_profile_count ?? 0}
      allProfiles={allProfiles}
      running={running}
      selectedId={editor ? null : selectedId}
      onSelect={select}
      onNew={() => startEditor('create', null)}
      onRefresh={() => { void crons.refetch() }}
      onToggleAllProfiles={() => setAllProfiles((v) => !v)}
    />
  )

  let main: ReactNode
  if (editor) {
    main = (
      <JobForm
        mode={editor.mode}
        job={editor.job}
        jobs={jobs}
        onCancel={() => setEditor(null)}
        onSaved={(id) => { setEditor(null); void invalidate(); if (id) onSelect(id) }}
      />
    )
  } else if (crons.isPending) {
    main = <HubPage title={m.tab_tasks()}><LoadingState /></HubPage>
  } else if (crons.isError) {
    main = <HubPage title={m.tab_tasks()}><ErrorState error={crons.error} onRetry={() => { void crons.refetch() }} /></HubPage>
  } else if (!selected) {
    main = <TasksEmpty missing={!!selectedId} unavailable={!!crons.data.cron_unavailable} onNew={() => startEditor('create', null)} />
  } else {
    main = (
      <TaskDetail
        job={selected}
        jobs={jobs}
        state={cronState(selected, running.has(jobId(selected)))}
        onAction={(act) => run(act, selected)}
        onEdit={() => startEditor('edit', selected)}
        onDuplicate={() => startEditor('duplicate', selected)}
        onDelete={() => setConfirmDelete(selected)}
      />
    )
  }
  main = (
    <>
      {main}
      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(o) => { if (!o) setConfirmDelete(null) }}
        title={m.cron_delete_confirm_title()}
        description={confirmDelete?.name ?? ''}
        confirmLabel={m.delete()}
        cancelLabel={m.cancel()}
        danger
        onConfirm={() => { if (confirmDelete) { run('delete', confirmDelete); if (selectedId === jobId(confirmDelete)) onSelect(null) } }}
      />
    </>
  )
  return { sidebar, main }
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

function TaskListPanel({ jobs, pending, error, otherProfileCount, allProfiles, running, selectedId, onSelect, onNew, onRefresh, onToggleAllProfiles }: {
  jobs: CronJob[]; pending: boolean; error: unknown; otherProfileCount: number; allProfiles: boolean; running: Set<string>
  selectedId: string | null; onSelect: (id: string) => void; onNew: () => void; onRefresh: () => void; onToggleAllProfiles: () => void
}) {
  const rows = jobs.map((job) => ({ job, id: jobId(job), state: cronState(job, running.has(jobId(job))) }))
  // Paused jobs are folded away so they do not drown the live ones (legacy #4026).
  const live = rows.filter((r) => r.state !== 'paused' && r.state !== 'off')
  const parked = rows.filter((r) => r.state === 'paused' || r.state === 'off')
  const item = ({ job, id, state }: typeof rows[number]) => {
    const st = statusLabel(state)
    const active = id === selectedId
    return (
      <button
        key={id}
        type="button"
        onClick={() => onSelect(id)}
        aria-current={active ? 'page' : undefined}
        data-job-id={id}
        data-state={state}
        className={cn('side-menu-item flex w-full flex-col gap-0.5 rounded-(--r-sm) border-0 bg-transparent px-2.5 py-[7px] text-left text-text hover:bg-hover [&.active]:bg-(--menu-active-bg) [&.active]:text-(--menu-active-fg)', active && 'active', job.read_only && 'opacity-75')}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{job.name || m.untitled()}</span>
          <span className={cn('shrink-0 text-[11px]', active ? 'opacity-80' : st.tone)}>{st.label}</span>
        </span>
        <span className="truncate font-mono text-[11px] opacity-70">{scheduleText(job)}</span>
      </button>
    )
  }
  return (
    <div className="panel-view active flex min-h-0 flex-1 flex-col" id="panelTasks">
      <PanelHead title={m.tab_tasks()} actions={
        <>
          <PanelHeadButton label={m.refresh()} onClick={onRefresh}><RefreshCw size={14} aria-hidden="true" /></PanelHeadButton>
          <PanelHeadButton label={m.cron_new_job()} onClick={onNew}><Plus size={14} aria-hidden="true" /></PanelHeadButton>
        </>
      } />
      <nav className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-2" aria-label={m.tab_tasks()}>
        {pending && <div className="session-list-note" role="status">{m.loading()}</div>}
        {error !== null && <div className="session-list-note session-list-error" role="alert">{m.error_generic()} <button type="button" className="linklike" onClick={onRefresh}>{m.retry()}</button></div>}
        {!pending && error === null && jobs.length === 0 && <div className="session-list-note">{otherProfileCount > 0 && !allProfiles ? m.cron_no_jobs_in_profile() : m.cron_no_jobs()}</div>}
        {live.map(item)}
        {parked.length > 0 && (
          <details className="mt-1" open={parked.some((r) => r.id === selectedId) || undefined}>
            <summary className="session-date-header list-none">{m.cron_paused_group({ n: parked.length })}</summary>
            {parked.map(item)}
          </details>
        )}
        {(otherProfileCount > 0 || allProfiles) && (
          <button type="button" className="linklike mt-2 px-2.5 text-left text-[12px] text-muted" onClick={onToggleAllProfiles}>
            {allProfiles ? m.cron_hide_other_profiles() : m.cron_show_other_profiles({ n: otherProfileCount })}
          </button>
        )}
      </nav>
    </div>
  )
}

// ── Main view ────────────────────────────────────────────────────────────────

function TasksEmpty({ missing, unavailable, onNew }: { missing: boolean; unavailable: boolean; onNew: () => void }) {
  const isDesktop = useIsDesktop()
  return (
    <HubPage title={m.tab_tasks()}>
      {unavailable && <div className="mb-3 rounded-lg border border-warning px-3 py-2 text-sm text-warning" role="status">{m.cron_gateway_unavailable()}</div>}
      <EmptyState>
        <div>{missing ? m.cron_task_not_found() : m.cron_select_task()}</div>
        <div className="mt-3 flex justify-center gap-2">
          {!isDesktop && <Button onClick={openMobileSidebar}>{m.cron_browse_tasks()}</Button>}
          <Button variant="primary" onClick={onNew}><Plus size={12} aria-hidden="true" /> {m.cron_new_job()}</Button>
        </div>
      </EmptyState>
    </HubPage>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-text">{children}</dd>
    </>
  )
}

const DL = 'grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[13px]'

function TaskDetail({ job, jobs, state, onAction, onEdit, onDuplicate, onDelete }: {
  job: CronJob; jobs: CronJob[]; state: CronState; onAction: (action: CronAction) => void; onEdit: () => void; onDuplicate: () => void; onDelete: () => void
}) {
  const id = jobId(job)
  const readOnly = !!job.read_only
  const attention = needsAttention(state)
  const resumable = attention || state === 'paused' || state === 'off'
  const isScript = !!job.no_agent
  const nextRun = nextRunAt(job)
  const lastRun = lastRunAt(job)
  const st = statusLabel(state)
  const ownerProfile = (job.owner_profile ?? job.profile ?? '').trim()
  const profileLabel = (job.profile ?? '').trim() || m.cron_profile_server_default()
  const model = job.provider && job.model ? `${job.provider}/${job.model}` : job.model ?? job.provider ?? ''
  const contextFrom = contextFromList(job).map((ref) => jobs.find((j) => jobId(j) === ref)?.name || ref)
  const copyDiagnostics = () => {
    void navigator.clipboard.writeText(cronDiagnostics(job)).then(() => showToast(m.cron_diagnostics_copied()), () => showToast(m.copy_failed(), 3000, 'error'))
  }
  const toolbar = readOnly
    ? <div className="text-xs text-muted" role="note">{m.cron_read_only_profile({ profile: ownerProfile })}</div>
    : (
      <div className="flex flex-wrap gap-2" role="group" aria-label={job.name ?? id}>
        <Button onClick={() => onAction('run')}><Play size={12} aria-hidden="true" /> {m.cron_run_now()}</Button>
        {resumable
          ? <Button onClick={() => onAction('resume')}><Play size={12} aria-hidden="true" /> {m.cron_resume()}</Button>
          : <Button onClick={() => onAction('pause')}><Pause size={12} aria-hidden="true" /> {m.cron_pause()}</Button>}
        <Button onClick={onEdit}>{m.edit()}</Button>
        <Button onClick={onDuplicate}><Copy size={12} aria-hidden="true" /> {m.cron_duplicate()}</Button>
        <Button variant="ghost" className="text-error" onClick={onDelete}><Trash2 size={12} aria-hidden="true" /> {m.delete()}</Button>
      </div>
    )
  return (
    <HubPage title={job.name || m.untitled()} toolbar={toolbar} id="taskDetail">
      <div className="mx-auto flex max-w-3xl flex-col gap-6" data-testid="cron-detail" data-state={state}>
        {!readOnly && attention && (
          <section className="rounded-lg border border-warning px-4 py-3" role="alert">
            <div className="text-sm font-medium text-warning">{m.cron_status_needs_attention()}</div>
            <p className="mt-1 text-[13px] text-text">{m.cron_attention_desc()}</p>
            {/croniter/i.test(job.last_error ?? '') && <p className="mt-1 text-[13px] text-text">{m.cron_attention_croniter_hint()}</p>}
            {job.last_error && <p className="mt-2 font-mono text-[12px] text-error">{job.last_error}</p>}
            {job.last_delivery_error && <p className="mt-1 font-mono text-[12px] text-error">{job.last_delivery_error}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => onAction('resume')}>{m.cron_attention_resume()}</Button>
              <Button onClick={() => onAction('run')}>{m.cron_attention_run_once()}</Button>
              <Button onClick={copyDiagnostics}>{m.cron_attention_copy_diagnostics()}</Button>
            </div>
          </section>
        )}
        {!attention && (job.last_error || job.last_delivery_error) && (
          <section className="rounded-lg border border-border px-4 py-3" role="alert">
            {job.last_error && <div className="text-[13px]"><span className="text-muted">{m.cron_last_error_label()}: </span><span className="font-mono text-[12px] text-error">{job.last_error}</span></div>}
            {job.last_delivery_error && <div className="mt-1 text-[13px]"><span className="text-muted">{m.cron_delivery_error_label()}: </span><span className="font-mono text-[12px] text-error">{job.last_delivery_error}</span></div>}
            {!readOnly && <div className="mt-2"><Button onClick={copyDiagnostics}>{m.cron_attention_copy_diagnostics()}</Button></div>}
          </section>
        )}
        <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
          <section>
            <h2 className="mb-2 text-xs font-medium text-muted">{m.cron_schedule_preset_label()}</h2>
            <dl className={DL}>
              <Row label={m.cron_status_label()}><span className={st.tone}>{st.label}</span>{job.paused_reason && <span className="text-muted"> · {job.paused_reason}</span>}</Row>
              <Row label={m.cron_schedule_preset_label()}><code>{scheduleText(job)}</code></Row>
              <Row label={m.cron_next()}>{nextRun ? formatDate(nextRun) : m.not_available()}</Row>
              <Row label={m.cron_last()}>{lastRun ? formatDate(lastRun) : m.never()}</Row>
              <Row label={m.cron_deliver_label()}>{job.deliver || 'local'}</Row>
              <Row label={m.cron_profile_label()}>{profileLabel}{readOnly && ownerProfile && <span className="text-muted"> · {m.cron_owner_profile_label()}: {ownerProfile}</span>}</Row>
            </dl>
          </section>
          <section>
            <h2 className="mb-2 text-xs font-medium text-muted">{m.cron_configuration()}</h2>
            <dl className={DL}>
              <Row label={m.cron_mode_label()}>{isScript ? m.cron_mode_script() : m.cron_mode_agent()}</Row>
              {!isScript && <Row label={m.cron_model_label()}>{model ? <code>{model}</code> : m.cron_model_use_default()}</Row>}
              {!isScript && <Row label={m.cron_skills_label()}>{job.skills?.length ? job.skills.join(', ') : '—'}</Row>}
              {job.script && <Row label={m.cron_script_path_label()}><code>{job.script}</code></Row>}
              {job.workdir && <Row label={m.cron_workdir_label()}><code>{job.workdir}</code></Row>}
              {job.monitor && <Row label={m.cron_monitor_label()}><code>{job.monitor}</code></Row>}
              {!isScript && <Row label={m.cron_continuity_label()}>{job.continuity ? m.cron_toast_notifications_enabled() : m.cron_toast_notifications_disabled()}</Row>}
              {contextFrom.length > 0 && <Row label={m.cron_context_from_label()}>{contextFrom.join(', ')}</Row>}
              {job.reasoning_effort && <Row label={m.cron_reasoning_effort_label()}>{job.reasoning_effort}</Row>}
              <Row label={m.cron_toast_notifications_label()}>{job.toast_notifications === false ? m.cron_toast_notifications_disabled() : m.cron_toast_notifications_enabled()}</Row>
            </dl>
          </section>
        </div>
        <section>
          <h2 className="mb-1 text-xs font-medium text-muted">{m.cron_prompt_label()}</h2>
          {isScript
            ? <><code className="text-[13px]">{job.script || '—'}</code><div className="mt-1 text-[11px] text-muted">{m.cron_script_path_hint()}</div></>
            : <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-sans text-[13px] text-text">{job.prompt || '—'}</pre>}
        </section>
        {!readOnly && <RunHistory key={id} jobId={id} isScript={isScript} />}
      </div>
    </HubPage>
  )
}

function RunHistory({ jobId: id, isScript }: { jobId: string; isScript: boolean }) {
  const history = useQuery({ queryKey: keys.crons.history(id), queryFn: () => api.fetchCronHistory(id), staleTime: 15_000 })
  const [picked, setPicked] = useState<string | null>(null)
  // The panel starts collapsed on every task; picking a run opens it.
  const [open, setOpen] = useState(false)
  // The layout row only has a right panel from 901px up; below that the run opens under the table.
  const hasRightPanel = useMediaQuery('(min-width: 901px)')
  const title = m.cron_runs_title()
  if (history.isPending) return <LoadingState />
  if (history.isError) return <ErrorState error={history.error} onRetry={() => { void history.refetch() }} />
  const runs = history.data.runs
  const total = history.data.total ?? runs.length
  const current = runs.find((r) => r.filename === picked) ?? runs[0] ?? null
  const pick = (filename: string) => {
    if (open && filename === current?.filename) { setOpen(false); return }
    setPicked(filename); setOpen(true)
  }
  return (
    <section aria-label={title}>
      <h2 className="mb-2 text-xs font-medium text-muted">{title} {runs.length > 0 && `(${total > runs.length ? m.cron_runs_showing({ total, shown: runs.length }) : String(total)})`}</h2>
      {runs.length === 0 && <div className="text-[13px] text-muted">{m.cron_no_runs_yet()}</div>}
      {runs.length > 0 && (
        <div className="rounded-md border border-border">
          <table className="w-full border-collapse text-[13px]">
            <tbody>
              {runs.map((run) => {
                const active = open && run.filename === current?.filename
                return (
                  <tr key={run.filename} className={cn('cursor-pointer border-b border-border-subtle last:border-b-0 hover:bg-hover', active && 'bg-(--menu-active-bg) text-(--menu-active-fg)')} onClick={() => pick(run.filename)}>
                    <td className="px-3 py-2"><button type="button" className="text-left" aria-pressed={active} title={run.filename} onClick={(e) => { e.stopPropagation(); pick(run.filename) }}>{formatDate(run.modified)}</button></td>
                    <td className="px-3 py-2 text-xs text-muted">{isScript ? '' : usageStrip(run.usage)}</td>
                    <td className="px-3 py-2 text-right text-xs text-muted">{formatBytes(run.size)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {current && (hasRightPanel
        ? (
          <RightPanel open={open} onToggle={() => setOpen((o) => !o)} onClose={() => setOpen(false)} label={title} panelId="cron-run" title={title} subtitle={formatDate(current.modified)}>
            <div className="min-h-0 flex-1 overflow-auto p-3 text-[13px]"><RunBody key={current.filename} jobId={id} filename={current.filename} isScript={isScript} /></div>
          </RightPanel>
        )
        : open && <div className="mt-3"><RunBody key={current.filename} jobId={id} filename={current.filename} isScript={isScript} /></div>)}
    </section>
  )
}

function RunBody({ jobId: id, filename, isScript }: { jobId: string; filename: string; isScript: boolean }) {
  const run = useQuery({ queryKey: keys.crons.run(id, filename), queryFn: () => api.fetchCronRun(id, filename), staleTime: Infinity })
  if (run.isPending) return <LoadingState />
  if (run.isError || run.data.error) return <div className="text-xs text-error" role="alert">{m.cron_run_load_failed()} {run.isError ? (run.error instanceof Error ? run.error.message : String(run.error)) : run.data.error}</div>
  const body = runResponse(run.data.content ?? run.data.snippet ?? '')
  const usage = usageStrip(run.data.usage)
  return (
    <div data-testid="cron-run-output">
      {usage && <div className="mb-2 text-[11px] text-muted">{usage}</div>}
      {isScript
        ? <pre className="overflow-auto whitespace-pre-wrap rounded-md border border-border-subtle bg-code-bg p-3 font-mono text-[12px] text-pre-text">{body}</pre>
        : <Markdown text={body} />}
    </div>
  )
}
