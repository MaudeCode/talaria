import { useSaveSettings, useSettingsQuery } from '../../app/queries'
import { showToast } from '../toast/toast'
import { m } from '../../paraglide/messages.js'

/** Read a server setting and save a patch; optimistic UI comes from Query's cache update on success. */
export function useSettingField() {
  const settings = useSettingsQuery()
  const save = useSaveSettings()
  const set = (patch: Record<string, unknown>) => {
    save.mutate(patch, { onError: (e) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error') })
  }
  const bool = (key: string, fallback = false): boolean => {
    const v = (settings.data as Record<string, unknown> | undefined)?.[key]
    return typeof v === 'boolean' ? v : fallback
  }
  const str = (key: string, fallback = ''): string => {
    const v = (settings.data as Record<string, unknown> | undefined)?.[key]
    return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback
  }
  const num = (key: string, fallback: number): number => {
    const v = (settings.data as Record<string, unknown> | undefined)?.[key]
    return typeof v === 'number' ? v : fallback
  }
  return { settings, save, set, bool, str, num, savedLabel: m.saved() }
}
