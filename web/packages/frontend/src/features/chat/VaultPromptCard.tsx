import { useEffect, useState, type SyntheticEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import type { VaultPrompt, VaultPromptField } from '../../contracts'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { isApiError } from '../../contracts/common'
import type { LiveTurn } from '../../stream/reducer'
import { Button } from '../../ui/Button'
import { TextInput } from '../../ui/Field'
import { showToast } from '../toast/toast'
import { useClarifyHead } from './useClarify'

/** TAL-887: the clarify queue head when it is one of the Agent's password-manager prompts. */
export function useVaultPrompt(sessionId: string | null, live: LiveTurn | null): { clarifyId: string; vault: VaultPrompt } | null {
  const { running, query } = useClarifyHead(sessionId, live)
  const pending = running ? (query.data?.pending ?? null) : null
  return pending?.vault ? { clarifyId: pending.clarify_id ?? '', vault: pending.vault } : null
}

const HEADING: Record<VaultPrompt['kind'], (vault: VaultPrompt) => string> = {
  vault_unlock: (vault) => m.vault_unlock_heading({ name: vault.display_name ?? vault.backend ?? '' }),
  vault_save_login: (vault) => m.vault_save_login_heading({ site: vault.site ?? '' }),
  vault_code: (vault) => m.vault_code_heading({ site: vault.site ?? '' }),
}
const SUBMIT: Record<VaultPrompt['kind'], () => string> = { vault_unlock: m.vault_unlock_submit, vault_save_login: m.vault_save_login_submit, vault_code: m.vault_code_submit }
const LABEL: Record<VaultPromptField['key'], () => string> = { master_password: m.vault_field_master_password, identifier: m.vault_field_identifier, password: m.vault_field_password, code: m.vault_field_code }
// The answers are for another site or a password manager, never Talaria's own login: ask the browser and password
// managers for nothing they keep for this origin. A one-time code may be read from the message the site sent.
const AUTOCOMPLETE: Record<VaultPromptField['key'], string> = { master_password: 'off', identifier: 'off', password: 'off', code: 'one-time-code' }

/**
 * The Agent asks for a master password, a login to save, or a one-time code. The answer goes to the server once and
 * is dropped here; Skip, an empty submit, or the deadline leave the Agent unanswered.
 */
export function VaultPromptCard({ sessionId, clarifyId, vault }: { sessionId: string; clarifyId: string; vault: VaultPrompt }) {
  const qc = useQueryClient()
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.round(vault.timeout_at - Date.now() / 1000)))
  useEffect(() => {
    const t = window.setInterval(() => setRemaining(Math.max(0, Math.round(vault.timeout_at - Date.now() / 1000))), 1000)
    return () => window.clearInterval(t)
  }, [vault.timeout_at])

  const respond = async (decline: boolean) => {
    if (busy) return
    setBusy(true)
    const answers = values
    setValues({})
    try {
      await api.respondClarify({ session_id: sessionId, clarify_id: clarifyId, ...(decline ? { decline: true } : { answers }) })
      setDone(true)
    } catch (e) {
      if (isApiError(e) && e.status === 409) setDone(true)
      showToast(e instanceof Error ? e.message : String(e), 4000, 'error')
    } finally {
      setBusy(false)
      void qc.invalidateQueries({ queryKey: keys.clarify(sessionId) })
    }
  }
  const onSubmit = (e: SyntheticEvent) => { e.preventDefault(); void respond(false) }
  if (done) return null
  const heading = HEADING[vault.kind](vault)
  return (
    <form onSubmit={onSubmit} className="vault-card" role="dialog" aria-labelledby="vaultHeading" id="vaultPromptCard" autoComplete="off">
      <div className="vault-inner">
        <div className="flex items-center gap-2 text-sm font-semibold text-text">
          <KeyRound size={14} className="text-info" aria-hidden="true" />
          <span id="vaultHeading">{heading}</span>
          <span className="flex-1" />
          <span className="text-xs font-normal tabular-nums text-muted">{remaining}s</span>
        </div>
        {vault.hint && <div className="mt-1 text-[13px] text-muted">{vault.hint}</div>}
        <div className="mt-2 flex flex-col gap-2">
          {vault.fields.map((field, i) => (
            <label key={field.key} className="flex flex-col gap-1 text-xs text-muted">
              {LABEL[field.key]()}
              <TextInput
                type={field.secure ? 'password' : 'text'}
                name={field.key}
                autoComplete={AUTOCOMPLETE[field.key]}
                data-1p-ignore=""
              data-lpignore="true"
              data-bwignore=""
                spellCheck={false}
                autoCapitalize="off"
                autoFocus={i === 0}
                disabled={busy}
                value={values[field.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
              />
            </label>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy || vault.fields.some((f) => !(values[f.key] ?? '').trim())}>{SUBMIT[vault.kind]()}</Button>
          <Button disabled={busy} onClick={() => { void respond(true) }}>{m.vault_skip()}</Button>
        </div>
      </div>
    </form>
  )
}
