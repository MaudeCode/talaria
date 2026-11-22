/** TAL-2661: System › Server's Agent-home backup row renders the server's backup status and acts on it. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AgentBackupStatus } from '@maudecode/talaria-web-contracts'

vi.mock('../../api/endpoints', () => ({ fetchAgentBackup: vi.fn(), createAgentBackup: vi.fn(), discardAgentBackup: vi.fn() }))
import * as api from '../../api/endpoints'
import { AgentBackupRow } from './AgentBackup'

/** The shared statuses the server answers (contracts/fixtures/agent-backup.json). */
const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../contracts/fixtures/agent-backup.json'), 'utf8')) as Record<'idle' | 'running' | 'ready' | 'failed' | 'named_profile', AgentBackupStatus>

function renderRow(status: AgentBackupStatus) {
  vi.mocked(api.fetchAgentBackup).mockResolvedValue(status)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}><AgentBackupRow /></QueryClientProvider>)
}
const row = async (state: string) => { await waitFor(() => { expect(document.querySelector(`[data-agent-backup="${state}"]`)).not.toBeNull() }); return document.querySelector<HTMLElement>(`[data-agent-backup="${state}"]`)! }

describe('Agent-home backup row (TAL-2661)', () => {
  // The download spy and the expiry test's fake clock end with their test, whatever it asserted.
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('names the server and profile before starting a backup', async () => {
    vi.mocked(api.createAgentBackup).mockResolvedValue(fixture.running)
    renderRow(fixture.idle)
    await userEvent.click(within(await row('none')).getByRole('button', { name: 'Back up Agent home' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('on talaria-host: every profile, with its chats and credentials, owned by the default profile. The server deletes it after 60 minutes.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Back up Agent home' }))
    expect(await row('running')).toBeInTheDocument()
    expect(screen.getByText('Backing up 412 of 1,280 files')).toBeInTheDocument()
  })

  it('shows a cancel at once and keeps the server answer', async () => {
    let answer: (s: AgentBackupStatus) => void = () => undefined
    vi.mocked(api.discardAgentBackup).mockReturnValue(new Promise((r) => { answer = r }))
    renderRow(fixture.running)
    await userEvent.click(within(await row('running')).getByRole('button', { name: 'Cancel backup' }))
    expect(await row('cancelled')).toBeInTheDocument()
    expect(api.discardAgentBackup).toHaveBeenCalledWith(fixture.running.job!.id)
    answer(fixture.idle)
    expect(await row('none')).toBeInTheDocument()
  })

  it('downloads the ready archive from its server URL and deletes it from the row menu', async () => {
    const saved: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.href) })
    vi.mocked(api.discardAgentBackup).mockResolvedValue(fixture.idle)
    renderRow(fixture.ready)
    const ready = await row('ready')
    expect(screen.getByText(/^Ready · 46\.\d MB · until /)).toBeInTheDocument()
    await userEvent.click(within(ready).getByRole('button', { name: 'Download backup' }))
    expect(saved).toEqual([expect.stringMatching(/\/api\/agent-backup\/download\?id=0f3c9a1e5b7d4c2a8e6f1b3d5a7c9e0f$/)])
    await userEvent.pointer({ keys: '[MouseRight]', target: ready })
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete backup' }))
    expect(await row('none')).toBeInTheDocument()
  })

  it('reads the status again when the ready archive expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const expiring = { ...fixture.ready, job: { ...fixture.ready.job!, expires_at: Date.now() / 1000 + 60 } }
    renderRow(expiring)
    await row('ready')
    vi.mocked(api.fetchAgentBackup).mockResolvedValue(fixture.idle)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await row('none')).toBeInTheDocument()
  })

  it('shows a failure in the server words and offers another start', async () => {
    renderRow(fixture.failed)
    expect(within(await row('failed')).getByRole('button', { name: 'Back up Agent home' })).toBeInTheDocument()
    expect(screen.getByText('Another Hermes backup is already running.')).toBeInTheDocument()
  })

  it('offers no start to a named profile, only its reason', async () => {
    renderRow(fixture.named_profile)
    const refused = await row('none')
    expect(within(refused).queryByRole('button', { name: 'Back up Agent home' })).toBeNull()
    expect(within(refused).getByRole('button', { name: 'Backup unavailable' })).toBeInTheDocument()
  })
})
