import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, it, vi } from 'vitest'
import * as api from '../../api/endpoints'
import { AgentImportDialog } from './AgentImportDialog'
import { deferred } from '../../test/fixtures'
import type { AgentImportResult } from '@maudecode/talaria-web-contracts'

const state = vi.hoisted(() => ({ context: {} }))
vi.mock('../../stream/connection', () => ({ getStreamContext: () => state.context, useStreamContext: () => state.context }))
vi.mock('../../api/endpoints', () => ({ discoverAgentImports: vi.fn(), previewAgentImport: vi.fn(), applyAgentImport: vi.fn(), agentImportResult: vi.fn() }))
const available: AgentImportResult = { status: 'available', sources: [{ agent: 'cursor', label: 'Cursor' }], items: [], stripped_secrets: [], receipt: null, can_apply: false, message: null }
const preview: AgentImportResult = { ...available, status: 'preview', items: [{ kind: 'rules', status: 'imported', label: 'Cursor rules' }, { kind: 'skill', status: 'conflict', label: 'Existing item kept' }], stripped_secrets: ['mcp_servers.fixture.env.API_TOKEN'], receipt: 'bound-preview', can_apply: true }
beforeEach(() => {
  vi.resetAllMocks()
  state.context = {}
  vi.mocked(api.discoverAgentImports).mockResolvedValue(available)
  vi.mocked(api.previewAgentImport).mockResolvedValue(preview)
  vi.mocked(api.applyAgentImport).mockResolvedValue({ ...preview, status: 'applied', receipt: null, can_apply: false })
})
async function setup(chooseSource = true) {
  const close = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const invalidate = vi.spyOn(qc, 'invalidateQueries')
  render(<QueryClientProvider client={qc}><AgentImportDialog onClose={close} /></QueryClientProvider>)
  if (chooseSource) {
    const user = userEvent.setup()
    const select = await screen.findByRole('combobox', { name: 'Source' })
    select.focus()
    await user.keyboard('{ArrowDown}')
    await user.click(await screen.findByRole('option', { name: 'Cursor' }))
  }
  return { close, invalidate }
}
async function review() {
  const result = await setup()
  await userEvent.click(screen.getByRole('button', { name: 'Preview' }))
  await screen.findByText('Importable')
  return result
}

it('previews, cancels and confirms the exact receipt without replaying or hiding native conflicts', async () => {
  const { close, invalidate } = await review()
  expect(api.previewAgentImport).toHaveBeenCalledWith('cursor')
  expect(screen.getByText('Conflict')).toBeVisible()
  expect(screen.getByText('mcp_servers.fixture.env.API_TOKEN')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Import' }))
  const first = await screen.findByRole('alertdialog')
  await userEvent.click(within(first).getByRole('button', { name: 'Cancel' }))
  expect(api.applyAgentImport).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Import' }))
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Import' }))
  await screen.findByText('Import complete')
  expect(api.applyAgentImport).toHaveBeenCalledExactlyOnceWith('bound-preview')
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['memory'] })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['skills'] })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['mcp'] })
  expect(close).not.toHaveBeenCalled()
})

it('reads the result after a lost apply acknowledgment and never resends the import', async () => {
  vi.mocked(api.applyAgentImport).mockRejectedValue(new Error('Connection lost'))
  vi.mocked(api.agentImportResult).mockResolvedValue({ ...available, status: 'unknown', message: 'Check the profile' })
  await review()
  await userEvent.click(screen.getByRole('button', { name: 'Import' }))
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Import' }))
  const check = await screen.findByRole('button', { name: 'Check result' })
  await userEvent.click(check)
  await waitFor(() => expect(api.agentImportResult).toHaveBeenCalledTimes(2))
  expect(api.applyAgentImport).toHaveBeenCalledTimes(1)
})

it('ignores a late preview from another profile', async () => {
  const held = deferred<AgentImportResult>()
  vi.mocked(api.previewAgentImport).mockReturnValue(held.promise)
  await setup()
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
  state.context = {}
  held.resolve(preview)
  await waitFor(() => expect(api.previewAgentImport).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument()
})


it('shows a configuration refusal without suggesting a plugin installation', async () => {
  vi.mocked(api.discoverAgentImports).mockResolvedValue({ ...available, status: 'unavailable', sources: [], catalog_required: false, message: 'Profile configuration is managed.' })
  await setup(false)
  expect(await screen.findByText('Profile configuration is managed.')).toBeVisible()
  expect(screen.queryByRole('link', { name: 'Open plugin catalog' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument()
})
