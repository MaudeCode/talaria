import { useSaveSettings, useSettingsQuery } from '../../app/queries'
import { useSettingIntents } from '../../app/settings'
import { showErrorToast } from '../toast/errorToast'
import { m } from '../../paraglide/messages.js'
import { getStreamContext } from '../../stream/connection'

/** Read confirmed settings with the shared, presentation-only pending field overlay. */
export function useSettingField(fields: readonly string[]) {
  const settings = useSettingsQuery(fields)
  const save = useSaveSettings()
  const setAsync = (patch: Record<string, unknown>, onSuccess?: () => void) => {
    const context = getStreamContext()
    return save.mutateAsync(patch).then(
      () => { if (context === getStreamContext()) onSuccess?.() },
      (e: unknown) => { if (context === getStreamContext()) showErrorToast(e) },
    )
  }
  const set = (patch: Record<string, unknown>, onSuccess?: () => void) => { void setAsync(patch, onSuccess) }
  const bool = (key: string, fallback = false): boolean => {
    const v = settings.data?.[key]
    return typeof v === 'boolean' ? v : fallback
  }
  const str = (key: string, fallback = ''): string => {
    const v = settings.data?.[key]
    return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback
  }
  const num = (key: string, fallback: number): number => {
    const v = settings.data?.[key]
    return typeof v === 'number' ? v : fallback
  }
  return { settings, save, set, setAsync, bool, str, num, savedLabel: m.saved() }
}

/**
 * TAL-2172, TAL-2175: a Settings group header's "shown of total" count, from the server's `<prefix>_shown` and `<prefix>_total`.
 * While this tab's own write of one of the group's keys is unconfirmed, `optimistic` counts what the drawing shows; the server's
 * count follows once it confirms. Undefined until the server sends the total. `keys` covers every group the caller counts.
 */
export function useShownCounts(keys: readonly string[], num: (key: string, fallback: number) => number) {
  const intents = useSettingIntents(keys)
  return (prefix: string, groupKeys: readonly string[], optimistic: () => number): { shown: number; total: number } | undefined => {
    const total = num(`${prefix}_total`, -1)
    if (total < 0) return undefined
    return { shown: groupKeys.some((key) => key in intents) ? optimistic() : num(`${prefix}_shown`, 0), total }
  }
}
