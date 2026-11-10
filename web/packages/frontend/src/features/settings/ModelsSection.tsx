import { Brain, Eye, Gauge, Pencil } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { IconButton } from '../../ui/Button'
import { Switch } from '../../ui/Field'
import { Segmented } from '../../ui/Segmented'
import { Select } from '../../ui/Select'
import { LoadingState, ErrorState } from '../../ui/States'
import { useModelsQuery, useSetDefaultModel, useAuxiliaryModelsQuery, useDefaultModelChoice } from '../../app/queries'
import { ModelPickerPopover, reasoningLevelLabel } from '../composer/chips'
import { PROFILE_REASONING, reasoningResource, useReasoningDisplayChoice, useReasoningQuery, useSetReasoningDisplay, useSetReasoningEffort } from '../composer/reasoning'
import { useResourceEffects } from '../sessions/useResourceMutation'
import { catalogEntryById } from '../../lib/modelEntry'
import { useSettingField } from './useSettingField'
import { AuxiliaryModelsSection } from './AuxiliaryModels'
import { SettingHeadline, SettingRow, SettingsGroup, SETTINGS_PAGE } from './SettingsRows'

/**
 * The main model as the page's headline (TAL-2137), changed through the composer's model picker, then, when its catalog
 * entry offers them, its speed tiers.
 */
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
  // A model the catalog does not list shows as its saved id, under the saved provider.
  const entry = catalogEntryById(models.data, chosen?.model ?? models.data?.default_option_id)
  const provider = (entry && models.data?.groups.find((g) => g.models.includes(entry))?.provider) ?? main?.provider ?? ''
  const name = entry ? entry.label ?? entry.id : chosen?.model ?? (str('default_model') || main?.model || '')
  if (settings.isPending) return <LoadingState compact />
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => { void settings.refetch() }} />
  return (
    <>
      <SettingHeadline monogram={provider || name} title={name || '—'} detail={provider} action={
        <ModelPickerPopover side="bottom" align="end" label={m.settings_label_model()} selectedId={entry?.id ?? ''} onPick={(model, provider) => { setDefault.mutate({ model, provider }) }}
          trigger={<IconButton id="settingsModel" variant="default" label={m.settings_model_change()}><Pencil aria-hidden="true" /></IconButton>} />
      } />
      {auxiliary.isError && <ErrorState error={auxiliary.error} onRetry={() => { void auxiliary.refetch() }} />}
      {!!mainModel && !!speedTiers?.length && (
        <SettingRow label={m.settings_model_speed()} hint={m.settings_model_speed_hint()} htmlFor="settingsModelSpeed" icon={Gauge}>
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
 * Each row shows only when the server says the main model supports it; `''` is the provider default. TAL-2137: up to
 * three server levels, which with Default fill a segmented control, show side by side; more fall back to a select.
 */
function ReasoningRows() {
  const status = useReasoningQuery().data
  const effortWrite = useSetReasoningEffort()
  const displayWrite = useSetReasoningDisplay()
  const effect = useResourceEffects<string | null>()[reasoningResource(PROFILE_REASONING)]
  const display = useReasoningDisplayChoice()
  if (!status) return null
  const effort = effect && 'value' in effect ? effect.value ?? '' : status.reasoning_effort ?? ''
  const levels = [{ value: '', label: m.reasoning_default() }, ...(status.supported_efforts ?? []).map((level) => ({ value: level, label: reasoningLevelLabel(level) }))]
  const setEffort = (level: string) => { effortWrite.mutate({ key: PROFILE_REASONING, level: level || null }) }
  return (
    <>
      {status.supports_reasoning_effort && (
        <SettingRow label={m.settings_reasoning_effort()} hint={m.settings_default_model_hint()} htmlFor="settingsReasoningEffort" icon={Brain}>
          {levels.length <= 4
            ? <Segmented id="settingsReasoningEffort" label={m.settings_reasoning_effort()} options={levels} value={effort} onChange={setEffort} />
            : <Select id="settingsReasoningEffort" value={effort} onValueChange={setEffort}>
              {levels.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>}
        </SettingRow>
      )}
      {status.supports_thinking_toggle && (
        <SettingRow label={m.settings_show_thinking()} htmlFor="settingsShowThinking" icon={Eye}>
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
      <SettingsGroup id="main-model" title={m.settings_group_main_model()} hint={m.settings_default_model_hint()}><MainModelRows /></SettingsGroup>
      <AuxiliaryModelsSection />
    </div>
  )
}
