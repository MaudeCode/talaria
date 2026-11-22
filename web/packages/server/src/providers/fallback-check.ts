import { FALLBACK_CHECK_ERROR_MAX, FALLBACK_CHECK_MAX_ENTRIES, type FallbackCheck, type SidecarResult } from '@maudecode/talaria-web-contracts'
import { redactSensitive } from '../redact.js'
import { providerLabel, type ModelsCatalog } from './catalog.js'

/**
 * TAL-2655: the Agent's static fallback verdicts as clients show them. Ready only on the Agent's own static ready with a
 * resolved, credentialed route; the reason is redacted and bounded here, and an unknown provider keeps its configured id.
 */
export function fallbackCheckView(result: SidecarResult<'providers.fallback_check'>, catalog: ModelsCatalog | undefined): FallbackCheck {
  if (!result.available) return { available: false, entries: [] }
  return {
    available: true,
    entries: result.entries.slice(0, FALLBACK_CHECK_MAX_ENTRIES).map((entry, i) => {
      const authReady = entry.configured && entry.auth_ready
      const status = authReady && entry.ready ? 'ready' : entry.configured ? 'auth' : 'config'
      return {
        position: i + 1, provider: entry.provider, provider_label: entry.configured ? providerLabel(catalog, entry.provider) : entry.provider, model: entry.model,
        configured: entry.configured, auth_ready: authReady, status,
        error: status === 'ready' ? null : redactSensitive(entry.error).trim().slice(0, FALLBACK_CHECK_ERROR_MAX) || null,
      }
    }),
  }
}
