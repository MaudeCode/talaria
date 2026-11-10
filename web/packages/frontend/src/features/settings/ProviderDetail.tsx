import { useState, type ReactElement } from 'react'
import { KeyRound, PanelLeft, Pencil, RefreshCw, Server, Trash2, Wrench } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { useDefaultModelChoice, useModelsQuery } from '../../app/queries'
import { useProviderQuotas, useSetSidebarQuotaPins, useSidebarQuotaPins } from '../../lib/useProviderQuotas'
import { ModelOptionContent } from '../../lib/modelEntry'
import { useLocale } from '../../i18n/useLocale'
import { formatPercent } from '../../i18n/units'
import { IconButton } from '../../ui/Button'
import { Mark } from '../../ui/Badge'
import { ConfirmDialog } from '../../ui/Dialog'
import { RowContextMenu, type RowAction } from '../../ui/Menu'
import { Switch } from '../../ui/Field'
import { Figure } from '../../ui/List'
import { Monogram } from '../../ui/Monogram'
import { ErrorState, LoadingState } from '../../ui/States'
import { quotaPaceWord, QuotaWindowMeter } from '../insights/ProviderQuotaRows'
import type { QuotaSource } from '../insights/QuotaMeter'
import { OAuthSignIn } from '../onboarding/OAuthSignIn'
import { OpenRouterCost } from './OpenRouterCost'
import { ProviderQuotaPace } from './ProviderQuotaPace'
import { LEVEL_TONE, ProviderKeyForm, ProvidersBack, ProviderStatus, QuotaSourceStatus, SelfHostedForm, useProviders, useProviderWrites, type Provider } from './ProvidersSection'
import { SETTINGS_PAGE, SETTINGS_TITLE, SettingAction, SettingRow, SettingsGroup, SettingsStats, type SettingsStat } from './SettingsGroup'
import { useSettingField } from './useSettingField'

/** The models a provider's page lists before its "more" disclosure. */
const MODELS_SHOWN = 5

/**
 * TAL-2135: one configured provider's own page: its figures, then Quota (with the sidebar pins), Spend, Sign-in and Models,
 * each only when the server sent something for it. Every value is a `/api/providers`, `/api/provider/quotas` or cost-history field.
 */
export function ProviderDetail({ id }: { id: string }) {
  const providers = useProviders()
  const { quotas, refresh } = useProviderQuotas()
  const back = <ProvidersBack />
  if (providers.isPending) return <LoadingState />
  if (providers.isError && !providers.data) return <ErrorState error={providers.error} onRetry={() => { void providers.refetch() }} />
  const p = providers.data.providers.find((row) => row.id === id)
  if (!p) return (
    <ErrorState>
      <div className="font-medium text-text">{m.providers_detail_not_found({ id })}</div>
      {back}
    </ErrorState>
  )
  const sources = quotas.data?.sources?.filter((s) => s.provider_id === id) ?? []
  const name = p.display_name ?? p.id
  const catalogUnavailable = providers.data.availability?.authoritative === false
  // The server's reason its provider or quota answer is last-known, as the list shows it.
  const notice = quotas.data?.availability?.unavailable_reason ?? providers.data.availability?.unavailable_reason
  return (
    <div className={SETTINGS_PAGE} data-section="providers" data-provider-detail={id}>
      <div className="flex flex-col gap-2">
        {back}
        <div className="flex min-w-0 items-center gap-3">
          <Monogram name={name} />
          <h1 className={`${SETTINGS_TITLE} truncate`}>{name}</h1>
          {p.is_active && <Mark>{m.providers_default()}</Mark>}
        </div>
      </div>
      {notice && <p role="status" className="text-xs text-muted">{notice}</p>}
      <ProviderFigures p={p} sources={sources} />
      {sources.length > 0 && <ProviderQuota sources={sources} pins={quotas.data} onRefresh={() => { void refresh() }} />}
      {p.id === 'openrouter' && p.has_key && <SettingsGroup id="spend" title={m.providers_group_spend()}><OpenRouterCost /></SettingsGroup>}
      <ProviderSignIn p={p} catalogUnavailable={catalogUnavailable} />
      <ProviderModels p={p} />
    </div>
  )
}

