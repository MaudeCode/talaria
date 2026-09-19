import { useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { useBootstrap } from '../../app/bootstrap'
import * as api from '../../api/endpoints'
import { appUrl } from '../../lib/appRoot'
import { removePersistedByPrefix } from '../../lib/persisted'
import { safeNextPath } from './safeNextPath'
import { decodeRequestOptions, encodeAssertion, passkeysSupported } from './passkeys'
import { isApiError } from '../../contracts/common'

/** Password, passkey and OIDC sign-in. Redirect target validated with the legacy rules. */
export function LoginPage({ next }: { next: string | undefined }) {
  const bootstrap = useBootstrap()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const target = safeNextPath(next)

  const finish = () => {
    // Whoever signs in next must not inherit the previous identity's boot snapshots.
    removePersistedByPrefix('hermes-boot:')
    removePersistedByPrefix('hermes-webui-session')
    window.location.assign(target === './' ? appUrl('').href : appUrl(target).href)
  }

  const onSubmit = async (e: { preventDefault: () => void }) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await api.login(password)
      if (res.ok) finish()
      else setError(res.error ?? m.login_invalid_pw())
    } catch (err) {
      setError(isApiError(err) && err.kind === 'http' ? (err.message || m.login_invalid_pw()) : m.login_conn_failed())
    } finally {
      setBusy(false)
    }
  }

  const onPasskey = async () => {
    if (!passkeysSupported()) return
    setError(null)
    setBusy(true)
    try {
      const opt = await api.passkeyOptions()
      if (!opt.publicKey) throw new Error(opt.error ?? 'Passkey unavailable')
      const cred = await navigator.credentials.get({ publicKey: decodeRequestOptions(opt.publicKey as Parameters<typeof decodeRequestOptions>[0]) })
      if (!cred) throw new Error('Passkey cancelled')
      const res = await api.passkeyLogin(encodeAssertion(cred as PublicKeyCredential))
      if (res.ok) finish()
      else setError(res.error ?? m.login_invalid_pw())
    } catch (err) {
      setError(err instanceof Error ? err.message : m.login_conn_failed())
    } finally {
      setBusy(false)
    }
  }

  const oidcHref = appUrl(`api/auth/oidc/start${target !== './' ? `?next=${encodeURIComponent(target)}` : ''}`).href
  const showPassword = bootstrap.auth.password_auth_enabled !== false && !bootstrap.auth.passwordless_enabled

  return (
    <main className="flex h-full items-center justify-center bg-bg p-4 text-text">
      <div className="w-80 rounded-2xl border border-border bg-surface p-8 text-center shadow-md">
        <div className="brandmark mx-auto mb-3 h-12 w-12" aria-hidden="true" />
        <h1 className="mb-1 text-lg font-semibold text-strong">{bootstrap.bot_name}</h1>
        <p className="mb-6 text-xs text-muted">{m.login_subtitle()}</p>
        <form onSubmit={(e) => { void onSubmit(e) }} className="flex flex-col gap-3">
          {showPassword && (
            <>
              <label htmlFor="pw" className="sr-only">{m.login_placeholder()}</label>
              <input id="pw" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder={m.login_placeholder()} className="w-full rounded-lg border border-border bg-input px-3.5 py-2.5 text-sm text-text focus:border-accent" />
              <button type="submit" disabled={busy} className="w-full rounded-lg border border-accent-bg-strong bg-accent-bg px-3 py-2.5 text-sm font-semibold text-accent-text hover:bg-accent-bg-strong disabled:opacity-60">{m.login_btn()}</button>
            </>
          )}
          {bootstrap.auth.passkeys_enabled && passkeysSupported() && (
            <button type="button" disabled={busy} onClick={() => { void onPasskey() }} className="w-full rounded-lg border border-warning bg-input px-3 py-2.5 text-sm font-semibold text-warning">
              Sign in with passkey
            </button>
          )}
          {bootstrap.auth.oidc_enabled && (
            <a id="oidc-login" href={oidcHref} className="block w-full rounded-lg border border-success bg-input px-3 py-2.5 text-sm font-semibold text-success no-underline">
              Sign in with SSO
            </a>
          )}
        </form>
        {error && <div role="alert" className="mt-3 text-xs text-error">{error}</div>}
      </div>
    </main>
  )
}
