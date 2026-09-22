/** Create / edit / duplicate form for one cron job, rendered in the main view. */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useForm } from '@tanstack/react-form'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import type { CronJob } from '../../contracts'
import { HubPage } from '../../shell/AppShell'
import { Button } from '../../ui/Button'
import { Switch, FieldRow, TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { showToast } from '../toast/toast'
import { cn } from '../../ui/cn'
import { useModelsQuery, useProfilesQuery } from '../../app/queries'
import { contextFromList, jobId, modelOptionFor, modelOptionValue, scheduleText, splitModelOption } from './cronJob'

export type EditorMode = 'create' | 'edit' | 'duplicate'

// Canonical Hermes reasoning levels; cron.jobs validates the same grammar.
const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const FORM_ID = 'cronJobForm'

interface FormValues {
  name: string; schedule: string; prompt: string; script: string; no_agent: boolean; deliver: string; repeat: string; profile: string
  model: string; toast_notifications: boolean; skills: string; monitor: string; continuity: boolean; context_from: string[]; reasoning_effort: string
}

export function JobForm({ mode, job, jobs, onCancel, onSaved }: { mode: EditorMode; job: CronJob | null; jobs: CronJob[]; onCancel: () => void; onSaved: (id?: string) => void }) {
  const isEdit = mode === 'edit'
  const profiles = useProfilesQuery()
  const models = useModelsQuery()
  const delivery = useQuery({ queryKey: keys.crons.deliveryOptions, queryFn: api.fetchCronDeliveryOptions, staleTime: 60_000 })
  const skills = useQuery({ queryKey: keys.skills.all, queryFn: () => api.fetchSkills(), staleTime: 60_000, enabled: !isEdit })
  const [error, setError] = useState<string | null>(null)
  const sourceId = job ? jobId(job) : ''
  const chainable = jobs.filter((j) => !j.read_only && jobId(j) && jobId(j) !== sourceId)
  const providerOf = (id: string): string | null => { for (const g of models.data?.groups ?? []) if (g.models.some((mm) => mm.id === id)) return g.provider_id ?? g.provider; return null }
  const knownModels = useMemo(() => new Set((models.data?.groups ?? []).flatMap((g) => g.models.map((mm) => mm.id))), [models.data])
  const copyName = (name: string) => {
    const taken = new Set(jobs.map((j) => j.name))
    let candidate = `${name} ${m.cron_copy_suffix()}`
    for (let n = 2; taken.has(candidate); n++) candidate = `${name} ${m.cron_copy_suffix_n({ n })}`
    return candidate
  }
  const repeatTimes = job?.repeat && typeof job.repeat === 'object' ? job.repeat.times : typeof job?.repeat === 'number' ? job.repeat : null
  const form = useForm({
    defaultValues: {
      name: mode === 'duplicate' ? copyName(job?.name ?? '') : job?.name ?? '',
      schedule: job ? scheduleText(job) : '',
      prompt: job?.prompt ?? '',
      script: job?.script ?? '',
      no_agent: !!job?.no_agent,
      deliver: job?.deliver ?? 'local',
      repeat: mode === 'duplicate' && repeatTimes != null ? String(repeatTimes) : '',
      profile: job?.profile ?? '',
      model: modelOptionValue(job?.model, job?.provider),
      toast_notifications: job?.toast_notifications !== false,
      skills: job?.skills?.join(', ') ?? '',
      monitor: job?.monitor ?? '',
      continuity: !!job?.continuity,
      context_from: job ? contextFromList(job) : [],
      reasoning_effort: job?.reasoning_effort ?? '',
    } satisfies FormValues,
    onSubmit: async ({ value }) => {
      setError(null)
      const v = { ...value, name: value.name.trim(), schedule: value.schedule.trim(), prompt: value.prompt.trim(), script: value.script.trim(), monitor: value.monitor.trim(), repeat: value.repeat.trim() }
      if (!v.schedule) { setError(m.cron_schedule_required_example()); return }
      // Same payload rule as the server's create handler: at least one of prompt, script or skills.
      const skillList = v.skills.split(',').map((s) => s.trim()).filter(Boolean)
      if (!v.no_agent && !v.prompt && !v.script && skillList.length === 0) { setError(m.cron_prompt_required()); return }
      if (v.no_agent && !v.script) { setError(m.cron_no_agent_script_required()); return }
      // docs/scheduled-jobs.md: the save is blocked, never one of the two silently dropped; the monitor stays editable so it can be cleared.
      if (v.no_agent && v.monitor) { setError(m.cron_monitor_no_agent_conflict()); return }
      if (v.repeat && !(/^\d+$/.test(v.repeat) && Number(v.repeat) >= 1)) { setError(m.cron_repeat_invalid()); return }
      const { model, provider } = splitModelOption(v.model, providerOf)
      try {
        let res
        if (isEdit && job) {
          // Every field is sent so the agent's documented clearing semantics stay
          // reachable ('' clears script/monitor, [] clears context_from, false
          // turns continuity off, null clears the model pin). `repeat` and
          // `skills` are create-only in the store.
          const body: Record<string, unknown> = {
            job_id: sourceId, name: v.name, schedule: v.schedule, deliver: v.deliver || 'local', profile: v.profile, toast_notifications: v.toast_notifications,
            script: v.script, no_agent: v.no_agent, monitor: v.monitor, continuity: v.continuity, context_from: v.context_from,
            reasoning_effort: v.reasoning_effort, model, provider,
          }
          if (!v.no_agent) body.prompt = v.prompt
          res = await api.cronAction('update', body)
        } else {
          // Omitted when unset so agent-side defaults still apply.
          const body: Record<string, unknown> = { schedule: v.schedule, prompt: v.prompt, deliver: v.deliver || 'local', profile: v.profile, toast_notifications: v.toast_notifications }
          if (v.name) body.name = v.name
          if (skillList.length) body.skills = skillList
          if (v.script) body.script = v.script
          if (v.no_agent) body.no_agent = true
          if (v.monitor) body.monitor = v.monitor
          if (v.continuity) body.continuity = true
          if (v.context_from.length) body.context_from = v.context_from
          if (v.reasoning_effort) body.reasoning_effort = v.reasoning_effort
          if (v.repeat) body.repeat = Number(v.repeat)
          if (model) { body.model = model; body.provider = provider }
          res = await api.cronAction('create', body)
        }
        if (res.error) { setError(res.error); return }
        showToast(isEdit ? m.cron_job_updated() : m.cron_job_created())
        onSaved(res.job ? jobId(res.job) : res.job_id)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
  })
  const title = isEdit ? m.cron_edit_job() : mode === 'duplicate' ? m.cron_duplicate_job() : m.cron_new_job()
  const platforms = (delivery.data?.platforms ?? []) as { value?: string; label?: string }[]
  const textarea = 'w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-text'
  const group = 'flex flex-col divide-y divide-border-subtle'
  return (
    <HubPage
      title={title}
      id="taskEditor"
      actions={<><Button onClick={onCancel}>{m.cancel()}</Button><Button variant="primary" type="submit" form={FORM_ID}>{m.save()}</Button></>}
    >
      <form id={FORM_ID} onSubmit={(e) => { e.preventDefault(); void form.handleSubmit() }} className="mx-auto max-w-2xl" aria-label={title}>
        <div className={group}>
          <form.Field name="name">{(f) => <FieldRow label={m.cron_name_label()} htmlFor="cronName"><TextInput id="cronName" value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} placeholder={m.cron_name_placeholder()} /></FieldRow>}</form.Field>
          <form.Field name="schedule">{(f) => <FieldRow label={m.cron_schedule_preset_label()} htmlFor="cronSchedule" hint={m.cron_schedule_hint()}><TextInput id="cronSchedule" required value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} placeholder="0 9 * * *" /></FieldRow>}</form.Field>
          <form.Field name="no_agent">{(f) => <FieldRow label={m.cron_no_agent_label()} hint={m.cron_no_agent_hint()} htmlFor="cronNoAgent" inline><Switch id="cronNoAgent" checked={f.state.value} onCheckedChange={(checked) => f.handleChange(checked)} /></FieldRow>}</form.Field>
        </div>
        <form.Subscribe selector={(s) => s.values.no_agent}>{(noAgent) => (
          <>
            <div className={group}>
              {!noAgent && <form.Field name="prompt">{(f) => <FieldRow label={m.cron_prompt_label()} htmlFor="cronPrompt"><textarea id="cronPrompt" rows={5} value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} className={textarea} /></FieldRow>}</form.Field>}
              <form.Field name="script">{(f) => <FieldRow label={m.cron_script_path_label()} hint={noAgent ? m.cron_script_path_hint() : m.cron_script_context_hint()} htmlFor="cronScript"><TextInput id="cronScript" value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} placeholder={m.cron_script_path_placeholder()} /></FieldRow>}</form.Field>
              {!noAgent && (isEdit
                ? <FieldRow label={m.cron_skills_label()} hint={m.cron_skills_edit_hint()}><div className="text-sm text-muted">{job?.skills?.length ? job.skills.join(', ') : '—'}</div></FieldRow>
                : <form.Field name="skills">{(f) => (
                  <FieldRow label={m.cron_skills_label()} htmlFor="cronSkills">
                    <TextInput id="cronSkills" list="cronSkillNames" value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} placeholder={m.cron_skills_placeholder()} />
                    <datalist id="cronSkillNames">{(skills.data?.skills ?? []).map((s) => <option key={s.name} value={s.name} />)}</datalist>
                  </FieldRow>
                )}</form.Field>)}
            </div>
            <div className={cn(group, 'mt-6')}>
              <form.Field name="deliver">{(f) => (
                <FieldRow label={m.cron_deliver_label()} htmlFor="cronDeliver" inline>
                  <Select id="cronDeliver" value={f.state.value} onValueChange={(v) => f.handleChange(v)} className="w-56 max-w-full">
                    {platforms.length === 0 && <option value="local">{m.cron_deliver_local()}</option>}
                    {platforms.map((p) => <option key={p.value} value={p.value ?? ''}>{p.label ?? p.value}</option>)}
                    {f.state.value && !platforms.some((p) => p.value === f.state.value) && f.state.value !== 'local' && <option value={f.state.value}>{f.state.value}</option>}
                  </Select>
                </FieldRow>
              )}</form.Field>
              <form.Field name="profile">{(f) => (
                <FieldRow label={m.cron_profile_label()} hint={m.cron_profile_server_default_hint()} htmlFor="cronProfile" inline>
                  <Select id="cronProfile" value={f.state.value} onValueChange={(v) => f.handleChange(v)} className="w-56 max-w-full">
                    <option value="">{m.cron_profile_default()}</option>
                    {(profiles.data?.profiles ?? []).map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                  </Select>
                </FieldRow>
              )}</form.Field>
              <form.Field name="model">{(f) => (
                <FieldRow label={m.cron_model_label()} hint={noAgent ? m.cron_model_no_agent_hint() : m.cron_model_hint()} htmlFor="cronModel" inline>
                  <Select id="cronModel" value={modelOptionFor(f.state.value, knownModels)} onValueChange={(v) => f.handleChange(v)} className="w-56 max-w-full" disabled={noAgent}>
                    <option value="">{m.cron_model_use_default()}</option>
                    {(models.data?.groups ?? []).map((g) => (
                      <optgroup key={g.provider} label={g.provider}>
                        {g.models.map((mm) => <option key={mm.id} value={mm.id}>{mm.label ?? mm.id}</option>)}
                      </optgroup>
                    ))}
                    {f.state.value && !knownModels.has(modelOptionFor(f.state.value, knownModels)) && <option value={f.state.value}>{f.state.value}</option>}
                  </Select>
                </FieldRow>
              )}</form.Field>
              <form.Field name="toast_notifications">{(f) => <FieldRow label={m.cron_toast_notifications_label()} hint={m.cron_toast_notifications_hint()} htmlFor="cronToast" inline><Switch id="cronToast" checked={f.state.value} onCheckedChange={(checked) => f.handleChange(checked)} /></FieldRow>}</form.Field>
            </div>
            <details className="mt-6" open={!!(job && (job.monitor || job.continuity || job.reasoning_effort || contextFromList(job).length))}>
              <summary className="cursor-pointer text-xs font-medium text-muted">{m.cron_advanced_label()}</summary>
              <div className={group}>
                <form.Field name="monitor">{(f) => <FieldRow label={m.cron_monitor_label()} hint={noAgent ? m.cron_monitor_no_agent_hint() : m.cron_monitor_hint()} htmlFor="cronMonitor"><TextInput id="cronMonitor" value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} placeholder={m.cron_monitor_placeholder()} /></FieldRow>}</form.Field>
                <form.Field name="continuity">{(f) => <FieldRow label={m.cron_continuity_label()} hint={m.cron_continuity_hint()} htmlFor="cronContinuity" inline><Switch id="cronContinuity" checked={f.state.value} onCheckedChange={(checked) => f.handleChange(checked)} disabled={noAgent} /></FieldRow>}</form.Field>
                <form.Field name="context_from">{(f) => (
                  <FieldRow label={m.cron_context_from_label()} hint={chainable.length ? m.cron_context_from_hint() : m.cron_context_from_empty_hint()}>
                    <div className="flex flex-col gap-1" role="group" aria-label={m.cron_context_from_label()}>
                      {chainable.map((j) => {
                        const cid = jobId(j)
                        const checked = f.state.value.includes(cid)
                        return (
                          <label key={cid} className="flex items-center gap-2 text-sm text-text">
                            <input type="checkbox" checked={checked} disabled={noAgent} onChange={() => f.handleChange(checked ? f.state.value.filter((x) => x !== cid) : [...f.state.value, cid])} />
                            <span className="truncate">{j.name || cid}</span>
                          </label>
                        )
                      })}
                    </div>
                  </FieldRow>
                )}</form.Field>
                <form.Field name="reasoning_effort">{(f) => (
                  <FieldRow label={m.cron_reasoning_effort_label()} hint={noAgent ? m.cron_reasoning_effort_no_agent_hint() : m.cron_reasoning_effort_hint()} htmlFor="cronEffort" inline>
                    <Select id="cronEffort" value={f.state.value} onValueChange={(v) => f.handleChange(v)} className="w-56 max-w-full" disabled={noAgent}>
                      <option value="">{m.cron_reasoning_effort_default()}</option>
                      {REASONING_EFFORTS.map((level) => <option key={level} value={level}>{level}</option>)}
                    </Select>
                  </FieldRow>
                )}</form.Field>
                {!isEdit && <form.Field name="repeat">{(f) => <FieldRow label={m.cron_repeat_label()} hint={m.cron_repeat_hint()} htmlFor="cronRepeat" inline><TextInput id="cronRepeat" inputMode="numeric" className="w-28" value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} placeholder={m.cron_repeat_placeholder()} /></FieldRow>}</form.Field>}
              </div>
            </details>
          </>
        )}</form.Subscribe>
        {error && <div role="alert" className="mt-4 text-sm text-error">{error}</div>}
        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={onCancel}>{m.cancel()}</Button>
          <Button variant="primary" type="submit">{m.save()}</Button>
        </div>
      </form>
    </HubPage>
  )
}
