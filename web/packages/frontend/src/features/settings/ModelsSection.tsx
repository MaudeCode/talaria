import { m } from '../../paraglide/messages.js'
import { Switch } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { LoadingState, ErrorState } from '../../ui/States'
import { useModelsQuery, useSetDefaultModel, useAuxiliaryModelsQuery, useDefaultModelChoice } from '../../app/queries'
import { reasoningLevelLabel } from '../composer/chips'
import { PROFILE_REASONING, reasoningResource, useReasoningDisplayChoice, useReasoningQuery, useSetReasoningDisplay, useSetReasoningEffort } from '../composer/reasoning'
import { useResourceEffects } from '../sessions/useResourceMutation'
import { catalogEntryById } from '../../lib/modelEntry'
import { catalogModelOptgroups } from '../../lib/modelOptgroups'
import { useSettingField } from './useSettingField'
import { AuxiliaryModelsSection } from './AuxiliaryModels'
import { SettingRow, SettingsGroup, SETTINGS_PAGE } from './SettingsRows'

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
      <SettingRow label={m.settings_label_model()} hint={m.settings_default_model_hint()} htmlFor="settingsModel">
        <Select id="settingsModel" value={chosen?.model ?? defaultEntry?.id ?? str('default_model')} onValueChange={(v) => { setDefault.mutate({ model: v, provider: catalogEntryById(models.data, v)?.provider_id ?? null }) }}>
          {catalogModelOptgroups(models.data)}
          {!defaultListed && str('default_model') && <option value={defaultEntry?.id ?? str('default_model')}>{defaultEntry?.label ?? str('default_model')}</option>}
        </Select>
      </SettingRow>
      {auxiliary.isError && <ErrorState error={auxiliary.error} onRetry={() => { void auxiliary.refetch() }} />}
      {!!mainModel && !!speedTiers?.length && (
        <SettingRow label={m.settings_model_speed()} hint={m.settings_model_speed_hint()} htmlFor="settingsModelSpeed">
          <Select id="settingsModelSpeed" value={chosen?.service_tier ?? (chosen ? speedTiers[0]?.service_tier : main?.service_tier)} onValueChange={(service_tier) => {
            setDefault.mutate({ model: mainModel, provider: chosen ? chosen.provider : main?.provider ?? null, advanced: { service_tier } })
          }}>
            {speedTiers.map((tier) => <option key={tier.id} value={tier.service_tier}>{tier.id === 'standard' ? m.settings_model_speed_standard() : tier.id === 'ultrafast' ? m.settings_model_speed_ultrafast() : m.settings_model_speed_fast()}</option>)}
          </Select>
        </SettingRow>
      )}
      <ReasoningRows />
    </>
  )
}

/**
 * TAL-2078: the profile's default effort and whether thinking shows, through the composer chip's query and write owners.
 * Each row shows only when the server says the main model supports it; `''` is the provider default.
 */
function ReasoningRows() {
  const status = useReasoningQuery().data
  const effortWrite = useSetReasoningEffort()
  const displayWrite = useSetReasoningDisplay()
  const effect = useResourceEffects<string | null>()[reasoningResource(PROFILE_REASONING)]
  const display = useReasoningDisplayChoice()
  if (!status) return null
  const effort = effect && 'value' in effect ? effect.value ?? '' : status.reasoning_effort ?? ''
  return (
    <>
      {status.supports_reasoning_effort && (
        <SettingRow label={m.settings_reasoning_effort()} hint={m.settings_default_model_hint()} htmlFor="settingsReasoningEffort">
          <Select id="settingsReasoningEffort" value={effort} onValueChange={(level) => { effortWrite.mutate({ key: PROFILE_REASONING, level: level || null }) }}>
            <option value="">{m.reasoning_default()}</option>
            {(status.supported_efforts ?? []).map((level) => <option key={level} value={level}>{reasoningLevelLabel(level)}</option>)}
          </Select>
        </SettingRow>
      )}
      {status.supports_thinking_toggle && (
        <SettingRow label={m.settings_show_thinking()} htmlFor="settingsShowThinking">
          <Switch id="settingsShowThinking" checked={display ? display === 'show' : status.show_reasoning !== false} onCheckedChange={(checked) => { displayWrite.mutate(checked ? 'show' : 'hide') }} />
        </SettingRow>
      )}
    </>
  )
}

/** TAL-1691, TAL-2100: Settings > Models, the active profile's main and auxiliary models. */
export function ModelsSection() {
  return (
    <div className={SETTINGS_PAGE} data-section="models">
      <SettingsGroup id="main-model" title={m.settings_group_main_model()}><MainModelRows /></SettingsGroup>
      <SettingsGroup id="auxiliary" title={m.settings_label_auxiliary_models()}><AuxiliaryModelsSection /></SettingsGroup>
    </div>
  )
}
