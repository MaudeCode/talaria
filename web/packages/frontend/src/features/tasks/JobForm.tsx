/** Create / edit / duplicate form for one cron job, rendered in the main view. */
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useForm } from '@tanstack/react-form'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import type { CronBlueprint } from '@maudecode/talaria-web-contracts'
import { getStreamContext } from '../../stream/connection'
import type { CronJob } from '../../contracts'
import { HubPage } from '../../shell/AppShell'
import { Button } from '../../ui/Button'
import { Switch, FieldRow, TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { ErrorState, LoadingState } from '../../ui/States'
import { showToast } from '../toast/toast'
import { showErrorToast } from '../toast/errorToast'
import { cn } from '../../ui/cn'
import { useModelsQuery, useProfilesQuery } from '../../app/queries'
import { contextFromList, cronResource, jobId } from './cronJob'
import { newResource, useResourceMutation } from '../sessions/useResourceMutation'
import { catalogEntryById, catalogGroupLabel, ModelOptionContent, catalogModelSections } from '../../lib/modelEntry'

export type EditorMode = 'create' | 'edit' | 'duplicate'

// Canonical Hermes reasoning levels; cron.jobs validates the same grammar.
const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const FORM_ID = 'cronJobForm'

interface FormValues {
  name: string; schedule: string; prompt: string; script: string; no_agent: boolean; deliver: string; repeat: string; profile: string
  model: string; model_provider: string | null; toast_notifications: boolean; skills: string; monitor: string; continuity: boolean; context_from: string[]; reasoning_effort: string
}

interface JobWrite { resource: string; body: Record<string, unknown>; shown: Record<string, unknown> }
const cronReads = () => [keys.crons.list(false), keys.crons.list(true), keys.crons.status]
const showError = (e: unknown) => showErrorToast(e)

/** `onSubmitted` closes the editor on submit; `onCreated` names the job the server created. */
export function JobForm({ mode, job, jobs, onCancel, onSubmitted, onCreated }: { mode: EditorMode; job: CronJob | null; jobs: CronJob[]; onCancel: () => void; onSubmitted: (id?: string) => void; onCreated: (id?: string) => void }) {
  // The list shows the submitted job at once and adopts the server's normalized schedule and next run on its reread.
  const update = useResourceMutation({
    resource: ({ resource }: JobWrite) => resource, queryKey: keys.crons.all, readKeys: cronReads,
    effect: ({ shown }) => ({ fields: shown }),
    mutationFn: ({ body }) => api.cronAction('update', body),
    onSuccess: () => showToast(m.cron_job_updated()), onError: showError,
  })
  const create = useResourceMutation({
    resource: ({ resource }: JobWrite) => resource, queryKey: keys.crons.all, readKeys: cronReads, exclusive: true,
    effect: ({ resource, shown }) => ({ fields: { ...shown, id: resource, derived_state: 'active', resumable: false } }),
    mutationFn: ({ body }) => api.cronAction('create', body),
    onSuccess: (res) => { showToast(m.cron_job_created()); onCreated(res.job ? jobId(res.job) : res.job_id) },
    onError: showError,
  })
  const blueprints = useQuery({ queryKey: keys.crons.blueprints, queryFn: api.fetchCronBlueprints, enabled: mode === 'create', staleTime: 60_000 })
  const [choosingBlueprint, setChoosingBlueprint] = useState(false)
  const [blueprint, setBlueprint] = useState<CronBlueprint | null>(null)
  const [slotValues, setSlotValues] = useState<Record<string, string>>({})
  const isEdit = mode === 'edit'
  const profiles = useProfilesQuery()
  const models = useModelsQuery()
  const delivery = useQuery({ queryKey: keys.crons.deliveryOptions, queryFn: api.fetchCronDeliveryOptions, staleTime: 60_000 })
  const skills = useQuery({ queryKey: keys.skills.all, queryFn: () => api.fetchSkills(), staleTime: 60_000, enabled: !isEdit })
  const [error, setError] = useState<string | null>(null)
  const sourceId = job ? jobId(job) : ''
  const initialModel = job?.model_option_id ?? job?.model ?? ''
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
      schedule: job?.schedule_input ?? '',
      prompt: job?.prompt ?? '',
      script: job?.script ?? '',
      no_agent: !!job?.no_agent,
      deliver: job?.deliver ?? 'local',
      repeat: mode === 'duplicate' && repeatTimes != null ? String(repeatTimes) : '',
      profile: job?.profile ?? '',
      // The entry the server says the stored pair selects (else the stored model) until a pick replaces it.
      model: initialModel,
      model_provider: job?.provider ?? null,
      toast_notifications: job?.toast_notifications !== false,
      skills: job?.skills?.join(', ') ?? '',
      monitor: job?.monitor ?? '',
      continuity: !!job?.continuity,
      context_from: job ? contextFromList(job) : [],
      reasoning_effort: job?.reasoning_effort ?? '',
    } satisfies FormValues,
    onSubmit: ({ value }) => {
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
      // An untouched picker re-sends the stored pair; a pick sends its id and provider for the server to split.
      const untouched = v.model === initialModel
      const model = (untouched ? job?.model : v.model) || null
      const provider = model ? (untouched ? job?.provider ?? null : v.model_provider) : null
      // Shown in the list until the server's reread replaces it.
      const shown = { name: v.name, schedule_input: v.schedule, schedule_display: v.schedule, prompt: v.prompt, script: v.script, no_agent: v.no_agent, monitor: v.monitor, continuity: v.continuity, context_from: v.context_from, deliver: v.deliver || 'local', profile: v.profile, toast_notifications: v.toast_notifications, reasoning_effort: v.reasoning_effort || null,
        // A picked catalog entry shows as its bare model, as the server stores it.
        model: untouched ? model : catalogEntryById(models.data, v.model)?.bare_id ?? model, provider, model_option_id: untouched ? job?.model_option_id ?? null : v.model || null }
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
        update.mutate({ resource: cronResource(job), body, shown })
        onSubmitted(sourceId)
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
        create.mutate({ resource: newResource('cron'), body, shown })
        onSubmitted()
      }
    },
  })
  const fillBlueprint = useMutation({
    mutationFn: async () => {
      if (!blueprint) throw new Error(m.error_generic())
      const context = getStreamContext()
      const response = await api.fillCronBlueprint({ key: blueprint.key, values: slotValues })
      if (context !== getStreamContext()) throw new Error(m.error_generic())
      return response.draft
    },
    onSuccess: (draft) => {
      form.setFieldValue('name', draft.name)
      form.setFieldValue('prompt', draft.prompt)
      form.setFieldValue('schedule', draft.schedule)
      form.setFieldValue('deliver', draft.deliver)
      form.setFieldValue('skills', draft.skills.join(', '))
      setChoosingBlueprint(false)
      setError(null)
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
      actions={<><Button onClick={onCancel}>{m.cancel()}</Button><Button variant="primary" type="submit" form={FORM_ID} disabled={choosingBlueprint}>{m.save()}</Button></>}
    >
      <form id={FORM_ID} onSubmit={(e) => { e.preventDefault(); if (choosingBlueprint) { if (blueprint && !fillBlueprint.isPending) fillBlueprint.mutate() } else void form.handleSubmit() }} className="mx-auto max-w-2xl" aria-label={title}>
        {mode === 'create' && (choosingBlueprint || (blueprints.data?.blueprints.length ?? 0) > 0) && (
          <div className="mb-6">
            {!choosingBlueprint ? <Button onClick={() => { setChoosingBlueprint(true); setBlueprint(null); setSlotValues({}); fillBlueprint.reset() }}>{m.cron_blueprint_start()}</Button> : (
              <section aria-label={m.cron_blueprint_start()}>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h2 className="text-sm font-medium">{blueprint?.title ?? m.cron_blueprint_start()}</h2>
                  <Button disabled={fillBlueprint.isPending} onClick={() => { setChoosingBlueprint(false); setBlueprint(null); fillBlueprint.reset() }}>{m.cancel()}</Button>
                </div>
                {blueprint ? <>
                  {blueprint.slots.map((slot) => {
                    const id = `blueprint-${slot.name}`
                    return <FieldRow key={slot.name} label={slot.label} htmlFor={id} {...(slot.help ? { hint: slot.help } : {})}>
                      {slot.strict && slot.options.length > 0
                        ? <Select id={id} disabled={fillBlueprint.isPending} value={slotValues[slot.name] ?? ''} onValueChange={(value) => setSlotValues((v) => ({ ...v, [slot.name]: value }))}>
                            <option value="">—</option>{slot.options.map((option) => <option key={option} value={option}>{option}</option>)}
                          </Select>
                        : <><TextInput id={id} type={slot.type === 'time' ? 'time' : 'text'} disabled={fillBlueprint.isPending} list={slot.options.length ? `${id}-options` : undefined} value={slotValues[slot.name] ?? ''} onChange={(e) => setSlotValues((v) => ({ ...v, [slot.name]: e.target.value }))} />
                          {slot.options.length > 0 && <datalist id={`${id}-options`}>{slot.options.map((option) => <option key={option} value={option} />)}</datalist>}</>}
                    </FieldRow>
                  })}
                  {fillBlueprint.isError && <ErrorState error={fillBlueprint.error} />}
                  <div className="mt-3"><Button variant="primary" disabled={fillBlueprint.isPending} onClick={() => fillBlueprint.mutate()}>{m.cron_blueprint_use()}</Button></div>
                </> : <ul className="divide-y divide-border-subtle">
                  {blueprints.data?.blueprints.map((row) => <li key={row.key}>
                    <button type="button" className="w-full py-3 text-left hover:bg-hover" onClick={() => { setBlueprint(row); setSlotValues(Object.fromEntries(row.slots.flatMap((slot) => slot.default === null ? [] : [[slot.name, slot.default]]))); fillBlueprint.reset() }}>
                      <span className="flex flex-wrap items-baseline gap-x-3"><span className="text-sm font-medium">{row.title}</span>{row.plugin && <span className="text-xs text-muted">{row.plugin}</span>}</span>
                      <span className="block text-xs text-muted">{row.description}</span>
                      <span className="block text-xs text-muted">{row.schedule_label}</span>
                    </button>
                  </li>)}
                </ul>}
              </section>
            )}
          </div>
        )}
        <fieldset hidden={choosingBlueprint} disabled={choosingBlueprint} className="m-0 min-w-0 border-0 p-0">
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
                <form.Field name="model">{(f) => {
                  const selectedModel = catalogEntryById(models.data, f.state.value)
                  const listed = !!selectedModel && (models.data?.groups ?? []).some((g) => g.models.includes(selectedModel))
                  return (
                  <FieldRow label={m.cron_model_label()} hint={noAgent ? m.cron_model_no_agent_hint() : m.cron_model_hint()} htmlFor="cronModel" inline>
                    <Select id="cronModel" value={f.state.value} onValueChange={(v) => { form.setFieldValue('model_provider', catalogEntryById(models.data, v)?.provider_id ?? (v && v === initialModel ? job?.provider ?? null : null)); f.handleChange(v) }} className="w-56 max-w-full" disabled={noAgent}>
                      <option value="">{m.cron_model_use_default()}</option>
                      {(models.data?.groups ?? []).flatMap((g) => catalogModelSections(g).map((section) => (
                        <optgroup key={`${g.provider}:${section.label}`} label={[catalogGroupLabel(g), section.label].filter(Boolean).join(' · ')}>
                          {section.models.map((mm) => <option key={mm.id} value={mm.id}><ModelOptionContent entry={mm} /></option>)}
                        </optgroup>
                      )))}
                      {f.state.value && !listed && <option value={f.state.value}>{selectedModel?.label ?? f.state.value}</option>}
                    </Select>
                  </FieldRow>
                )
                }}</form.Field>
                <form.Field name="toast_notifications">{(f) => <FieldRow label={m.cron_toast_notifications_label()} hint={m.cron_toast_notifications_hint()} htmlFor="cronToast" inline><Switch id="cronToast" checked={f.state.value} onCheckedChange={(checked) => f.handleChange(checked)} /></FieldRow>}</form.Field>
              </div>
              <details className="mt-6" open={!!(job && (job.monitor || job.continuity || job.reasoning_effort || contextFromList(job).length))}>
                <summary className="cursor-pointer text-xs font-medium text-muted">{m.cron_advanced_label()}</summary>
                <div className={group}>
                  <form.Field name="monitor">{(f) => <FieldRow label={m.cron_monitor_label()} hint={noAgent ? m.cron_monitor_no_agent_hint() : m.cron_monitor_hint()} htmlFor="cronMonitor"><TextInput id="cronMonitor" value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} placeholder={m.cron_monitor_placeholder()} /></FieldRow>}</form.Field>
                  <form.Field name="continuity">{(f) => <FieldRow label={m.cron_continuity_label()} hint={m.cron_continuity_hint()} htmlFor="cronContinuity" inline><Switch id="cronContinuity" checked={f.state.value} onCheckedChange={(checked) => f.handleChange(checked)} disabled={noAgent} /></FieldRow>}</form.Field>
                  <form.Subscribe selector={(s) => s.values.profile}>{(profile) => (
                    <form.Field name="context_from">{(f) => (
                      <ContextSources profile={profile} editingId={isEdit ? sourceId : ''} excludeId={sourceId} selected={f.state.value} disabled={noAgent} onChange={f.handleChange} />
                    )}</form.Field>
                  )}</form.Subscribe>
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
        </fieldset>
      </form>
    </HubPage>
  )
}

