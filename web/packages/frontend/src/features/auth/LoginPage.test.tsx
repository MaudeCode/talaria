import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BootstrapContext } from '../../app/bootstrap'
import type { Bootstrap } from '../../contracts/bootstrap'
import { ApiError } from '../../contracts/common'
import { resetAppRootForTests } from '../../lib/appRoot'

vi.mock('../../api/endpoints', () => ({ login: vi.fn(), passkeyOptions: vi.fn(), passkeyLogin: vi.fn() }))
vi.mock('./passkeys', () => ({ passkeysSupported: () => true, decodeRequestOptions: (pk: unknown) => pk, encodeAssertion: () => ({ id: 'synthetic-credential' }) }))
import * as api from '../../api/endpoints'
import { LoginPage } from './LoginPage'

const bootstrap = {
  webui_version: 'test', max_upload_bytes: 1, csrf_token: '', language: 'en', bot_name: 'Hermes',
  auth: { auth_enabled: true, logged_in: false, oidc_enabled: true, password_auth_enabled: true, passkeys_enabled: false, passkeys_count: 0, passkey_feature_flag: false, auth_disabled_acknowledged: false, can_manage_server: false },
  profile: { name: 'default', is_default: true }, onboarding: null,
} as unknown as Bootstrap

function renderLogin(next?: string, boot: Bootstrap = bootstrap) {
  return render(<BootstrapContext.Provider value={boot}><LoginPage next={next} /></BootstrapContext.Provider>)
}

/** Serve the page from a `/mount/` install, as a prefix-stripping proxy does, and capture navigation. */
function mountAt(path: string) {
  window.history.replaceState(null, '', path)
  const base = document.createElement('base')
  base.setAttribute('href', './')
  document.head.prepend(base)
  resetAppRootForTests()
  const assign = vi.fn()
  vi.stubGlobal('location', { href: window.location.href, origin: window.location.origin, assign })
  return {
    assign,
    landed: () => new URL(String(assign.mock.calls[0]?.[0]), window.location.origin),
    restore: () => {
      vi.unstubAllGlobals()
      base.remove()
      resetAppRootForTests()
      window.history.replaceState(null, '', '/')
    },
  }
}

describe('LoginPage', () => {
  beforeEach(() => { vi.mocked(api.login).mockReset() })

  it('shows the server error for a rejected password and keeps the form usable', async () => {
    vi.mocked(api.login).mockRejectedValue(new ApiError({ kind: 'http', status: 401, path: 'api/auth/login', message: 'Invalid password', retryable: false }))
    renderLogin()
    await userEvent.type(screen.getByPlaceholderText(/password/i), 'nope')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid password')
    expect(api.login).toHaveBeenCalledWith('nope', { mount_path: '/' })
    expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled()
  })

  it('reports a connection failure distinctly from a rejection', async () => {
    vi.mocked(api.login).mockRejectedValue(new ApiError({ kind: 'network', path: 'api/auth/login', message: 'boom' }))
    renderLogin()
    await userEvent.type(screen.getByPlaceholderText(/password/i), 'x')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/connection failed/i)
  })

  it('hands SSO the requested target and the page mount for the server to resolve', () => {
    const page = mountAt('/mount/login')
    try {
      renderLogin()
      const sso = new URL(screen.getByRole('link', { name: /sso|single sign|oidc/i }).getAttribute('href') ?? '')
      expect(sso.pathname).toBe('/mount/api/auth/oidc/start')
      expect([...sso.searchParams]).toEqual([['mount_path', '/mount/']])
      renderLogin('/mount/tasks?view=open')
      const [, second] = screen.getAllByRole('link', { name: /sso|single sign|oidc/i })
      expect([...new URL(second!.getAttribute('href') ?? '').searchParams]).toEqual([['next', '/mount/tasks?view=open'], ['mount_path', '/mount/']])
    } finally { page.restore() }
  })

  it('withholds SSO and explains why while the server cannot resolve its OIDC config', () => {
    const unresolved = { ...bootstrap, auth: { ...bootstrap.auth, oidc_enabled: false, oidc_native_handoff_enabled: false, oidc_unavailable: true } } as Bootstrap
    render(<BootstrapContext.Provider value={unresolved}><LoginPage next={undefined} /></BootstrapContext.Provider>)
    expect(screen.queryByRole('link', { name: /sso|single sign|oidc/i })).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(/sso is temporarily unavailable/i)
  })

  // TAL-1075: at a /mount/ install the server resolves the destination once; the page navigates its path verbatim.
  it('navigates once to the server-resolved destination at a subpath mount', async () => {
    const page = mountAt('/mount/login?next=%2Fmount%2Ftasks%3Fview%3Dopen')
    vi.mocked(api.login).mockResolvedValue({ ok: true, redirect_path: '/mount/tasks?view=open' })
    try {
      renderLogin('/mount/tasks?view=open')
      await userEvent.type(screen.getByPlaceholderText(/password/i), 'synthetic-pw')
      await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
      await waitFor(() => expect(page.assign).toHaveBeenCalledTimes(1))
      const url = page.landed()
      expect(url.origin).toBe(window.location.origin)
      expect(url.pathname + url.search).toBe('/mount/tasks?view=open')
      expect(api.login).toHaveBeenCalledWith('synthetic-pw', { next: '/mount/tasks?view=open', mount_path: '/mount/' })
    } finally { page.restore() }
  })

  it('lands a mounted passkey sign-in on the same server-resolved destination', async () => {
    const page = mountAt('/mount/login?next=%2Ftasks')
    vi.mocked(api.passkeyOptions).mockResolvedValue({ ok: true, publicKey: { challenge: 'c' } })
    vi.mocked(api.passkeyLogin).mockResolvedValue({ ok: true, redirect_path: '/mount/tasks' })
    vi.stubGlobal('PublicKeyCredential', {})
    const get = vi.fn().mockResolvedValue({})
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get } })
    try {
      renderLogin('/tasks', { ...bootstrap, auth: { ...bootstrap.auth, passkeys_enabled: true } })
      await userEvent.click(screen.getByRole('button', { name: /passkey/i }))
      await waitFor(() => expect(page.assign).toHaveBeenCalledTimes(1))
      expect(page.landed().pathname).toBe('/mount/tasks')
      expect(api.passkeyLogin).toHaveBeenCalledWith({ id: 'synthetic-credential' }, { next: '/tasks', mount_path: '/mount/' })
    } finally {
      page.restore()
      Reflect.deleteProperty(navigator, 'credentials')
    }
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
