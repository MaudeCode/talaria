import { useEffect, useRef, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { Button } from '../../ui/Button'

type Flow = Awaited<ReturnType<typeof api.onboardingOauthStart>>

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * TAL-398: one provider's device-code sign-in. The server runs the flow and saves the credential; this shows the code,
 * polls the flow's status at the interval the server names, and cancels a pending flow it leaves behind.
 */
export function OAuthSignIn({ provider, label, signedIn, onApproved }: { provider: string; label: string; signedIn: boolean; onApproved: (provider: string) => void }) {
  const [flow, setFlow] = useState<Flow | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const pendingId = flow?.status === 'pending' ? flow.flow_id ?? null : null
  const pendingRef = useRef<string | null>(null)

  const mounted = useRef(false)

  useEffect(() => { pendingRef.current = pendingId }, [pendingId])
  // Leaving the panel (another provider, another step) abandons its pending flow, so nothing is saved after it.
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (pendingRef.current) void api.onboardingOauthCancel(pendingRef.current).catch(() => undefined)
    }
  }, [])

  const waitMs = Math.max(1, flow?.interval ?? 5) * 1000
  useEffect(() => {
    if (!pendingId) return
    let stopped = false
    let timer: number | undefined
    const tick = async () => {
      try {
        const next = await api.onboardingOauthPoll(pendingId)
        if (stopped) return
        setFlow((current) => ({ ...current, ...next }))
        if (next.status === 'pending') timer = window.setTimeout(() => { void tick() }, waitMs)
      } catch (e) {
        if (stopped) return
        // The panel gives up on this flow, so the server must too: otherwise a later approval would still save.
        void api.onboardingOauthCancel(pendingId).catch(() => undefined)
        setFailure(message(e))
        setFlow(null)
      }
    }
    timer = window.setTimeout(() => { void tick() }, waitMs)
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [pendingId, waitMs])

  const approved = flow?.status === 'approved'
  useEffect(() => { if (approved) onApproved(provider) }, [approved, onApproved, provider])

  async function start() {
    setBusy(true)
    setFailure(null)
    try {
      const started = await api.onboardingOauthStart(provider)
      // The panel went away while the start was in flight: that flow has no one to finish it.
      if (!mounted.current) {
        if (started.status === 'pending' && started.flow_id) void api.onboardingOauthCancel(started.flow_id).catch(() => undefined)
        return
      }
      setFlow(started)
    } catch (e) {
      if (mounted.current) setFailure(message(e))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  async function cancel() {
    if (!pendingId) return
    try {
      setFlow({ ...flow, ...(await api.onboardingOauthCancel(pendingId)) })
    } catch (e) {
      setFailure(message(e))
    }
  }

  if (pendingId && flow) {
    return (
      <div className="onboarding-oauth flex flex-col gap-2 rounded-lg border border-border px-3 py-3 text-sm" id="onboardingOauthPanel">
        <p className="text-muted">{m.oauth_codex_step1()}</p>
        <a className="break-all text-accent-text underline" href={flow.verification_url} target="_blank" rel="noopener noreferrer" id="onboardingOauthLink">{flow.verification_url}</a>
        <code className="w-fit rounded-md border border-border2 bg-surface-subtle px-3 py-1.5 font-mono text-lg tracking-widest text-strong" id="onboardingOauthCode">{flow.user_code}</code>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted" role="status">{m.oauth_codex_polling()}</span>
          <Button onClick={() => { void cancel() }} id="onboardingOauthCancelBtn">{m.cancel()}</Button>
        </div>
      </div>
    )
  }

  const done = approved || signedIn
  const ended = failure ?? (flow?.status === 'denied' ? m.oauth_denied()
    : flow?.status === 'expired' ? m.oauth_codex_expired()
      : flow?.status === 'cancelled' ? m.oauth_cancelled()
        : flow?.status === 'error' ? `${m.oauth_codex_error()}: ${flow.error ?? ''}` : null)
  return (
    <div className="onboarding-oauth flex flex-col gap-2 text-sm" id="onboardingOauthPanel">
      {ended ? <p className="text-warning" role="alert">{ended}</p> : done && <p className="text-success" role="status">{m.oauth_signed_in({ provider: label })}</p>}
      <Button className="w-fit" variant={done ? 'default' : 'primary'} disabled={busy} onClick={() => { void start() }} id="onboardingOauthStartBtn">
        {done ? m.oauth_sign_in_again() : m.oauth_sign_in({ provider: label })}
      </Button>
    </div>
  )
}
