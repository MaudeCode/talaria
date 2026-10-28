import { useEffect, useRef, useState, type ReactNode } from 'react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { isDefiniteRefusal } from '../../contracts/common'
import { Button } from '../../ui/Button'
import type { NousAccount, ConnectorOperationView } from '@maudecode/talaria-web-contracts'
import { PageConnect } from '../connectors/ConnectTargets'

type Flow = Awaited<ReturnType<typeof api.onboardingOauthStart>>

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * TAL-398: one provider's device-code sign-in. The server runs the flow and saves the credential; this shows the code,
 * polls the flow's status at the interval the server names, and cancels a pending flow it leaves behind.
 * TAL-1276: a plugin client's browser sign-in has no code; its panel names the hosts the server reports, and `children`
 * adds what the flow takes besides the link (the pasted redirect address). `compact` leaves the signed-in line to the caller.
 */
interface OAuthSignInProps {
  provider: string; label: string; signedIn: boolean; onApproved: (provider: string) => void; idPrefix?: string; compact?: boolean; children?: (flow: Flow) => ReactNode; account?: NousAccount | null; resultOnly?: boolean
}

export function OAuthSignIn(props: OAuthSignInProps) {
  // A provider change retires the old request owner, including starts still in flight.
  return <OAuthSignInPanel key={props.provider} {...props} />
}

