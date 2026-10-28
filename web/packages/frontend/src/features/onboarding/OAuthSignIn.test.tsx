import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'

vi.mock('../../api/endpoints', () => ({ onboardingOauthStart: vi.fn(), onboardingOauthPoll: vi.fn(), onboardingOauthCancel: vi.fn(), connectConnector: vi.fn() }))
import * as api from '../../api/endpoints'
import { OAuthSignIn } from './OAuthSignIn'

const started = { ok: true, status: 'pending', flow_id: 'flow-1', provider: 'openai-codex', user_code: 'ABCD-1234', verification_url: 'https://auth.example.test/device', expires_in: 900, interval: 1 }

async function startFlow() {
  await act(async () => { screen.getByRole('button', { name: 'Sign in with ChatGPT' }).click(); await Promise.resolve() })
}

async function nextPoll() {
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
}

describe('OAuthSignIn', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(api.onboardingOauthStart).mockReset().mockResolvedValue(started)
    vi.mocked(api.onboardingOauthPoll).mockReset()
    vi.mocked(api.onboardingOauthCancel).mockReset().mockResolvedValue({ ok: true, status: 'cancelled', flow_id: 'flow-1', provider: 'openai-codex', error: null })
  })
  afterEach(() => { vi.useRealTimers() })

  it('shows the code, polls at the server interval, and reports the approval', async () => {
    vi.mocked(api.onboardingOauthPoll).mockResolvedValueOnce({ ok: true, status: 'pending', flow_id: 'flow-1' }).mockResolvedValueOnce({ ok: true, status: 'approved', flow_id: 'flow-1' })
    const onApproved = vi.fn()
    render(<OAuthSignIn provider="openai-codex" label="ChatGPT" signedIn={false} onApproved={onApproved} />)
    await startFlow()
    expect(api.onboardingOauthStart).toHaveBeenCalledWith('openai-codex')
    expect(screen.getByText('ABCD-1234')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'https://auth.example.test/device' })).toHaveAttribute('target', '_blank')
    await nextPoll()
    expect(api.onboardingOauthPoll).toHaveBeenCalledTimes(1)
    expect(onApproved).not.toHaveBeenCalled()
    await nextPoll()
    expect(api.onboardingOauthPoll).toHaveBeenLastCalledWith('flow-1')
    expect(onApproved).toHaveBeenCalledTimes(1)
    expect(onApproved).toHaveBeenCalledWith('openai-codex')
    expect(screen.getByRole('status')).toHaveTextContent('Signed in to ChatGPT.')
    await nextPoll()
    expect(api.onboardingOauthPoll).toHaveBeenCalledTimes(2)
    expect(api.onboardingOauthCancel).not.toHaveBeenCalled()
  })

  it('keeps the Nous result readable until Continue and polls handoff separately from approval', async () => {
    const account = { account_id: 'account-1', email: 'u***@example.test', state: 'retrying' as const, lines: ['Moving your free-tier apps to this account; Hermes keeps trying in the background.'], moved: [], dropped: [], reconnect: [], poll_after: 1 }
    vi.mocked(api.onboardingOauthStart).mockResolvedValue({ ...started, provider: 'nous' })
    vi.mocked(api.onboardingOauthPoll).mockResolvedValue({ ok: true, status: 'approved', flow_id: 'flow-1', nous_account: account })
    const onApproved = vi.fn()
    render(<OAuthSignIn provider="nous" label="Nous Portal" signedIn={false} onApproved={onApproved} />)
    await act(async () => { screen.getByRole('button', { name: 'Sign in with Nous Portal' }).click(); await Promise.resolve() })
    await nextPoll()
    expect(screen.getByRole('status')).toHaveTextContent('u***@example.test')
    expect(screen.getByRole('status')).toHaveTextContent('keeps trying in the background')
    expect(onApproved).not.toHaveBeenCalled()
    await nextPoll()
    expect(api.onboardingOauthPoll).toHaveBeenCalledTimes(2)
    await act(async () => { screen.getByRole('button', { name: 'Continue' }).click(); await Promise.resolve() })
    expect(onApproved).toHaveBeenCalledTimes(1)
  })

  it('retains confirmed handoff on a failed read and never overlaps polling', async () => {
    const account = { account_id: 'account-1', email: 'u***@example.test', state: 'retrying' as const, lines: ['Still moving apps.'], moved: [], dropped: [], reconnect: [], poll_after: 1 }
    vi.mocked(api.onboardingOauthPoll).mockResolvedValueOnce({ ok: true, status: 'approved', flow_id: 'flow-1', nous_account: account }).mockRejectedValueOnce(new Error('offline'))
    render(<OAuthSignIn provider="nous" label="ChatGPT" signedIn={false} onApproved={vi.fn()} />)
    await startFlow()
    await nextPoll()
    await nextPoll()
    expect(screen.getByRole('status')).toHaveTextContent('Still moving apps.')
    expect(screen.getByRole('alert')).toHaveTextContent('status is unavailable')
    expect(api.onboardingOauthCancel).not.toHaveBeenCalled()
    let resolve!: (result: Awaited<ReturnType<typeof api.onboardingOauthPoll>>) => void
    vi.mocked(api.onboardingOauthPoll).mockReturnValueOnce(new Promise((done) => { resolve = done }))
    await nextPoll()
    const calls = vi.mocked(api.onboardingOauthPoll).mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(api.onboardingOauthPoll).toHaveBeenCalledTimes(calls)
    await act(async () => { resolve({ ok: true, status: 'approved', flow_id: 'flow-1', nous_account: null }); await Promise.resolve() })
    expect(screen.queryByText('u***@example.test')).toBeNull()
  })

  it('retires the owning flow and its late response when the profile context changes', async () => {
    const { teardownAll } = await import('../../stream/connection')
    let answer!: (value: Awaited<ReturnType<typeof api.onboardingOauthPoll>>) => void
    vi.mocked(api.onboardingOauthPoll).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    render(<OAuthSignIn provider="nous" label="ChatGPT" signedIn={false} onApproved={vi.fn()} />)
    await startFlow()
    await nextPoll()
    await act(async () => { teardownAll(); await Promise.resolve() })
    expect(api.onboardingOauthCancel).toHaveBeenCalledWith('flow-1')
    await act(async () => { answer({ ok: true, status: 'approved', flow_id: 'flow-1', nous_account: {
      account_id: 'old-profile', email: 'x***@example.test', state: 'idle', lines: [], moved: [], dropped: [], reconnect: [], poll_after: null,
    } }); await Promise.resolve() })
    expect(screen.queryByText('x***@example.test', { exact: false })).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeEnabled()
  })

  it('ignores an old provider response after switching and cancels its unowned start', async () => {
    let answer!: (value: typeof started) => void
    vi.mocked(api.onboardingOauthStart).mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    const view = render(<OAuthSignIn provider="nous" label="ChatGPT" signedIn={false} onApproved={vi.fn()} />)
    await startFlow()
    view.rerender(<OAuthSignIn provider="openai-codex" label="ChatGPT" signedIn={false} onApproved={vi.fn()} />)
    await act(async () => { answer(started); await Promise.resolve() })
    expect(screen.queryByText('ABCD-1234')).toBeNull()
    expect(api.onboardingOauthCancel).toHaveBeenCalledWith('flow-1')
  })

  it('renders refreshed provider results and reconnects only on explicit action with the account fence', async () => {
    const account = { account_id: 'account-1', email: 'u***@example.test', state: 'claimed' as const, lines: ['Your apps moved: calendar.', 'Reconnect gmail.'], moved: ['calendar'], dropped: ['gmail'], reconnect: ['gmail'], poll_after: null }
    const { rerender } = render(<OAuthSignIn provider="nous" label="Nous Portal" signedIn resultOnly account={account} onApproved={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('calendar')
    expect(api.onboardingOauthStart).not.toHaveBeenCalled()
    expect(api.connectConnector).not.toHaveBeenCalled()
    vi.mocked(api.connectConnector).mockRejectedValueOnce(new Error('Account changed'))
    await act(async () => { screen.getByRole('button', { name: 'Reconnect gmail' }).click(); await Promise.resolve() })
    expect(api.connectConnector).toHaveBeenCalledWith('gmail', 'account-1')
    expect(screen.getByRole('alert')).toHaveTextContent('Account changed')
    rerender(<OAuthSignIn provider="nous" label="Nous Portal" signedIn resultOnly account={null} onApproved={vi.fn()} />)
    expect(screen.queryByText('u***@example.test')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reconnect gmail' })).toBeNull()
  })

  it('keeps a confirmed provider result readable with its server-owned unavailable error', () => {
    const account = { account_id: 'account-1', email: 'u***@example.test', state: 'unavailable' as const, lines: ['Apps moved.'], moved: ['calendar'], dropped: ['gmail'], reconnect: [], poll_after: 5 }
    render(<OAuthSignIn provider="nous" label="Nous Portal" signedIn resultOnly account={account} accountError="Connected-app transfer status is unavailable." onApproved={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('u***@example.test')
    expect(screen.getByRole('alert')).toHaveTextContent('status is unavailable')
    expect(screen.queryByRole('button', { name: 'Reconnect gmail' })).toBeNull()
  })

  it('a declined sign-in says so and offers another attempt', async () => {
    vi.mocked(api.onboardingOauthPoll).mockResolvedValue({ ok: false, status: 'denied', flow_id: 'flow-1', error: 'Sign-in was declined.' })
    render(<OAuthSignIn provider="openai-codex" label="ChatGPT" signedIn={false} onApproved={vi.fn()} />)
    await startFlow()
    await nextPoll()
    expect(screen.getByRole('alert')).toHaveTextContent('Sign-in was declined. Try again.')
    expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeEnabled()
  })

  it('a poll that fails cancels the flow it gives up on', async () => {
    vi.mocked(api.onboardingOauthPoll).mockRejectedValue(new Error('Network error'))
    render(<OAuthSignIn provider="openai-codex" label="ChatGPT" signedIn={false} onApproved={vi.fn()} />)
    await startFlow()
    await nextPoll()
    expect(api.onboardingOauthCancel).toHaveBeenCalledWith('flow-1')
    expect(screen.getByRole('alert')).toHaveTextContent('Network error')
    expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeEnabled()
  })

  it('a start that answers after the panel is gone cancels its flow', async () => {
    let answer: (value: typeof started) => void = () => undefined
    vi.mocked(api.onboardingOauthStart).mockReturnValue(new Promise((resolve) => { answer = resolve }))
    const view = render(<OAuthSignIn provider="openai-codex" label="ChatGPT" signedIn={false} onApproved={vi.fn()} />)
    await startFlow()
    view.unmount()
    expect(api.onboardingOauthCancel).not.toHaveBeenCalled()
    await act(async () => { answer(started); await Promise.resolve() })
    expect(api.onboardingOauthCancel).toHaveBeenCalledWith('flow-1')
    await nextPoll()
    expect(api.onboardingOauthPoll).not.toHaveBeenCalled()
  })

  it('cancel stops the flow, and leaving a pending flow cancels it', async () => {
    vi.mocked(api.onboardingOauthPoll).mockResolvedValue({ ok: true, status: 'pending', flow_id: 'flow-1' })
    const view = render(<OAuthSignIn provider="openai-codex" label="ChatGPT" signedIn={false} onApproved={vi.fn()} />)
    await startFlow()
    await act(async () => { screen.getByRole('button', { name: 'Cancel' }).click(); await Promise.resolve() })
    expect(api.onboardingOauthCancel).toHaveBeenCalledWith('flow-1')
    expect(screen.getByRole('alert')).toHaveTextContent('Sign-in cancelled.')
    await nextPoll()
    expect(api.onboardingOauthPoll).not.toHaveBeenCalled()

    await startFlow()
    view.unmount()
    expect(api.onboardingOauthCancel).toHaveBeenCalledTimes(2)
  })

  it('closes the sign-in on Cancel at once and brings it back when the cancel is refused (TAL-1179)', async () => {
    vi.mocked(api.onboardingOauthPoll).mockResolvedValue({ ok: true, status: 'pending', flow_id: 'flow-1' })
    let refuse!: (error: unknown) => void
    vi.mocked(api.onboardingOauthCancel).mockReturnValueOnce(new Promise((_, reject) => { refuse = reject }) as never)
    render(<OAuthSignIn provider="openai-codex" label="ChatGPT" signedIn={false} onApproved={vi.fn()} />)
    await startFlow()
    await act(async () => { screen.getByRole('button', { name: 'Cancel' }).click(); await Promise.resolve() })
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('Sign-in cancelled.')
    await act(async () => { refuse(new Error('Cancel failed')); await Promise.resolve() })
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('asks the flow itself after a cancel with an unknown outcome, keeping it closed when it was cancelled (TAL-1383)', async () => {
    vi.mocked(api.onboardingOauthPoll).mockResolvedValue({ ok: true, status: 'pending', flow_id: 'flow-1' })
    const { ApiError } = await import('../../contracts/common')
    vi.mocked(api.onboardingOauthCancel).mockRejectedValueOnce(new ApiError({ kind: 'timeout', path: '/x', message: 'timed out' }))
    render(<OAuthSignIn provider="openai-codex" label="ChatGPT" signedIn={false} onApproved={vi.fn()} />)
    await startFlow()
    vi.mocked(api.onboardingOauthPoll).mockResolvedValue({ ok: true, status: 'cancelled', flow_id: 'flow-1' })
    await act(async () => { screen.getByRole('button', { name: 'Cancel' }).click(); await Promise.resolve() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(api.onboardingOauthPoll).toHaveBeenLastCalledWith('flow-1')
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })
})
