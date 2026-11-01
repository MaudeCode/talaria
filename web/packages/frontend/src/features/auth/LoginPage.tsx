import { useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { useBootstrap } from '../../app/bootstrap'
import * as api from '../../api/endpoints'
import { appRoot, appUrl } from '../../lib/appRoot'
import { resetIdentityCache } from '../../api/queryClient'
import { safeNextPath } from './safeNextPath'
import { decodeRequestOptions, encodeAssertion, passkeysSupported } from './passkeys'
import { isApiError } from '../../contracts/common'

/** Password, passkey and OIDC sign-in; the server resolves where the browser lands. */
export function LoginPage({ next }: { next: string | undefined }) {
  const bootstrap = useBootstrap()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const target = safeNextPath(next)
  // TAL-1075: the server validates `next` and mounts it exactly once; the page reports only where it is mounted.
  const destination = { ...(next ? { next } : {}), mount_path: appRoot().pathname }

  const finish = (redirectPath: string | undefined) => {
    // Whoever signs in next must not inherit the previous identity's boot snapshots.
    resetIdentityCache()
    // Old servers answer without `redirect_path`; there the page keeps its legacy validated target.
    window.location.assign(redirectPath ?? (target === './' ? appUrl('').href : appUrl(target).href))
  }

  const onSubmit = async (e: { preventDefault: () => void }) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      finish((await api.login(password, destination)).redirect_path)
    } catch (err) {
      setError(isApiError(err) && err.kind === 'http' ? (err.message || m.login_invalid_pw()) : m.login_conn_failed())
    }
    setBusy(false)
  }

  const onPasskey = async () => {
    if (!passkeysSupported()) return
    setError(null)
    setBusy(true)
    try {
      const opt = await api.passkeyOptions()
      const cred = await navigator.credentials.get({ publicKey: decodeRequestOptions(opt.publicKey as unknown as Parameters<typeof decodeRequestOptions>[0]) })
      if (cred) {
        finish((await api.passkeyLogin(encodeAssertion(cred as PublicKeyCredential), destination)).redirect_path)
      } else setError('Passkey cancelled')
    } catch (err) {
      setError(err instanceof Error ? err.message : m.login_conn_failed())
    }
    setBusy(false)
  }

  const oidcHref = appUrl(`api/auth/oidc/start?${new URLSearchParams(destination).toString()}`).href
  const showPassword = bootstrap.auth.password_auth_enabled && !bootstrap.auth.passwordless_enabled

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
        {bootstrap.auth.oidc_unavailable && <p role="status" className="mt-3 text-xs text-muted">{m.login_sso_unavailable()}</p>}
        {error && <div role="alert" className="mt-3 text-xs text-error">{error}</div>}
      </div>
    </main>
  )
}
