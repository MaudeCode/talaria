import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BootstrapContext } from '../../app/bootstrap'
import type { Bootstrap } from '../../contracts/bootstrap'
import { ApiError } from '../../contracts/common'

vi.mock('../../api/endpoints', () => ({ login: vi.fn(), passkeyOptions: vi.fn(), passkeyLogin: vi.fn() }))
import * as api from '../../api/endpoints'
import { LoginPage } from './LoginPage'

const bootstrap = {
  webui_version: 'test', max_upload_bytes: 1, csrf_token: '', language: 'en', bot_name: 'Hermes',
  auth: { auth_enabled: true, logged_in: false, oidc_enabled: true, password_auth_enabled: true, passkeys_enabled: false, passkeys_count: 0, passkey_feature_flag: false, auth_disabled_acknowledged: false, can_manage_server: false },
  profile: { name: 'default', is_default: true }, onboarding: null,
} as unknown as Bootstrap

function renderLogin(next?: string) {
  return render(<BootstrapContext.Provider value={bootstrap}><LoginPage next={next} /></BootstrapContext.Provider>)
}

describe('LoginPage', () => {
  beforeEach(() => { vi.mocked(api.login).mockReset() })

  it('shows the server error for a rejected password and keeps the form usable', async () => {
    vi.mocked(api.login).mockResolvedValue({ ok: false, error: 'Invalid password' })
    renderLogin()
    await userEvent.type(screen.getByPlaceholderText(/password/i), 'nope')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid password')
    expect(api.login).toHaveBeenCalledWith('nope')
    expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled()
  })

  it('reports a connection failure distinctly from a rejection', async () => {
    vi.mocked(api.login).mockRejectedValue(new ApiError({ kind: 'network', path: 'api/auth/login', message: 'boom' }))
    renderLogin()
    await userEvent.type(screen.getByPlaceholderText(/password/i), 'x')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/connection failed/i)
  })

  it('links SSO to the OIDC start route with a validated next target', () => {
    renderLogin('https://evil.example/phish')
    const sso = screen.getByRole('link', { name: /sso|single sign|oidc/i })
    expect(sso.getAttribute('href')).toMatch(/api\/auth\/oidc\/start$/)
    renderLogin('/settings/providers')
    const [, second] = screen.getAllByRole('link', { name: /sso|single sign|oidc/i })
    expect(decodeURIComponent(second!.getAttribute('href') ?? '')).toContain('next=/settings/providers')
  })

  it('redirects to the validated target after a successful login', async () => {
    vi.mocked(api.login).mockResolvedValue({ ok: true })
    const assign = vi.fn()
    vi.stubGlobal('location', { href: window.location.href, origin: window.location.origin, assign })
    window.localStorage.setItem('hermes-webui-session', '"old"')
    renderLogin('/tasks')
    await userEvent.type(screen.getByPlaceholderText(/password/i), 'pw')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1))
    expect(String(assign.mock.calls[0]?.[0])).toMatch(/\/tasks$/)
    expect(window.localStorage.getItem('hermes-webui-session')).toBeNull()
    vi.unstubAllGlobals()
  })
})
