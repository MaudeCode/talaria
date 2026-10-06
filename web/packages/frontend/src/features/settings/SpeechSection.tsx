import { useEffect, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { Switch, FieldRow } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { LoadingState, ErrorState } from '../../ui/States'
import { readPersisted, writePersisted } from '../../lib/persisted'
import { useTtsEngines } from '../../extensions/registry'
import { TTS_PREF } from '../voice/tts'
import { useSettingField } from './useSettingField'

/** A device-local speech preference: `features/voice/tts.ts` reads it at speak time. */
function useDevicePref(key: string, fallback: string): [string, (value: string) => void] {
  const [value, setValue] = useState(() => readPersisted(key) ?? fallback)
  return [value, (next) => { writePersisted(key, next); setValue(next) }]
}

function useBrowserVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => ('speechSynthesis' in window ? window.speechSynthesis.getVoices() : []))
  useEffect(() => {
    if (!('speechSynthesis' in window)) return
    const update = () => setVoices(window.speechSynthesis.getVoices())
    window.speechSynthesis.addEventListener('voiceschanged', update)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', update)
  }, [])
  return voices
}

function Slider({ id, value, min, max, onChange, unit = '' }: { id: string; value: string; min: number; max: number; onChange: (value: string) => void; unit?: string }) {
  const n = Number.parseFloat(value)
  return (
    <span className="flex items-center gap-3">
      <input id={id} type="range" min={min} max={max} step={0.1} value={Number.isNaN(n) ? 1 : n} onChange={(e) => onChange(e.target.value)} className="w-40" />
      <output htmlFor={id} className="w-10 text-right text-xs tabular-nums text-muted">{(Number.isNaN(n) ? 1 : n).toFixed(1)}{unit}</output>
    </span>
  )
}

/** Read-aloud and auto-read are server settings; engine, voice, rate and pitch belong to this device. */
export function SpeechSection() {
  const { settings, bool, set } = useSettingField()
  const engines = useTtsEngines()
  const voices = useBrowserVoices()
  const [engine, setEngine] = useDevicePref(TTS_PREF.engine, 'browser')
  const [voice, setVoice] = useDevicePref(TTS_PREF.voice, '')
  const [rate, setRate] = useDevicePref(TTS_PREF.rate, '1')
  const [pitch, setPitch] = useDevicePref(TTS_PREF.pitch, '1')
  if (settings.isPending) return <LoadingState />
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => { void settings.refetch() }} />
  // An engine saved here whose extension has not registered yet stays selectable under its id.
  const missing = engine !== 'browser' && !engines.some((e) => e.id === engine)
  return (
    <div className="flex flex-col divide-y divide-border-subtle" data-section="speech">
      <FieldRow label={m.settings_label_tts()} htmlFor="settings-tts_enabled" hint={m.settings_desc_tts()} inline>
        <Switch id="settings-tts_enabled" checked={bool('tts_enabled')} onCheckedChange={(checked) => set({ tts_enabled: checked })} />
      </FieldRow>
      <FieldRow label={m.settings_label_tts_auto_read()} htmlFor="settings-tts_auto_read" hint={m.settings_desc_tts_auto_read()} inline>
        <Switch id="settings-tts_auto_read" checked={bool('tts_auto_read')} onCheckedChange={(checked) => set({ tts_auto_read: checked })} />
      </FieldRow>
      <FieldRow label={m.settings_label_tts_engine()} htmlFor="settingsTtsEngine" inline>
        <Select id="settingsTtsEngine" value={engine} onValueChange={setEngine}>
          <option value="browser">{m.settings_tts_engine_browser()}</option>
          {engines.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          {missing && <option value={engine}>{engine}</option>}
        </Select>
      </FieldRow>
      {engine === 'browser' && (
        <FieldRow label={m.settings_label_tts_voice()} htmlFor="settingsTtsVoice" hint={m.settings_desc_tts_voice()} inline>
          <Select id="settingsTtsVoice" className="max-w-56" value={voice} onValueChange={setVoice}>
            <option value="">{m.settings_tts_voice_default()}</option>
            {voices.map((v) => <option key={v.voiceURI} value={v.name}>{v.name}</option>)}
          </Select>
        </FieldRow>
      )}
      <FieldRow label={m.settings_label_tts_rate()} htmlFor="settingsTtsRate" inline>
        <Slider id="settingsTtsRate" value={rate} min={0.5} max={2} onChange={setRate} unit="×" />
      </FieldRow>
      <FieldRow label={m.settings_label_tts_pitch()} htmlFor="settingsTtsPitch" inline>
        <Slider id="settingsTtsPitch" value={pitch} min={0} max={2} onChange={setPitch} />
      </FieldRow>
    </div>
  )
}
