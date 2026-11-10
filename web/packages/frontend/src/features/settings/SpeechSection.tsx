import { useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AudioWaveform, Cpu, Gauge, MicVocal, Play, Repeat, Square, Volume2 } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { Slider } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { Segmented } from '../../ui/Segmented'
import { IconButton } from '../../ui/Button'
import { LoadingState, ErrorState } from '../../ui/States'
import { readPersisted, writePersisted } from '../../lib/persisted'
import { useTtsEngines } from '../../extensions/registry'
import { HubHeadSlotsContext } from '../../shell/AppShell'
import { speak, stopSpeaking, TTS_PREF } from '../voice/tts'
import { useSettingField } from './useSettingField'
import { SettingRow, SettingToggle, SettingsGroup, SETTINGS_PAGE } from './SettingsRows'

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

/**
 * TAL-2146: the page heading's "Play a sample": one short sentence through the function that reads replies aloud, so it
 * uses the engine, voice, speed and pitch saved on this page. A second press stops it; leaving the page stops it too.
 */
function SampleButton() {
  const slots = useContext(HubHeadSlotsContext)
  const [playing, setPlaying] = useState(false)
  /** The playing sample's number, 0 while none plays; an older sample's end never resets a newer one. */
  const sample = useRef(0)
  const runs = useRef(0)
  useEffect(() => () => { if (sample.current) stopSpeaking() }, [])
  const toggle = () => {
    if (sample.current) { sample.current = 0; setPlaying(false); stopSpeaking(); return }
    const id = ++runs.current
    const end = () => { if (sample.current === id) { sample.current = 0; setPlaying(false) } }
    sample.current = id
    setPlaying(true)
    void speak(m.settings_tts_sample_text(), end).catch(end)
  }
  const button = (
    <IconButton variant="ghost" label={playing ? m.settings_tts_sample_stop() : m.settings_tts_sample_play()} active={playing} onClick={toggle} data-speech-sample="">
      {playing ? <Square aria-hidden="true" /> : <Play aria-hidden="true" />}
    </IconButton>
  )
  return slots?.actions ? createPortal(button, slots.actions) : null
}

/** Read-aloud and auto-read are server settings; engine, voice, rate and pitch belong to this device. */
export function SpeechSection() {
  const { settings } = useSettingField(['tts_enabled', 'tts_auto_read'])
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
  const engineOptions = [{ value: 'browser', label: m.settings_tts_engine_browser() }, ...engines.map((e) => ({ value: e.id, label: e.label })), ...(missing ? [{ value: engine, label: engine }] : [])]
  return (
    <div className={SETTINGS_PAGE} data-section="speech">
      <SampleButton />
      <SettingsGroup id="read-aloud" title={m.settings_group_read_aloud()}>
        <SettingToggle label={m.settings_label_tts()} settingKey="tts_enabled" hint={m.settings_desc_tts()} icon={Volume2} />
        <SettingToggle label={m.settings_label_tts_auto_read()} settingKey="tts_auto_read" hint={m.settings_desc_tts_auto_read()} icon={Repeat} />
      </SettingsGroup>
      <SettingsGroup id="voice-device" title={m.settings_group_voice_device()}>
        <SettingRow label={m.settings_label_tts_engine()} htmlFor="settingsTtsEngine" icon={Cpu}>
          {/* §12: three engines or fewer side by side, more in a select. */}
          {engineOptions.length <= 3
            ? <Segmented id="settingsTtsEngine" label={m.settings_label_tts_engine()} options={engineOptions} value={engine} onChange={setEngine} />
            : <Select id="settingsTtsEngine" value={engine} onValueChange={setEngine}>{engineOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>}
        </SettingRow>
        {engine === 'browser' && (
          <SettingRow label={m.settings_label_tts_voice()} htmlFor="settingsTtsVoice" hint={m.settings_desc_tts_voice()} icon={MicVocal}>
            <Select id="settingsTtsVoice" className="max-w-56" value={voice} onValueChange={setVoice}>
              <option value="">{m.settings_tts_voice_default()}</option>
              {voices.map((v) => <option key={v.voiceURI} value={v.name}>{v.name}</option>)}
            </Select>
          </SettingRow>
        )}
        <SettingRow label={m.settings_label_tts_rate()} htmlFor="settingsTtsRate" icon={Gauge}>
          <Slider id="settingsTtsRate" value={rate} min={0.5} max={2} onChange={setRate} format={(n) => `${n.toFixed(1)}×`} />
        </SettingRow>
        <SettingRow label={m.settings_label_tts_pitch()} htmlFor="settingsTtsPitch" icon={AudioWaveform}>
          <Slider id="settingsTtsPitch" value={pitch} min={0} max={2} onChange={setPitch} />
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}
