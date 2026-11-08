import { m } from '../../paraglide/messages.js'
import { FieldRow } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { LoadingState, ErrorState } from '../../ui/States'
import { useModelsQuery, useSetDefaultModel, useAuxiliaryModelsQuery, useDefaultModelChoice } from '../../app/queries'
import { catalogEntryById, catalogGroupLabel, ModelOptionContent, catalogModelSections } from '../../lib/modelEntry'
import { useSettingField } from './useSettingField'
import { ProvidersSection } from './ProvidersSection'
import { AuxiliaryModelsSection } from './AuxiliaryModels'
import { QuotaThresholdsForm } from './QuotaThresholds'
import { SettingsGroup } from './SettingsRows'

/** The main model and, when its catalog entry offers them, its speed tiers. */
function MainModelRows() {
  const { settings, str } = useSettingField(['default_model'])
  const models = useModelsQuery()
  const setDefault = useSetDefaultModel()
  const chosen = useDefaultModelChoice()
  const auxiliary = useAuxiliaryModelsQuery()
  const main = auxiliary.data?.main
  const mainModel = chosen?.model ?? main?.model
  // A chosen model offers its own catalog speed tiers until the reread brings the server's main-model state.
  const speedTiers = chosen ? catalogEntryById(models.data, chosen.model)?.supported_speed_tiers : main?.supported_speed_tiers
  const defaultEntry = catalogEntryById(models.data, models.data?.default_option_id)
  const defaultListed = !!defaultEntry && (models.data?.groups ?? []).some((g) => g.models.includes(defaultEntry))
  if (settings.isPending) return <LoadingState compact />
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => { void settings.refetch() }} />
  return (
    <>
      <FieldRow label={m.settings_label_model()} hint={m.settings_default_model_hint()} htmlFor="settingsModel" inline>
        <Select id="settingsModel" value={chosen?.model ?? defaultEntry?.id ?? str('default_model')} onValueChange={(v) => { setDefault.mutate({ model: v, provider: catalogEntryById(models.data, v)?.provider_id ?? null }) }}>
          {(models.data?.groups ?? []).flatMap((g) => catalogModelSections(g).map((section) => (
            <optgroup key={`${g.provider}:${section.label}`} label={[catalogGroupLabel(g), section.label].filter(Boolean).join(' · ')}>
              {section.models.map((mm) => <option key={mm.id} value={mm.id}><ModelOptionContent entry={mm} /></option>)}
            </optgroup>
          )))}
          {!defaultListed && str('default_model') && <option value={defaultEntry?.id ?? str('default_model')}>{defaultEntry?.label ?? str('default_model')}</option>}
        </Select>
      </FieldRow>
      {auxiliary.isError && <ErrorState error={auxiliary.error} onRetry={() => { void auxiliary.refetch() }} />}
      {!!mainModel && !!speedTiers?.length && (
        <FieldRow label={m.settings_model_speed()} hint={m.settings_model_speed_hint()} htmlFor="settingsModelSpeed" inline>
          <Select id="settingsModelSpeed" value={chosen?.service_tier ?? (chosen ? speedTiers[0]?.service_tier : main?.service_tier)} onValueChange={(service_tier) => {
            setDefault.mutate({ model: mainModel, provider: chosen ? chosen.provider : main?.provider ?? null, advanced: { service_tier } })
          }}>
            {speedTiers.map((tier) => <option key={tier.id} value={tier.service_tier}>{tier.id === 'standard' ? m.settings_model_speed_standard() : tier.id === 'ultrafast' ? m.settings_model_speed_ultrafast() : m.settings_model_speed_fast()}</option>)}
          </Select>
        </FieldRow>
      )}
    </>
  )
}

/**
 * TAL-1691: Settings > Models & Providers. The main and auxiliary models come first, as the choices made most often; the
 * provider list, one row per provider the Agent knows, follows with its quota thresholds.
 */
export function ModelsSection() {
  return (
    <div className="flex flex-col gap-7" data-section="models">
      <SettingsGroup id="main-model" title={m.settings_group_main_model()}><MainModelRows /></SettingsGroup>
      <SettingsGroup id="auxiliary" title={m.settings_label_auxiliary_models()}><AuxiliaryModelsSection /></SettingsGroup>
      <SettingsGroup id="providers" title={m.settings_section_providers_title()}><ProvidersSection /></SettingsGroup>
      <QuotaThresholdsForm />
    </div>
  )
}
