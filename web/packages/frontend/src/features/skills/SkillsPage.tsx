import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { SkillReplayJob, SkillReplayPlan } from '@maudecode/talaria-web-contracts'
import { ChevronLeft, Search } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { HubPage } from '../../shell/AppShell'
import { Button } from '../../ui/Button'
import { Select } from '../../ui/Select'
import { ConfirmDialog } from '../../ui/Dialog'
import { EmptyState, ErrorState, LoadingState, formatBytes, formatDate, formatUsd } from '../../ui/States'
import { showToast } from '../toast/toast'
import { showErrorToast } from '../toast/errorToast'
import { useResourceEffects, useResourceMutation, withEffects } from '../sessions/useResourceMutation'
import { SkillRow } from './SkillRow'
import { PendingWritesPanel, TextDiffReview } from '../pending-writes/PendingWritesPanel'
import { useStreamContext } from '../../stream/connection'

export function SkillsPage() {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const skills = useQuery({ queryKey: keys.skills.all, queryFn: () => api.fetchSkills(), staleTime: 30_000 })
  const usage = useQuery({ queryKey: keys.skills.usage, queryFn: api.fetchSkillsUsage, staleTime: 60_000 })
  const effects = useResourceEffects<boolean>()
  const list = withEffects(skills.data?.skills ?? [], (s) => `skill:${s.name}`, effects)
  const categories = [...new Set(list.map((s) => s.category).filter((c): c is string => !!c))].sort()
  const filtered = (() => {
    const q = query.trim().toLowerCase()
    return list.filter((s) => (!category || s.category === category) && (!q || s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q)))
  })()
  const toggle = useResourceMutation({ resource: ({ name }: { name: string; enabled: boolean }) => `skill:${name}`, effect: ({ enabled }) => ({ value: enabled }), queryKey: keys.skills.all, readKeys: () => [{ queryKey: keys.skills.all, exact: true }], mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => api.toggleSkill(name, enabled), onError: (e) => showErrorToast(e) })

  if (selected) return <SkillDetail key={selected} name={selected} onBack={() => setSelected(null)} />
  return (
    <HubPage
      title={m.tab_skills()}
      toolbar={
        <>
          <SkillSearch initialQuery={query} onSearch={setQuery} />
          {categories.length > 0 && (
            <Select value={category} onValueChange={(v) => setCategory(v)} aria-label={m.skill_category_all()}>
              <option value="">{m.skill_category_all()}</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          )}
        </>
      }
    >
      <PendingWritesPanel kind="skills" />
      {skills.isPending && <LoadingState />}
      {skills.isError && <ErrorState error={skills.error} onRetry={() => { void skills.refetch() }} />}
      {skills.isSuccess && filtered.length === 0 && <EmptyState>{m.skills_no_skills()}</EmptyState>}
      <ul className="skills-list flex flex-col divide-y divide-border-subtle" id="skillsList">
        {filtered.map((s) => <SkillRow key={s.name} skill={s} uses={usage.data?.usage[s.name]?.use_count ?? 0} effect={effects[`skill:${s.name}`]} onSelect={setSelected} onToggle={toggle.mutate} />)}
      </ul>
    </HubPage>
  )
}

function SkillSearch({ initialQuery, onSearch }: { initialQuery: string; onSearch: (query: string) => void }) {
  const [query, setQuery] = useState(initialQuery)
  return (
    <div className="sidebar-search hub-search">
      <Search size={14} className="sidebar-search-icon" aria-hidden="true" />
      <input id="skillsSearch" type="search" value={query} onChange={(e) => { setQuery(e.target.value); onSearch(e.target.value) }} placeholder={m.search_skills()} aria-label={m.search_skills()} />
    </div>
  )
}

