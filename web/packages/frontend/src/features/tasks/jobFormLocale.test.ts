/** TAL-1128: the script-only model hint JobForm shows is German under the German locale. */
import { afterEach, expect, it } from 'vitest'
import { applyLocale } from '../../i18n/runtime'
import { cron_model_no_agent_hint } from '../../paraglide/messages/cron_model_no_agent_hint.js'

afterEach(async () => { await applyLocale('en', { persist: false }) })

it('shows the script-only model hint in German', async () => {
  await applyLocale('de', { persist: false })
  expect(cron_model_no_agent_hint()).toBe('Reine Skript-Jobs führen das konfigurierte Skript direkt aus; das Modell wird nicht verwendet.')
})
