import { useSaveSettings, useSettingsQuery } from '../../app/queries'
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