function SkillDetail({ name, onBack }: { name: string; onBack: () => void }) {
  const content = useQuery({ queryKey: keys.skills.content(name), queryFn: () => api.fetchSkillContent(name) })
  const [draft, setDraft] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [file, setFile] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  // The editor keeps the submitted text; a confirmed save clears only a draft nobody edited since. A later save waits for
  // the one in flight, so the server always ends on the newest text.
  const save = useResourceMutation({
    resource: () => `skill-content:${name}`, queryKey: keys.skills.all, readKeys: () => [{ queryKey: keys.skills.content(name), exact: true }],
    effect: (text: string) => ({ value: text }),
    mutationFn: (text) => api.saveSkill(name, text),
    onSuccess: (_, text) => { showToast(m.skill_saved()); setDraft((d) => d === text ? null : d) },
    onError: (e) => showErrorToast(e),
  })
  const del = useResourceMutation({ resource: () => `skill:${name}`, effect: () => ({ remove: true }), queryKey: keys.skills.all, readKeys: () => [{ queryKey: keys.skills.all, exact: true }], mutationFn: () => api.deleteSkill(name), onError: (e) => showErrorToast(e) })
  const text = draft ?? content.data?.content ?? ''
  const linked = Object.entries(content.data?.linked_files ?? {})
  if (file) return <SkillFile name={name} file={file} onBack={() => setFile(null)} />
  return (
    <HubPage title={name} actions={<Button variant="ghost" onClick={onBack}><ChevronLeft size={14} aria-hidden="true" /> {m.back()}</Button>}>
      {content.isPending && <LoadingState />}
      {content.isError && <ErrorState error={content.error} onRetry={() => { void content.refetch() }} />}
      {content.isSuccess && (
        <div className="flex flex-col gap-3">
          {content.data.path && <div className="font-mono text-[11px] text-muted">{content.data.path}</div>}
          <details onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
            <summary className="cursor-pointer py-2 text-sm text-muted hover:text-text">{m.skill_revisions_title()}</summary>
            {historyOpen && <SkillRevisionHistory name={name} />}
          </details>
          <label className="flex flex-col gap-1 text-sm">
            <span>{m.skill_content_label()}</span>
            <textarea value={text} readOnly={content.data.editable === false} onChange={(e) => setDraft(e.target.value)} rows={24} spellCheck={false} placeholder={m.skill_content_placeholder()} className="w-full rounded-md border border-border bg-code-bg p-3 font-mono text-[12.5px] text-pre-text" />
          </label>
          {content.data.editable !== false && <div className="flex gap-2">
            <Button variant="primary" disabled={draft === null} onClick={() => { if (draft !== null) save.mutate(draft) }}>{m.save()}</Button>
            <Button variant="ghost" className="text-error" onClick={() => setConfirm(true)}>{m.delete()}</Button>
          </div>}
          {linked.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{m.linked_files()}</h3>
              {linked.map(([group, files]) => (
                <div key={group} className="flex flex-col gap-1">
                  <h4 className="text-xs text-muted">{group}</h4>
                  {files.map((f) => <Button key={f} variant="link" className="self-start font-mono text-[12.5px] leading-normal" onClick={() => setFile(f)}>{f}</Button>)}
                </div>
              ))}
            </section>
          )}
        </div>
      )}
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={m.skill_delete_confirm({ a0: name })} confirmLabel={m.delete()} cancelLabel={m.cancel()} danger onConfirm={() => { del.mutate(); onBack() }} />
    </HubPage>
  )
}