function OAuthSignInPanel({ provider, label, signedIn, onApproved, idPrefix = 'onboardingOauth', compact = false, children, account, resultOnly = false }: OAuthSignInProps) {
  const [flow, setFlow] = useState<Flow | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [operation, setOperation] = useState<{ accountId: string; view: ConnectorOperationView } | null>(null)
  const polls = useRef(0)
  const notified = useRef(false)
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

  const pollId = pendingId ?? (flow?.status === 'approved' && flow.nous_account?.poll_after ? flow.flow_id : null)
  const waitMs = Math.max(1, flow?.status === 'approved' ? flow.nous_account?.poll_after ?? 5 : flow?.interval ?? 5) * 1000
  useEffect(() => {
    if (!pollId) return
    let stopped = false
    let timer: number | undefined
    const tick = async () => {
      try {
        const next = await api.onboardingOauthPoll(pollId)
        if (stopped) return
        setFlow((current) => current?.flow_id === pollId ? { ...current, ...next } : current)
        setFailure(null)
        if (next.status === 'approved') polls.current += 1
        if (next.status === 'pending' || (next.nous_account?.poll_after && polls.current < 120)) timer = window.setTimeout(() => { void tick() }, waitMs)
      } catch (e) {
        if (stopped) return
        if (pendingId) {
          // Abandoning sign-in also cancels its still-unsaved credential.
          void api.onboardingOauthCancel(pendingId).catch(() => undefined)
          setFailure(message(e))
          setFlow(null)
        } else {
          setFailure(m.oauth_result_unavailable())
          polls.current += 1
          if (polls.current < 120) timer = window.setTimeout(() => { void tick() }, waitMs)
        }
      }
    }
    timer = window.setTimeout(() => { void tick() }, waitMs)
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [pollId, pendingId, waitMs])

  const approved = flow?.status === 'approved'
  const result = flow?.status === 'approved' ? flow.nous_account : account
  const activeOperation = operation?.accountId === result?.account_id ? operation?.view : null
  const needsAcknowledgement = approved && flow.nous_account != null && !acknowledged
  useEffect(() => {
    if (approved && !needsAcknowledgement && !notified.current) { notified.current = true; onApproved(provider) }
  }, [approved, needsAcknowledgement, onApproved, provider])

  async function start() {
    setBusy(true)
    setFailure(null)
    setAcknowledged(false)
    setOperation(null)
    polls.current = 0
    notified.current = false
    try {
      const started = await api.onboardingOauthStart(provider)
      if (mounted.current) setFlow(started)
      // The panel went away while the start was in flight: that flow has no one to finish it.
      else if (started.status === 'pending' && started.flow_id) void api.onboardingOauthCancel(started.flow_id).catch(() => undefined)
    } catch (e) {
      if (mounted.current) setFailure(message(e))
    }
    if (mounted.current) setBusy(false)
  }

  async function reconnect(connector: string) {
    if (!result) return
    setBusy(true)
    setFailure(null)
    try {
      const next = await api.connectConnector(connector, result.account_id)
      if (mounted.current) setOperation({ accountId: result.account_id, view: next })
    } catch (e) { if (mounted.current) setFailure(message(e)) }
    if (mounted.current) setBusy(false)
  }

  // The sign-in panel closes on Cancel; a refused cancel brings the pending flow back with the error.
  async function cancel() {
    if (!pendingId || !flow) return
    const pending = flow
    setFlow({ ...pending, status: 'cancelled' })
    try {
      const cancelled = await api.onboardingOauthCancel(pendingId)
      if (mounted.current) setFlow((current) => current?.flow_id === pending.flow_id ? { ...current, ...cancelled } : current)
    } catch (e) {
      if (!mounted.current) return
      // A refused cancel left the flow pending. An unknown outcome may have cancelled it, so the flow's own state decides.
      const settled = isDefiniteRefusal(e) ? pending : await api.onboardingOauthPoll(pendingId).then((polled) => ({ ...pending, ...polled }), () => null)
      if (!mounted.current) return
      if (settled) setFlow((current) => current?.flow_id === pending.flow_id ? settled : current)
      setFailure(message(e))
    }
  }

  if (pendingId && flow) {
    return (
      <div className="onboarding-oauth flex flex-col gap-2 rounded-lg border border-border px-3 py-3 text-sm" id={`${idPrefix}Panel`}>
        <p className="text-muted">{flow.user_code ? m.oauth_codex_step1() : m.oauth_plugin_hosts({ authorize_host: flow.authorize_host ?? '', token_host: flow.token_host ?? '' })}</p>
        <a className="break-all text-accent-text underline" href={flow.verification_url} target="_blank" rel="noopener noreferrer" id={`${idPrefix}Link`}>{flow.verification_url}</a>
        {flow.user_code && <code className="w-fit rounded-md border border-border2 bg-surface-subtle px-3 py-1.5 font-mono text-lg tracking-widest text-strong" id={`${idPrefix}Code`}>{flow.user_code}</code>}
        {children?.(flow)}
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted" role="status">{m.oauth_codex_polling()}</span>
          <Button onClick={() => { void cancel() }} id={`${idPrefix}CancelBtn`}>{m.cancel()}</Button>
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
    <div className="onboarding-oauth flex flex-col gap-2 text-sm" id={`${idPrefix}Panel`}>
      {ended && <p className="text-warning" role="alert">{ended}</p>}
      {result ? <div role="status" className="flex flex-col gap-1 break-words" data-handoff-state={result.state}>
        <p className="text-success">{result.email ? m.oauth_signed_in_as({ email: result.email }) : m.oauth_signed_in({ provider: label })}</p>
        {result.lines.map((line, i) => <p className="text-muted" key={i}>{line}</p>)}
      </div> : !ended && done && !compact && <p className="text-success" role="status">{m.oauth_signed_in({ provider: label })}</p>}
      {result && !activeOperation && result.reconnect.map((connector) => <Button key={connector} className="w-fit" disabled={busy} onClick={() => { void reconnect(connector) }}>{m.oauth_reconnect({ app: connector })}</Button>)}
      {activeOperation && <PageConnect initial={activeOperation} name={label} onDone={() => setOperation(null)} />}
      {needsAcknowledgement && <Button className="w-fit" variant="primary" onClick={() => setAcknowledged(true)}>{m.oauth_result_continue()}</Button>}
      {!resultOnly && <Button className="w-fit" variant={done ? 'default' : 'primary'} disabled={busy} onClick={() => { void start() }} id={`${idPrefix}StartBtn`}>
        {done ? m.oauth_sign_in_again() : m.oauth_sign_in({ provider: label })}
      </Button>}
    </div>
  )
}