/** One figure per quota window (its remaining), the pace window's pace, and the model count; only the ones the provider has. */
function ProviderFigures({ p, sources }: { p: Provider; sources: QuotaSource[] }) {
  const locale = useLocale()
  const several = sources.length > 1
  const windows = sources.flatMap((s) => (s.windows ?? []).flatMap((w, i) => w.remaining_percent === null ? [] : [{
    id: `${s.source_id}-${String(i)}`, label: several ? `${s.account_label ?? s.source_id} · ${w.label}` : w.label,
    value: formatPercent(locale, w.remaining_percent), mode: m.providers_figure_left(), tone: LEVEL_TONE[w.display_level ?? 'healthy'],
  }]))
  const headline = sources.find((s) => s.provider_headline)
  const paced = headline?.pace_window_index == null ? undefined : headline.windows?.[headline.pace_window_index]
  const models = p.models_total ?? p.models?.length
  const stats: SettingsStat[] = [
    ...windows,
    ...(paced?.pace ? [{ id: 'pace', label: m.provider_quota_pace_label(), value: quotaPaceWord(paced.pace, locale), tone: LEVEL_TONE[paced.display_level ?? 'healthy'] }] : []),
    ...(models !== undefined ? [{ id: 'models', label: m.settings_section_models_title(), value: String(models) }] : []),
  ]
  return stats.length > 0 ? <SettingsStats label={p.display_name ?? p.id} stats={stats} /> : null
}

/** Quota: each window as a headline, meter and forecast, then one sidebar pin per source, at most the server's limit. */
function ProviderQuota({ sources, pins, onRefresh }: { sources: QuotaSource[]; pins: Parameters<typeof useSidebarQuotaPins>[0]; onRefresh: () => void }) {
  const locale = useLocale()
  const setPins = useSetSidebarQuotaPins()
  const { ids: pinned, canPin } = useSidebarQuotaPins(pins)
  const several = sources.length > 1
  return (
    <SettingsGroup id="quota" title={m.providers_group_quota()} action={<IconButton variant="ghost" label={m.providers_quota_refresh()} onClick={onRefresh}><RefreshCw aria-hidden="true" /></IconButton>}>
      {sources.map((s) => (s.windows?.length ?? 0) === 0
        ? <div key={s.source_id} className="py-3"><ProviderQuotaPace source={s} showAccount={several} /></div>
        : [
          // A plan's name, paused and credits status stay beside the windows its gauges became.
          s.plan_usage && <div key={`${s.source_id}-plan`} className="py-3"><ProviderQuotaPace source={s} showAccount={several} gauges={false} /></div>,
          // Last-confirmed windows say so in the server's words.
          s.status !== 'available' && <div key={`${s.source_id}-status`} className="py-3"><QuotaSourceStatus source={s} /></div>,
          ...(s.windows ?? []).map((w, i) => (
          <div key={`${s.source_id}-${String(i)}`} className="flex flex-col gap-1.5 py-3" data-quota-window={w.label} data-level={w.display_level}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-sm font-medium text-text">{several ? `${s.account_label ?? s.source_id} · ${w.label}` : w.label}</span>
              {w.remaining_percent !== null ? <Figure value={formatPercent(locale, w.remaining_percent)} mode={m.providers_figure_left()} tone={LEVEL_TONE[w.display_level ?? 'healthy']} /> : w.detail && <span className="text-xs text-muted">{w.detail}</span>}
            </div>
            <QuotaWindowMeter window={w} source={s} mode="remaining" locale={locale} />
          </div>
        ))])}
      {sources.map((s) => {
        const on = pinned.includes(s.source_id)
        const id = `providerSidebarQuota-${s.source_id}`
        const full = !on && !canPin
        return (
          <SettingRow key={s.source_id} label={several ? m.providers_show_named_in_sidebar({ name: s.display_name ?? s.source_id }) : m.providers_show_in_sidebar()} htmlFor={id} icon={PanelLeft}>
            <Switch id={id} checked={on} disabled={full} title={full ? m.settings_desc_sidebar_quotas() : undefined} onCheckedChange={(checked) => { setPins.mutate(checked ? [...pinned, s.source_id] : pinned.filter((p) => p !== s.source_id)) }} />
          </SettingRow>
        )
      })}
    </SettingsGroup>
  )
}