function SkillRevisionHistory({ name }: { name: string }) {
  const context = useStreamContext()
  const [selection, setSelection] = useState<{ context: object; revision?: string; compare_to?: string } | null>(null)
  const owned = selection?.context === context ? selection : null
  const history = useQuery({ queryKey: keys.skills.revisions(name, owned?.revision, owned?.compare_to), queryFn: async ({ signal }) => ({ context, value: await api.fetchSkillRevisions(name, owned ?? undefined, signal) }) })
  const data = history.data?.context === context ? history.data.value : undefined
  const unavailable = data?.reason === 'history_unavailable' ? m.skill_revisions_missing()
    : data?.reason === 'identity_unavailable' ? m.skill_revisions_identity_unavailable()
    : data?.reason === 'invalid_history' ? m.skill_revisions_invalid() : m.skill_revisions_backend_unavailable()
  return <section aria-label={m.skill_revisions_title()} className="flex min-w-0 flex-col gap-3 py-2">
    {history.isPending && <LoadingState />}
    {history.isError && <ErrorState error={history.error} onRetry={() => { setSelection(null); if (!owned) void history.refetch() }} />}
    {data && data.state !== 'available' && <p role="status" className="text-sm text-muted">{unavailable}</p>}
    {data?.state === 'available' && <>
      <div className="font-mono text-xs break-all text-muted">Hermetic {data.backend_revision}</div>
      <ul className="divide-y divide-border-subtle">
        {data.revisions.map((row) => <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-xs">
          <span className="font-mono text-text">{row.label}</span>
          {row.current && <span className="text-muted">{m.skill_revisions_current()}</span>}
          {row.saved_at && <time dateTime={row.saved_at} className="text-muted">{formatDate(row.saved_at)}</time>}
          {row.actor && <span className="text-muted">{row.actor}</span>}
        </li>)}
      </ul>
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">{m.skill_revisions_revision()}
          <Select aria-label={m.skill_revisions_revision()} value={data.selected?.revision} onValueChange={(revision) => setSelection({ context, revision, ...(data.comparison ? { compare_to: data.comparison.from_revision } : {}) })}>
            {data.revisions.map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}
          </Select>
        </label>
        {data.comparison && <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">{m.skill_revisions_compare_with()}
          <Select aria-label={m.skill_revisions_compare_with()} value={data.comparison.from_revision} onValueChange={(compare_to) => setSelection({ context, compare_to, ...(data.selected ? { revision: data.selected.revision } : {}) })}>
            {data.revisions.map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}
          </Select>
        </label>}
      </div>
      {data.selected && <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">{m.skill_revisions_content()}
        <textarea readOnly value={data.selected.content} rows={6} className="w-full rounded-md border border-border-subtle bg-code-bg p-3 font-mono text-xs text-pre-text" />
      </label>}
      {data.comparison && <TextDiffReview summary={m.skill_revisions_comparison()} target="" diff={data.comparison.diff} open />}
    </>}
    {data && <SkillReplays name={name} comparison={data.replay_available ? data.comparison : null} />}
  </section>
}

type ReplayJob = SkillReplayJob
type ReplayRun = ReplayJob['cases'][number]['baseline']
const replayState: Record<ReplayJob['state'], () => string> = {
  queued: m.skill_replay_state_queued, running: m.skill_replay_state_running, cancelling: m.skill_replay_state_cancelling, completed: m.skill_replay_state_completed,
  cancelled: m.skill_replay_state_cancelled, interrupted: m.skill_replay_state_interrupted, failed: m.skill_replay_state_failed,
}
const runStatus = (run: ReplayRun): string => run.status === 'completed' ? (run.result?.passed ? m.skill_replay_run_passed() : m.skill_replay_run_failed())
  : { pending: m.skill_replay_run_pending, dispatched: m.skill_replay_run_dispatched, error: m.skill_replay_run_error, refused: m.skill_replay_run_refused, unknown: m.skill_replay_run_unknown, skipped: m.skill_replay_run_skipped }[run.status]()
const replayUnavailable = (reason: SkillReplayPlan['reason']): string => reason === 'route_unsupported' ? m.skill_replay_route_unsupported()
  : reason === 'no_cases' ? m.skill_replay_no_cases() : reason === 'history_unavailable' ? m.skill_revisions_missing()
  : reason === 'identity_unavailable' ? m.skill_revisions_identity_unavailable() : reason === 'invalid_history' ? m.skill_revisions_invalid() : m.skill_revisions_backend_unavailable()

type ReplayRevision = SkillReplayPlan['revisions'][number]
interface ReplayConsent { requestId: string; plan: SkillReplayPlan; baseline: ReplayRevision; candidate: ReplayRevision; route: NonNullable<SkillReplayPlan['route']>; budget: NonNullable<SkillReplayPlan['budget']> }
function replayConsent(plan: SkillReplayPlan, requestId: string): ReplayConsent | null {
  const [baseline, candidate] = plan.revisions
  return plan.state === 'ready' && baseline && candidate && plan.route && plan.budget ? { requestId, plan, baseline, candidate, route: plan.route, budget: plan.budget } : null
}