function ContextSources({ profile, editingId, excludeId, selected, disabled, onChange }: { profile: string; editingId: string; excludeId: string; selected: string[]; disabled: boolean; onChange: (refs: string[]) => void }) {
  const choices = useQuery({
    queryKey: keys.crons.contextSources(profile, editingId, excludeId, selected),
    queryFn: () => api.fetchCronContextSources({ profile, ...(editingId ? { editing_job_id: editingId } : {}), ...(excludeId ? { exclude_job_id: excludeId } : {}), selected_refs: selected }),
    staleTime: 15_000,
  })
  return (
    <FieldRow label={m.cron_context_from_label()} hint={choices.data?.sources.length ? m.cron_context_from_hint() : m.cron_context_from_empty_hint()}>
      {choices.isPending ? <LoadingState /> : choices.isError ? <ErrorState error={choices.error} onRetry={() => { void choices.refetch() }} /> : (
        <div className="flex flex-col gap-1" role="group" aria-label={m.cron_context_from_label()}>
          {choices.data.sources.map((source) => {
            const checked = selected.includes(source.job_id)
            return (
              <label key={source.job_id} className="flex items-center gap-2 text-sm text-text">
                <input type="checkbox" checked={checked} disabled={disabled || (!source.selectable && !checked)} onChange={() => onChange(checked ? selected.filter((id) => id !== source.job_id) : [...selected, source.job_id])} />
                <span className="truncate">{source.label}{!source.selectable && <span className="text-muted"> · {m.not_available()}</span>}</span>
              </label>
            )
          })}
        </div>
      )}
    </FieldRow>
  )
}
