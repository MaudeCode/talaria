import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useForm } from '@tanstack/react-form'
import { z } from 'zod'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { useOnboardingQuery } from '../../app/queries'
import type { OnboardingStatus } from '../../contracts'
import { Button } from '../../ui/Button'
import { TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { cn } from '../../ui/cn'
import { showToast } from '../toast/toast'
import { Toaster } from '../toast/Toaster'
import { useLocale } from '../../i18n/useLocale'
import { loadBootstrap } from '../../app/bootstrap'

const STEPS = ['system', 'setup', 'workspace', 'password', 'finish'] as const
type Step = (typeof STEPS)[number]

interface FormValues { provider: string; apiKey: string; baseUrl: string; workspace: string; model: string; password: string }
/** Provider entries may carry `requires_base_url` beyond the base schema. */
const ProviderExtra = z.looseObject({ requires_base_url: z.boolean().optional() })

function stepMeta(key: Step): { title: string; desc: string } {
  switch (key) {
    case 'system': return { title: m.onboarding_step_system_title(), desc: m.onboarding_step_system_desc() }
    case 'setup': return { title: m.onboarding_step_setup_title(), desc: m.onboarding_step_setup_desc() }
    case 'workspace': return { title: m.onboarding_step_workspace_title(), desc: m.onboarding_step_workspace_desc() }
    case 'password': return { title: m.onboarding_step_password_title(), desc: m.onboarding_step_password_desc() }
    case 'finish': return { title: m.onboarding_step_finish_title(), desc: m.onboarding_step_finish_desc() }
  }
}

type Notice = { text: string; kind: 'info' | 'success' | 'warn' } | null

function providerStatusLabel(system: NonNullable<OnboardingStatus['system']>): string {
  if (system.chat_ready) return m.onboarding_check_provider_ready()
  if (system.provider_configured) return m.onboarding_check_provider_partial()
  return m.onboarding_check_provider_pending()
}

export function OnboardingPage() {
  useLocale()
  const status = useOnboardingQuery()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [step, setStep] = useState(0)
  const [errorNotice, setErrorNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState(false)
  const data = status.data

  const providers = useMemo(() => data?.setup?.providers ?? [], [data])
  const workspaces = useMemo(() => data?.workspaces?.items ?? [], [data])

  const form = useForm({
    defaultValues: { provider: 'openrouter', apiKey: '', baseUrl: '', workspace: '', model: '', password: '' },
    onSubmit: async ({ value }) => {
      await finish(value)
    },
  })

  useEffect(() => {
    if (!data) return
    const current = data.setup?.current ?? {}
    form.setFieldValue('provider', current.provider ?? 'openrouter')
    form.setFieldValue('workspace', data.workspaces?.last ?? data.settings?.default_workspace ?? '')
    form.setFieldValue('model', data.settings?.default_model ?? current.model ?? '')
    form.setFieldValue('baseUrl', current.base_url ?? '')
    if (data.completed) void navigate({ to: '/' })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const key = STEPS[step] ?? 'system'
  const system = useMemo(() => data?.system ?? {}, [data])
  const settings = useMemo(() => data?.settings ?? {}, [data])

  const stepNotice = useMemo<Notice>(() => {
    if (!data) return null
    if (key === 'system') {
      const ok = !!system.chat_ready
      const fallback = ok ? m.onboarding_notice_system_ready() : m.onboarding_notice_system_unavailable()
      const note = system.provider_note === undefined || system.provider_note === '' ? fallback : system.provider_note
      return { text: note, kind: ok ? 'success' : system.hermes_found && system.imports_ok ? 'info' : 'warn' }
    }
    if (key === 'setup') return { text: system.chat_ready ? m.onboarding_notice_setup_already_ready() : m.onboarding_notice_setup_required(), kind: system.chat_ready ? 'success' : 'info' }
    if (key === 'workspace') return { text: m.onboarding_notice_workspace(), kind: 'info' }
    if (key === 'password') return { text: settings.password_enabled ? m.onboarding_notice_password_enabled() : m.onboarding_notice_password_recommended(), kind: settings.password_enabled ? 'success' : 'info' }
    return { text: m.onboarding_notice_finish(), kind: 'success' }
  }, [key, data, system, settings])
  const notice = errorNotice ?? stepNotice
  const setNotice = (n: Notice) => setErrorNotice(n)

  const selectedProvider = (id: string) => providers.find((p) => p.id === id) ?? null

  async function saveProviderSetup(v: FormValues) {
    const current = data?.setup?.current ?? {}
    const unchanged = current.provider === v.provider && (current.model ?? '') === v.model && (current.base_url ?? '') === v.baseUrl
    const currentIsOauth = !!data?.setup?.current_is_oauth
    if (unchanged && !v.apiKey && (system.chat_ready || currentIsOauth)) return
    const body: Record<string, unknown> = { provider: v.provider, model: v.model }
    if (v.apiKey) body.api_key = v.apiKey
    if (v.baseUrl) body.base_url = v.baseUrl
    await api.onboardingSetup(body)
  }

  async function saveDefaults(v: FormValues) {
    if (!v.workspace) throw new Error(m.onboarding_error_choose_workspace())
    if (!v.model) throw new Error(m.onboarding_error_choose_model())
    if (!workspaces.some((w) => w.path === v.workspace)) await api.addWorkspace(v.workspace)
    const body: Record<string, unknown> = { default_workspace: v.workspace }
    if (v.password) body._set_password = v.password
    await api.saveSettings(body)
  }

  async function finish(v: FormValues) {
    await saveProviderSetup(v)
    await saveDefaults(v)
    await api.onboardingComplete()
    showToast(m.onboarding_complete())
    await loadBootstrap()
    await qc.invalidateQueries()
    await navigate({ to: '/', search: { action: 'new-chat' } })
  }

  async function next() {
    setBusy(true)
    try {
      const v = form.state.values
      if (key === 'setup') {
        if (!v.provider) throw new Error(m.onboarding_error_provider_required())
        const raw = selectedProvider(v.provider)
        const extra = raw ? ProviderExtra.safeParse(raw) : null
        const requiresBaseUrl = !!(extra?.success && extra.data.requires_base_url)
        if ((v.provider === 'custom' || requiresBaseUrl) && !v.baseUrl) throw new Error(m.onboarding_error_base_url_required())
        if (requiresBaseUrl) {
          const probe = await api.onboardingProbe({ provider: v.provider, base_url: v.baseUrl, api_key: v.apiKey })
          if (!(probe.ok ?? probe.success)) throw new Error(probe.error ?? probe.message ?? m.onboarding_error_probe_failed())
        }
      }
      if (key === 'workspace') {
        if (!v.workspace) throw new Error(m.onboarding_error_workspace_required())
        if (!v.model) throw new Error(m.onboarding_error_model_required())
      }
      if (step === STEPS.length - 1) {
        await finish(v)
        return
      }
      setErrorNotice(null)
      setStep(step + 1)
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : String(e), kind: 'warn' })
    } finally {
      setBusy(false)
    }
  }

  async function skip() {
    try {
      await api.onboardingComplete()
      showToast(m.onboarding_skipped())
      await loadBootstrap()
      await navigate({ to: '/' })
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : String(e), kind: 'warn' })
    }
  }

  const modelChoices = useMemo(() => {
    const pid = form.state.values.provider
    const group = data?.models?.groups.find((g) => g.provider_id === pid || g.provider === pid)
    return group?.models.map((mm) => mm.id) ?? data?.models?.groups.flatMap((g) => g.models.map((mm) => mm.id)) ?? []
  }, [data, form.state.values.provider])

  return (
    <main className="onboarding-overlay flex min-h-full items-start justify-center overflow-y-auto bg-bg p-4 text-text md:items-center" id="onboardingOverlay">
      <div className="onboarding-card grid w-[min(1040px,100%)] gap-6 rounded-2xl border border-border bg-surface p-6 shadow-md md:grid-cols-[260px_1fr]">
        <aside>
          <div className="inline-flex rounded-full border border-border2 bg-surface-subtle px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted">{m.onboarding_badge()}</div>
          <h1 className="mt-3 text-xl font-semibold text-strong" id="onboardingTitle">{m.onboarding_title()}</h1>
          <p className="mt-2 text-sm text-muted" id="onboardingLead">{m.onboarding_lead()}</p>
          <ol className="mt-5 flex flex-col gap-2" id="onboardingSteps">
            {STEPS.map((s, idx) => {
              const meta = stepMeta(s)
              return (
                <li key={s} className={cn('onboarding-step flex gap-3 rounded-lg px-2 py-2', idx === step && 'active bg-accent-bg', idx < step && 'done opacity-70')} aria-current={idx === step ? 'step' : undefined}>
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-xs">{idx + 1}</div>
                  <div><div className="text-sm font-medium text-text">{meta.title}</div><div className="text-xs text-muted">{meta.desc}</div></div>
                </li>
              )
            })}
          </ol>
        </aside>
        <section className="flex min-w-0 flex-col">
          {notice && <div className={cn('mb-4 rounded-lg border px-3 py-2 text-sm', notice.kind === 'success' && 'border-success text-success', notice.kind === 'warn' && 'border-warning text-warning', notice.kind === 'info' && 'border-border text-muted')} role={notice.kind === 'warn' ? 'alert' : 'status'} id="onboardingNotice">{notice.text}</div>}
          {status.isPending && <p className="text-sm text-muted">{m.loading()}</p>}
          {status.isError && <p className="text-sm text-error" role="alert">{m.error_generic()}</p>}
          {data && (
            <form onSubmit={(e) => { e.preventDefault(); void next() }} className="flex min-h-[260px] flex-1 flex-col gap-3" id="onboardingBody" autoComplete="off">
              {key === 'system' && (
                <div className="grid gap-3 sm:grid-cols-3">
                  <Check ok={!!(system.hermes_found && system.imports_ok)} label={m.onboarding_check_agent()} value={system.hermes_found && system.imports_ok ? m.onboarding_check_agent_ready() : m.onboarding_check_agent_missing()} />
                  <Check ok={!!system.chat_ready} muted={!system.provider_configured} label={m.onboarding_check_provider()} value={providerStatusLabel(system)} />
                  <Check ok={!!settings.password_enabled} muted={!settings.password_enabled} label={m.onboarding_check_password()} value={settings.password_enabled ? m.onboarding_check_password_enabled() : m.onboarding_check_password_disabled()} />
                  <div className="onboarding-copy col-span-full text-sm text-muted">
                    <p><strong className="text-text">{m.onboarding_config_file()}</strong> {system.config_path ?? m.onboarding_unknown()}</p>
                    <p><strong className="text-text">{m.onboarding_env_file()}</strong> {system.env_path ?? m.onboarding_unknown()}</p>
                    {system.missing_modules && system.missing_modules.length > 0 && <p><strong className="text-text">{m.onboarding_missing_imports()}</strong> {system.missing_modules.join(', ')}</p>}
                  </div>
                </div>
              )}
              {key === 'setup' && (
                <>
                  <form.Field name="provider">
                    {(field) => (
                      <label className="onboarding-field flex flex-col gap-1 text-sm">
                        <span>{m.onboarding_provider_label()}</span>
                        <Select id="onboardingProviderSelect" value={field.state.value} onValueChange={(v) => field.handleChange(v)}>
                          {providers.map((p) => <option key={p.id} value={p.id}>{p.label ?? p.name ?? p.id}</option>)}
                          {providers.length === 0 && <option value={field.state.value}>{field.state.value}</option>}
                        </Select>
                      </label>
                    )}
                  </form.Field>
                  <form.Field name="apiKey">
                    {(field) => (
                      <label className="onboarding-field flex flex-col gap-1 text-sm">
                        <span>{m.onboarding_api_key_label()}</span>
                        <TextInput id="onboardingApiKeyInput" type="password" autoComplete="off" value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} placeholder={m.onboarding_api_key_placeholder()} />
                      </label>
                    )}
                  </form.Field>
                  <form.Field name="baseUrl">
                    {(field) => (
                      <label className="onboarding-field flex flex-col gap-1 text-sm">
                        <span>{m.onboarding_base_url_label()}</span>
                        <TextInput id="onboardingBaseUrlInput" value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} placeholder={m.onboarding_base_url_placeholder()} />
                      </label>
                    )}
                  </form.Field>
                  <p className="text-xs text-muted">{data.setup?.unsupported_note ?? ''}</p>
                </>
              )}
              {key === 'workspace' && (
                <>
                  <form.Field name="workspace">
                    {(field) => (
                      <>
                        <label className="onboarding-field flex flex-col gap-1 text-sm">
                          <span>{m.onboarding_workspace_label()}</span>
                          <Select id="onboardingWorkspaceSelect" value={workspaces.some((w) => w.path === field.state.value) ? field.state.value : ''} onValueChange={(v) => field.handleChange(v)}>
                            <option value="">—</option>
                            {workspaces.map((w) => <option key={w.path} value={w.path}>{w.name ?? w.path} — {w.path}</option>)}
                          </Select>
                        </label>
                        <label className="onboarding-field flex flex-col gap-1 text-sm">
                          <span>{m.onboarding_workspace_or_path()}</span>
                          <TextInput id="onboardingWorkspaceInput" value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} placeholder={m.onboarding_workspace_placeholder()} />
                        </label>
                      </>
                    )}
                  </form.Field>
                  <form.Field name="model">
                    {(field) => (
                      <label className="onboarding-field flex flex-col gap-1 text-sm">
                        <span>{m.onboarding_model_label()}</span>
                        <TextInput id="onboardingModelInput" list="onboardingModelChoices" value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />
                        <datalist id="onboardingModelChoices">{modelChoices.map((id) => <option key={id} value={id} />)}</datalist>
                      </label>
                    )}
                  </form.Field>
                </>
              )}
              {key === 'password' && (
                <form.Field name="password">
                  {(field) => (
                    <>
                      <label className="onboarding-field flex flex-col gap-1 text-sm">
                        <span>{m.onboarding_password_label()}</span>
                        <TextInput id="onboardingPasswordInput" type="password" autoComplete="new-password" value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} placeholder={m.onboarding_password_placeholder()} />
                      </label>
                      <p className="text-xs text-muted">{m.onboarding_password_help()}</p>
                    </>
                  )}
                </form.Field>
              )}
              {key === 'finish' && (
                <div className="onboarding-summary grid gap-2 text-sm">
                  <div><strong className="text-text">{m.onboarding_provider_label()}</strong> <span className="text-muted">{selectedProvider(form.state.values.provider)?.label ?? form.state.values.provider ?? m.onboarding_not_set()}</span></div>
                  <div><strong className="text-text">{m.onboarding_model_label()}</strong> <span className="text-muted">{form.state.values.model || m.onboarding_not_set()}</span></div>
                  <div><strong className="text-text">{m.onboarding_workspace_label()}</strong> <span className="text-muted">{form.state.values.workspace || m.onboarding_not_set()}</span></div>
                  <div><strong className="text-text">{m.onboarding_check_password()}</strong> <span className="text-muted">{form.state.values.password ? m.onboarding_password_summary_set() : settings.password_enabled ? m.onboarding_check_password_enabled() : m.onboarding_check_password_disabled()}</span></div>
                  <p className="text-xs text-muted">{m.onboarding_finish_help()}</p>
                </div>
              )}
              <div className="mt-auto flex items-center justify-between gap-2 pt-4">
                <Button variant="ghost" onClick={() => { void skip() }} id="onboardingSkipBtn">{m.onboarding_skip()}</Button>
                <div className="flex gap-2">
                  {step > 0 && <Button onClick={() => setStep(step - 1)} id="onboardingBackBtn">{m.onboarding_back()}</Button>}
                  <Button variant="primary" type="submit" disabled={busy} id="onboardingNextBtn">{key === 'finish' ? m.onboarding_open() : m.onboarding_continue()}</Button>
                </div>
              </div>
            </form>
          )}
        </section>
      </div>
      <Toaster />
    </main>
  )
}

function Check({ ok, muted, label, value }: { ok: boolean; muted?: boolean; label: string; value: string }) {
  return (
    <div className={cn('onboarding-check rounded-lg border px-3 py-2 text-sm', ok ? 'border-success' : muted ? 'border-border text-muted' : 'border-warning')}>
      <strong className="block text-text">{label}</strong>
      <span className="text-muted">{value}</span>
    </div>
  )
}
