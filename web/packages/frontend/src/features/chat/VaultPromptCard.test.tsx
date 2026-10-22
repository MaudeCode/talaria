import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ClarifyPending } from '../../contracts'
import type { LiveTurn } from '../../stream/reducer'

// The shared contract examples every client renders (TAL-887).
const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../contracts/fixtures/vault-prompts.json'), 'utf8')) as Record<'unlock' | 'save_login' | 'code' | 'skill_secret', { pending: ClarifyPending }>
let head: ClarifyPending | null = null
vi.mock(import('../../api/endpoints'), async (importOriginal) => ({
  ...(await importOriginal()), fetchClarifyPending: vi.fn(() => Promise.resolve({ pending: head, pending_count: head ? 1 : 0 })), respondClarify: vi.fn(() => Promise.resolve({ ok: true })),
}))
import * as api from '../../api/endpoints'
import { useClarify } from './useClarify'
import { VaultPromptCard, useVaultPrompt } from './VaultPromptCard'

const streaming = { status: 'streaming', clarify: null } as unknown as LiveTurn

/** ChatView's wiring: a vault head renders the vault card and never the clarify flow. */
function Prompts() {
  const clarify = useClarify('s1', streaming)
  const vault = useVaultPrompt('s1', streaming)
  return (
    <>
      {clarify && <div data-testid="clarify" />}
      {vault && <VaultPromptCard key={vault.clarifyId} sessionId="s1" clarifyId={vault.clarifyId} vault={vault.vault} />}
    </>
  )
}

const renderHead = (pending: ClarifyPending) => {
  head = pending
  vi.spyOn(Date, 'now').mockReturnValue(1800000000 * 1000)
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Prompts /></QueryClientProvider>)
}

describe('password-manager prompts (TAL-887)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.mocked(api.respondClarify).mockReset().mockImplementation(() => { head = null; return Promise.resolve({ ok: true }) })
  })

  it('unlocks with a masked master password and drops it once sent', async () => {
    const { container } = renderHead(fixture.unlock.pending)
    expect(await screen.findByRole('dialog', { name: 'Unlock Bitwarden' })).toBeTruthy()
    expect(screen.queryByTestId('clarify')).toBeNull()
    expect(screen.getByText('120s')).toBeTruthy()
    const input = screen.getByLabelText('Master password')
    expect(input.getAttribute('type')).toBe('password')
    // Relay fields never ask for the credentials the browser keeps for Talaria itself.
    expect(input.getAttribute('autocomplete')).toBe('off')
    const unlock = screen.getByRole('button', { name: 'Unlock' })
    expect((unlock as HTMLButtonElement).disabled).toBe(true)
    await userEvent.type(input, 'correct horse')
    await userEvent.click(unlock)
    expect(api.respondClarify).toHaveBeenCalledWith({ session_id: 's1', clarify_id: 'contract-vault-unlock', answers: { master_password: 'correct horse' } })
    expect(container.innerHTML).not.toContain('correct horse')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('asks for a login to save with the identifier shown and the password masked', async () => {
    renderHead(fixture.save_login.pending)
    expect(await screen.findByRole('dialog', { name: 'Save login for login.example.com' })).toBeTruthy()
    expect(screen.getByLabelText('Email or username').getAttribute('type')).toBe('text')
    expect(screen.getByLabelText('Password').getAttribute('type')).toBe('password')
    expect(['Email or username', 'Password'].map((label) => screen.getByLabelText(label).getAttribute('autocomplete'))).toEqual(['off', 'off'])
    await userEvent.type(screen.getByLabelText('Email or username'), 'me@example.com')
    await userEvent.type(screen.getByLabelText('Password'), 's3cret')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.respondClarify).toHaveBeenCalledWith({ session_id: 's1', clarify_id: 'contract-vault-login', answers: { identifier: 'me@example.com', password: 's3cret' } })
  })

  it('saves a skill secret in the shared masked prompt, with explicit Skip', async () => {
    const { container } = renderHead(fixture.skill_secret.pending)
    expect(await screen.findByRole('dialog', { name: 'Set up example' })).toBeTruthy()
    expect(screen.queryByTestId('clarify')).toBeNull()
    const input = screen.getByLabelText('EXAMPLE_API_KEY')
    expect(input.getAttribute('type')).toBe('password')
    expect(input.getAttribute('autocomplete')).toBe('off')
    expect(screen.getByRole('button', { name: 'Skip' })).toBeTruthy()
    await userEvent.type(input, 'unique-skill-secret')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.respondClarify).toHaveBeenCalledWith({ session_id: 's1', clarify_id: 'contract-skill-secret', answers: { secret: 'unique-skill-secret' } })
    expect(container.innerHTML).not.toContain('unique-skill-secret')
  })

  it('takes a one-time code as typed, and Skip declines without an answer', async () => {
    renderHead(fixture.code.pending)
    expect(await screen.findByRole('dialog', { name: 'Code for login.example.com' })).toBeTruthy()
    const code = screen.getByLabelText('Code')
    expect(code.getAttribute('type')).toBe('text')
    expect(code.getAttribute('autocomplete')).toBe('one-time-code')
    // Codes can have letters: no numeric-only keyboard.
    expect(code.getAttribute('inputmode')).toBeNull()
    await userEvent.type(code, '4815')
    await userEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(api.respondClarify).toHaveBeenCalledWith({ session_id: 's1', clarify_id: 'contract-vault-code', decline: true })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('leaves on Skip at once and comes back empty when the relay fails (TAL-1384)', async () => {
    let refuse!: (error: unknown) => void
    vi.mocked(api.respondClarify).mockReturnValueOnce(new Promise((_, reject) => { refuse = reject }) as never)
    renderHead(fixture.code.pending)
    expect(await screen.findByRole('dialog', { name: 'Code for login.example.com' })).toBeTruthy()
    await userEvent.type(screen.getByLabelText('Code'), '4815')
    await userEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { refuse(new Error('relay failed')); await Promise.resolve() })
    expect(await screen.findByRole('dialog', { name: 'Code for login.example.com' })).toBeTruthy()
    expect(screen.getByLabelText('Code')).toHaveValue('')
  })
})
