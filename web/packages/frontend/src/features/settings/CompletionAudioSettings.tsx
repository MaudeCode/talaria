import { useEffect, useRef, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { FileAudio, Moon, Music, Play, Trash2, Volume1 } from 'lucide-react'
import { IconButton } from '../../ui/Button'
import { Slider, Switch, TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { useLocale } from '../../i18n/useLocale'
import { audioPreferences, saveAudioPreferences, previewSound, readLocalAudio, SOUND_CHOICES, type AudioPreferences } from '../voice/completionAudio'
import { SettingRow } from './SettingsGroup'

/** A saved `HH:MM` in the reader's clock (10:00 PM, 22:00). */
const clock = (locale: string, hhmm: string) => {
  const [h = 0, min = 0] = hhmm.split(':').map(Number)
  return new Date(2000, 0, 1, h, min).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
}

/** Audio integration has device-local bytes and quiet hours; the existing server Toggle cannot own them. */
export function CompletionAudioSettings() {
  const locale = useLocale()
  const [preferences, setPreferences] = useState(audioPreferences)
  const [error, setError] = useState('')
  const fileGeneration = useRef(0)
  useEffect(() => () => { fileGeneration.current++ }, [])
  const change = (patch: Partial<AudioPreferences>) => {
    try {
      const next = { ...audioPreferences(), ...patch }
      saveAudioPreferences(next)
      setPreferences(next)
      setError('')
    } catch { setError(m.settings_audio_error()) }
  }
  const labels = { none: m.settings_audio_none(), chime: m.settings_audio_chime(), bell: m.settings_audio_bell(), tap: m.settings_audio_tap(), custom: m.settings_audio_custom() }
  const options = SOUND_CHOICES.map((sound) => <option key={sound} value={sound}>{labels[sound]}</option>)
  return <>
    <SettingRow label={m.settings_audio_sound()} hint={m.settings_audio_device()} htmlFor="completionSound" icon={Music}>
      <div className="flex items-center gap-2">
        <IconButton variant="ghost" label={m.settings_audio_preview()} onClick={() => { void previewSound(preferences).catch(() => setError(m.settings_audio_error())) }}><Play aria-hidden="true" /></IconButton>
        <Select id="completionSound" value={preferences.sound} onValueChange={(sound) => change({ sound: sound as AudioPreferences['sound'] })}>{options}</Select>
      </div>
    </SettingRow>
    <SettingRow label={m.settings_audio_volume()} htmlFor="completionVolume" icon={Volume1}>
      <Slider id="completionVolume" value={String(preferences.volume)} min={0} max={1} step={0.05} format={(n) => `${Math.round(n * 100)}%`} onChange={(volume) => change({ volume: Number(volume) })} />
    </SettingRow>
    {(preferences.sound === 'custom' || preferences.quietSound === 'custom') && <SettingRow label={m.settings_audio_file()} hint={m.settings_audio_file_hint()} htmlFor="completionFile" icon={FileAudio} stacked>
      <div className="flex flex-wrap items-center gap-2">
        <input id="completionFile" className="min-w-0 max-w-full text-sm" type="file" accept="audio/wav,audio/mpeg,audio/ogg,audio/mp4,audio/webm" onChange={(e) => {
          const file = e.target.files?.[0]
          const generation = ++fileGeneration.current
          if (file) void readLocalAudio(file).then((custom) => { if (generation === fileGeneration.current) change({ custom }) }, () => { if (generation === fileGeneration.current) setError(m.settings_audio_invalid()) })
          e.target.value = ''
        }} />
        {preferences.custom && <IconButton variant="danger" label={m.settings_audio_remove()} onClick={() => { fileGeneration.current++; change({ custom: null }) }}><Trash2 aria-hidden="true" /></IconButton>}
      </div>
    </SettingRow>}
    <SettingRow label={m.settings_audio_quiet()} htmlFor="completionQuiet" icon={Moon}>
      <div className="flex items-center gap-3">
        {preferences.quiet && <span className="text-xs tabular-nums text-muted" data-quiet-range="">{m.settings_audio_quiet_range({ start: clock(locale, preferences.start), end: clock(locale, preferences.end) })}</span>}
        <Switch id="completionQuiet" checked={preferences.quiet} onCheckedChange={(quiet) => change({ quiet })} />
      </div>
    </SettingRow>
    {preferences.quiet && <>
      <SettingRow label={m.settings_audio_start()} htmlFor="completionStart"><TextInput id="completionStart" type="time" value={preferences.start} onChange={(e) => { if (e.target.value) change({ start: e.target.value }) }} /></SettingRow>
      <SettingRow label={m.settings_audio_end()} htmlFor="completionEnd"><TextInput id="completionEnd" type="time" value={preferences.end} onChange={(e) => { if (e.target.value) change({ end: e.target.value }) }} /></SettingRow>
      <SettingRow label={m.settings_audio_quiet_sound()} htmlFor="completionQuietSound"><Select id="completionQuietSound" value={preferences.quietSound} onValueChange={(quietSound) => change({ quietSound: quietSound as AudioPreferences['quietSound'] })}>{options}</Select></SettingRow>
    </>}
    {error && <p role="alert" className="py-2 text-sm text-danger">{error}</p>}
  </>
}