/** Sign-in: the credential with its state and a way to replace it, removal behind a confirm, OAuth and self-hosted setup. */
function ProviderSignIn({ p, catalogUnavailable }: { p: Provider; catalogUnavailable: boolean }) {
  const [editing, setEditing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const { saveKey, saveHosted, invalidate } = useProviderWrites({ onSaved: () => setEditing(false) })
  const name = p.display_name ?? p.id
  const keyed = !p.is_self_hosted && p.configurable !== false && !p.is_oauth
  const edit = p.is_self_hosted ? m.providers_self_hosted_setup() : p.has_key ? m.providers_key_replace() : m.providers_key_set()
  // One list for the credential rows' buttons and their right-click and long-press menu.
  const actions = [
    ...(keyed || p.is_self_hosted ? [{ label: edit, run: () => setEditing((v) => !v), icon: p.is_self_hosted ? Wrench : Pencil }] : []),
    ...(p.removable === true ? [{ label: m.providers_key_remove(), run: () => setRemoving(true), danger: true, icon: Trash2 }] : []),
  ] satisfies RowAction[]
  const withMenu = (row: ReactElement) => <RowContextMenu label={m.providers_row_menu()} actions={actions} trigger={row} />
  return (
    <SettingsGroup id="sign-in" title={m.providers_group_sign_in()}>
      {withMenu(<div><SettingAction label={p.is_self_hosted ? m.providers_endpoint() : keyed ? m.providers_api_key() : m.providers_account()} icon={p.is_self_hosted ? Server : KeyRound} detail={<ProviderStatus p={p} catalogUnavailable={catalogUnavailable} />}>
        {(keyed || p.is_self_hosted) && <IconButton variant="default" label={edit} aria-expanded={editing} onClick={() => setEditing((v) => !v)}>{p.is_self_hosted ? <Wrench aria-hidden="true" /> : <Pencil aria-hidden="true" />}</IconButton>}
      </SettingAction></div>)}
      {editing && p.is_self_hosted && <div className="py-2"><SelfHostedForm id={p.id} baseUrl={p.base_url ?? ''} saving={saveHosted.isPending} onSubmit={(body) => saveHosted.mutate({ id: p.id, name, ...body })} /></div>}
      {editing && keyed && <div className="py-2"><ProviderKeyForm label={m.providers_key_label({ provider: name })} hasKey={p.has_key === true} saving={saveKey.isPending} onSubmit={(key) => saveKey.mutate({ id: p.id, key })} /></div>}
      {p.removable === true && withMenu(
        <div><SettingAction label={m.providers_key_remove()} icon={Trash2}>
          <IconButton variant="danger" label={m.providers_key_remove()} onClick={() => setRemoving(true)}><Trash2 aria-hidden="true" /></IconButton>
        </SettingAction></div>,
      )}
      {p.id === 'nous' && <div className="py-2"><OAuthSignIn provider={p.id} label={name} signedIn={p.has_key === true} account={p.nous_account ?? null} accountError={p.nous_account_error ?? null} resultOnly compact idPrefix="providersNousOauth" onApproved={invalidate} /></div>}
      {p.device_login && <div className="py-2"><OAuthSignIn provider={p.id} label={name} signedIn={p.has_key === true} idPrefix={`providerOauth-${p.id}`} onApproved={invalidate} /></div>}
      <ConfirmDialog open={removing} onOpenChange={setRemoving} title={m.providers_key_remove_confirm_title({ provider: name })} description={m.providers_key_remove_confirm_body()} confirmLabel={m.providers_key_remove()} cancelLabel={m.cancel()} danger onConfirm={() => { saveKey.mutate({ id: p.id, key: null }) }} />
    </SettingsGroup>
  )
}

/** Models: the provider's models as a table with the default marked; the default itself changes on Settings › Models. */
function ProviderModels({ p }: { p: Provider }) {
  const [all, setAll] = useState(false)
  const { refreshModels } = useProviderWrites()
  const { str } = useSettingField(['default_model'])
  const choice = useDefaultModelChoice()
  // The server resolves which provider serves the default (`default_provider_id`); the same model id can sit on several providers.
  const catalog = useModelsQuery()
  const models = p.models ?? []
  if (models.length === 0) return null
  const defaultModel = choice ? choice.model : str('default_model')
  const defaultProvider = choice ? choice.provider : catalog.data?.default_provider_id ?? null
  const shown = all ? models : models.slice(0, MODELS_SHOWN)
  return (
    <SettingsGroup id="models" title={m.settings_section_models_title()} detail={p.models_total ?? models.length}
      action={<IconButton variant="ghost" label={m.providers_refresh_models()} disabled={refreshModels.isPending} onClick={() => refreshModels.mutate(p.id)}><RefreshCw aria-hidden="true" /></IconButton>}>
      <table className="w-full text-sm" data-provider-models={p.id}>
        <thead><tr><th scope="col" className="py-2 text-left text-xs font-normal text-muted">{m.providers_model_column()}</th></tr></thead>
        <tbody>
          {shown.map((mm) => (
            <tr key={mm.id} className="border-t border-border-subtle" data-provider-model={mm.id}>
              <td className="py-2.5">
                <span className="flex min-w-0 items-center gap-2 text-text"><ModelOptionContent entry={mm} />{mm.id === defaultModel && p.id === defaultProvider && <Mark>{m.providers_default()}</Mark>}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {models.length > MODELS_SHOWN && <button type="button" aria-expanded={all} className="self-start py-2 text-xs text-muted hover:text-text" onClick={() => setAll((v) => !v)}>{all ? m.providers_models_fewer() : m.providers_models_more({ n: models.length - MODELS_SHOWN })}</button>}
    </SettingsGroup>
  )
}