/** TAL-1563: consent to one exact bounded replay, follow its server-projected status, cancel it, and read retained results. */
function SkillReplays({ name, comparison }: { name: string; comparison: { from_revision: string; to_revision: string } | null }) {
  const [consent, setConsent] = useState<ReplayConsent | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const effects = useResourceEffects()
  const replays = useQuery({ queryKey: keys.skills.replays(name), queryFn: () => api.fetchSkillReplays(name), refetchInterval: (query) => query.state.data?.jobs.some((job) => job.active) ? 1500 : false })
  const jobs = withEffects(replays.data?.jobs ?? [], (job) => `skill-replay:${job.id}`, effects)
  const plan = useMutation({
    mutationFn: (selection: { from_revision: string; to_revision: string }) => api.fetchSkillReplayPlan(name, selection.from_revision, selection.to_revision),
    onSuccess: (result) => { const next = replayConsent(result, requestId); setConsent(next); setRefusal(next ? null : replayUnavailable(result.reason)) },
    onError: (error) => showErrorToast(error),
  })
  const start = useMutation({
    mutationFn: (selected: ReplayConsent) => api.startSkillReplay({ request_id: selected.requestId, name, baseline: selected.baseline.id, candidate: selected.candidate.id,
      case_ids: selected.plan.cases.map((row) => row.id), route: selected.route, max_cost_usd: selected.budget.max_cost_usd }),
    // A definite answer retires the request id; an uncertain one keeps it, so a retry returns the admitted job.
    onSettled: (_result, error) => { if (!error || ((error as { status?: number }).status ?? 500) < 500) setRequestId(crypto.randomUUID()); void replays.refetch() },
    onError: (error) => showErrorToast(error),
  })
  const cancel = useResourceMutation({ resource: (id: string) => `skill-replay:${id}`, effect: () => ({ fields: { state: 'cancelling', can_cancel: false } }), queryKey: keys.skills.replays(name), mutationFn: (id: string) => api.cancelSkillReplay(id), onError: (e) => showErrorToast(e) })
  const busy = plan.isPending || start.isPending || jobs.some((job) => job.active)
  return <div className="flex min-w-0 flex-col gap-3">
    {comparison && <div><Button onClick={() => plan.mutate(comparison)} disabled={busy} aria-busy={plan.isPending || start.isPending}>{m.skill_replay_start()}</Button></div>}
    {refusal && <p role="status" className="text-sm text-muted">{refusal}</p>}
    {consent && <ConfirmDialog open onOpenChange={(open) => { if (!open) setConsent(null) }} title={m.skill_replay_confirm_title()} confirmLabel={m.skill_replay_confirm()} cancelLabel={m.cancel()}
      onConfirm={() => { start.mutate(consent) }}>
      <div className="mt-3 flex flex-col gap-2 text-sm [overflow-wrap:anywhere]">
        <p className="font-mono text-xs">{m.skill_replay_revisions({ baseline: consent.baseline.label, candidate: consent.candidate.label })}</p>
        <div>
          <p>{m.skill_replay_cases({ count: String(consent.plan.cases.length) })}</p>
          <ul className="list-disc pl-5 text-muted">{consent.plan.cases.map((row) => <li key={row.id}>{row.title}</li>)}</ul>
          {consent.plan.unavailable_cases > 0 && <p className="text-muted">{m.skill_replay_unavailable_cases({ count: String(consent.plan.unavailable_cases) })}</p>}
        </div>
        <p>{m.skill_replay_route({ provider: consent.route.provider, model: consent.route.model })}</p>
        <p>{m.skill_replay_budget({ cost: formatUsd(consent.budget.max_cost_usd), calls: String(consent.budget.max_calls), output: String(consent.budget.max_output_tokens), price: formatUsd(consent.budget.max_price_per_million) })}</p>
      </div>
    </ConfirmDialog>}
    {jobs.length > 0 && <section aria-label={m.skill_replay_results()} className="flex min-w-0 flex-col gap-4">
      {jobs.map((job) => <article key={job.id} className="flex min-w-0 flex-col gap-2 border-t border-border-subtle pt-3 text-xs">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span role="status" className="font-medium text-text">{replayState[job.state]()}</span>
          <time dateTime={job.created_at} className="text-muted">{formatDate(job.created_at)}</time>
          <span className="font-mono text-muted">{m.skill_replay_revisions({ baseline: job.revisions[0].label, candidate: job.revisions[1].label })}</span>
          <span className="text-muted">{m.skill_replay_route({ provider: job.route.provider, model: job.route.model })}</span>
          {job.can_cancel && <Button variant="ghost" onClick={() => cancel.mutate(job.id)}>{m.skill_replay_cancel()}</Button>}
        </div>
        <p className="text-muted">{m.skill_replay_cost({ spent: formatUsd(job.reported_cost_usd), budget: formatUsd(job.budget.max_cost_usd) })}{job.unreported_calls > 0 && ` · ${m.skill_replay_unreported({ count: String(job.unreported_calls) })}`}</p>
        {job.summary.map((row) => <p key={row.role}>{m.skill_replay_summary({ role: row.role === 'baseline' ? m.skill_replay_baseline() : m.skill_replay_candidate(), passed: String(row.passed), failed: String(row.failed), error: String(row.error), unknown: String(row.unknown), refused: String(row.refused), skipped: String(row.skipped) })}</p>)}
        <ul className="divide-y divide-border-subtle">
          {job.cases.map((row) => <li key={row.id} className="flex min-w-0 flex-col gap-1 py-2">
            <span className="text-text">{row.title}</span>
            {(['baseline', 'candidate'] as const).map((role) => <ReplayRunRow key={role} label={role === 'baseline' ? m.skill_replay_baseline() : m.skill_replay_candidate()} run={row[role]} />)}
          </li>)}
        </ul>
      </article>)}
    </section>}
  </div>
}

