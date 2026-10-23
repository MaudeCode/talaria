import { useEffect, useRef, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { Button } from '../../ui/Button'
import { FieldRow, Switch, TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { audioPreferences, saveAudioPreferences, previewSound, readLocalAudio, SOUND_CHOICES, type AudioPreferences } from '../voice/completionAudio'

/** Audio integration has device-local bytes and quiet hours; the existing server Toggle cannot own them. */
export function CompletionAudioSettings() {
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
  return <div className="flex flex-col divide-y divide-border-subtle">
    <FieldRow label={m.settings_audio_sound()} hint={m.settings_audio_device()} htmlFor="completionSound">
      <div className="flex flex-wrap items-center gap-2">
        <Select id="completionSound" value={preferences.sound} onValueChange={(sound) => change({ sound: sound as AudioPreferences['sound'] })}>{options}</Select>
        <Button onClick={() => { void previewSound(preferences).catch(() => setError(m.settings_audio_error())) }}>{m.settings_audio_preview()}</Button>
      </div>
    </FieldRow>
    <FieldRow label={m.settings_audio_volume()} htmlFor="completionVolume" inline>
      <input id="completionVolume" className="w-32 accent-accent" type="range" min="0" max="1" step="0.05" value={preferences.volume} onChange={(e) => change({ volume: Number(e.target.value) })} />
    </FieldRow>
    {(preferences.sound === 'custom' || preferences.quietSound === 'custom') && <FieldRow label={m.settings_audio_file()} hint={m.settings_audio_file_hint()} htmlFor="completionFile">
      <div className="flex flex-wrap items-center gap-2">
        <input id="completionFile" className="min-w-0 max-w-full text-sm" type="file" accept="audio/wav,audio/mpeg,audio/ogg,audio/mp4,audio/webm" onChange={(e) => {
          const file = e.target.files?.[0]
          const generation = ++fileGeneration.current
          if (file) void readLocalAudio(file).then((custom) => { if (generation === fileGeneration.current) change({ custom }) }, () => { if (generation === fileGeneration.current) setError(m.settings_audio_invalid()) })
          e.target.value = ''
        }} />
        {preferences.custom && <Button onClick={() => { fileGeneration.current++; change({ custom: null }) }}>{m.settings_audio_remove()}</Button>}
      </div>
    </FieldRow>}
    <FieldRow label={m.settings_audio_quiet()} htmlFor="completionQuiet" inline><Switch id="completionQuiet" checked={preferences.quiet} onCheckedChange={(quiet) => change({ quiet })} /></FieldRow>
    {preferences.quiet && <>
      <FieldRow label={m.settings_audio_start()} htmlFor="completionStart" inline><TextInput id="completionStart" type="time" value={preferences.start} onChange={(e) => { if (e.target.value) change({ start: e.target.value }) }} /></FieldRow>
      <FieldRow label={m.settings_audio_end()} htmlFor="completionEnd" inline><TextInput id="completionEnd" type="time" value={preferences.end} onChange={(e) => { if (e.target.value) change({ end: e.target.value }) }} /></FieldRow>
      <FieldRow label={m.settings_audio_quiet_sound()} htmlFor="completionQuietSound" inline><Select id="completionQuietSound" value={preferences.quietSound} onValueChange={(quietSound) => change({ quietSound: quietSound as AudioPreferences['quietSound'] })}>{options}</Select></FieldRow>
    </>}
    {error && <p role="alert" className="py-2 text-sm text-danger">{error}</p>}
  </div>
}
