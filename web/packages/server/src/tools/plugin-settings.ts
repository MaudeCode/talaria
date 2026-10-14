/**
 * TAL-806: checks a Settings save of an Agent plugin's manifest-declared settings against the field list the sidecar
 * reported (`plugins.settings`). Non-secret values are normalized to the field type and kept only when they change;
 * secrets map to the field's `.env` name, so a client can never name the variable it writes.
 */
import { isDeepStrictEqual } from 'node:util'
import type { PluginSettingField } from '@maudecode/talaria-web-contracts'

export class PluginSettingsInvalid extends Error {}

/** One form value as the Agent stores it: numbers and JSON arrive as the text the user typed. */
export function normalizePluginSetting(field: PluginSettingField, raw: unknown): unknown {
  switch (field.type) {
    case 'string':
      if (typeof raw === 'string') return raw
      break
    case 'enum':
      if (typeof raw === 'string' && (field.choices ?? []).includes(raw)) return raw
      throw new PluginSettingsInvalid(`${field.label} must be one of: ${(field.choices ?? []).join(', ')}`)
    case 'boolean':
      if (typeof raw === 'boolean') return raw
      break
    case 'number': {
      const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw.trim()) : Number.NaN
      if (Number.isFinite(value)) return value
      break
    }
    case 'json': {
      let value: unknown = raw
      if (typeof raw === 'string') {
        try { value = JSON.parse(raw) } catch { throw new PluginSettingsInvalid(`${field.label} must be valid JSON`) }
      }
      if (value !== null && typeof value === 'object') return value
      throw new PluginSettingsInvalid(`${field.label} must be a JSON list or object`)
    }
    case 'secret':
      throw new PluginSettingsInvalid(`${field.label} is a secret; send it in secrets`)
  }
  throw new PluginSettingsInvalid(`${field.label} must be a ${field.type}`)
}

export interface PluginSettingsPlan {
  /** Changed non-secret values for `plugins.settings_save`. */
  values: Record<string, unknown>
  /** `.env` name → value for each secret field being set, or null to remove it. */
  secrets: Record<string, string | null>
}

export function planPluginSettings(fields: PluginSettingField[], values: Record<string, unknown>, secrets: Record<string, string>): PluginSettingsPlan {
  const byKey = new Map(fields.map((field) => [field.key, field]))
  const declared = (key: string): PluginSettingField => {
    const field = byKey.get(key)
    if (!field) throw new PluginSettingsInvalid(`'${key}' is not a setting this plugin declares`)
    return field
  }
  const plan: PluginSettingsPlan = { values: {}, secrets: {} }
  for (const [key, raw] of Object.entries(values)) {
    const field = declared(key)
    const value = normalizePluginSetting(field, raw)
    if (!isDeepStrictEqual(value, field.value)) plan.values[key] = value
  }
  for (const [key, raw] of Object.entries(secrets)) {
    const field = declared(key)
    const value = raw.trim()
    if (field.type !== 'secret' || !field.env) throw new PluginSettingsInvalid(`'${key}' is not a secret setting`)
    // An emptied field clears the stored secret; there is nothing to clear when none is stored.
    if (value || field.has_value) plan.secrets[field.env] = value || null
  }
  return plan
}

// One save at a time: each holds its field lookup, `.env` snapshot, writes and rollback, so a failed save can only restore
// values no later save has written yet.
// ponytail: one process-wide chain; per-plugin chains only if saves ever contend for throughput.
let saves: Promise<unknown> = Promise.resolve()

export function serializePluginSettingsSave<T>(save: () => Promise<T>): Promise<T> {
  const run = saves.then(save)
  saves = run.catch(() => undefined)
  return run
}