function ReplayRunRow({ label, run }: { label: string; run: ReplayRun }) {
  const calls = run.result?.tool_calls.map((call) => call.name).join(', ')
  return <div className="flex min-w-0 flex-col gap-1">
    <div className="flex flex-wrap gap-x-2"><span className="text-muted">{label}</span><span className="text-text">{runStatus(run)}</span>{calls && <span className="font-mono text-muted">{calls}</span>}{run.detail && <span className="text-muted">{run.detail}</span>}</div>
    {run.result?.content && <details><summary className="cursor-pointer text-muted hover:text-text">{m.skill_replay_answer()}</summary><pre className="mt-1 whitespace-pre-wrap rounded-md bg-code-bg p-2 font-mono text-pre-text">{run.result.content}</pre></details>}
  </div>
}

function SkillFile({ name, file, onBack }: { name: string; file: string; onBack: () => void }) {
  const content = useQuery({ queryKey: keys.skills.content(name, file), queryFn: () => api.fetchSkillContent(name, file) })
  return (
    <HubPage title={name} actions={<Button variant="ghost" onClick={onBack}><ChevronLeft size={14} aria-hidden="true" /> {m.skills_back_to({ a0: name })}</Button>}>
      {content.isPending && <LoadingState />}
      {content.isError && <ErrorState error={content.error} onRetry={() => { void content.refetch() }} />}
      {content.isSuccess && (
        <div className="flex flex-col gap-3">
          <div className="font-mono text-[11px] text-muted">{file}</div>
          {content.data.binary
            ? <div className="text-xs text-muted">{m.ws_panel_binary({ size: formatBytes(content.data.size) })}</div>
            : <pre className="w-full overflow-auto whitespace-pre-wrap rounded-md border border-border bg-code-bg p-3 font-mono text-[12.5px] text-pre-text">{content.data.content ?? ''}</pre>}
        </div>
      )}
    </HubPage>
  )
}
