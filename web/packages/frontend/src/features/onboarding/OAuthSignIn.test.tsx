import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'

vi.mock('../../api/endpoints', () => ({ onboardingOauthStart: vi.fn(), onboardingOauthPoll: vi.fn(), onboardingOauthCancel: vi.fn() }))
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
})
