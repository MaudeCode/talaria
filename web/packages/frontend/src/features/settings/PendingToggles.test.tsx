import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { beforeEach, expect, it, vi } from 'vitest'
import { cloneElement, type ReactNode } from 'react'
import { BootstrapContext } from '../../app/bootstrap'
import { DEFAULT_BOOTSTRAP } from '../../contracts/adapters/memory'
import { keys } from '../../api/queryKeys'
import * as api from '../../api/endpoints'
import { deferred } from '../../test/fixtures'
import { SkillsPage } from '../skills/SkillsPage'
import { McpSection } from './McpSection'
import { ExtensionsSection } from './ExtensionsSection'
import { ConnectorsSection } from '../connectors/ConnectorsSection'
import { teardownAll } from '../../stream/connection'
import { showToast } from '../toast/toast'

vi.mock('../../api/endpoints', () => ({ fetchSkills: vi.fn(), fetchSkillsUsage: vi.fn(), toggleSkill: vi.fn(), fetchMcpServers: vi.fn(), fetchMcpTools: vi.fn(), toggleMcpServer: vi.fn(), fetchExtensionRegistry: vi.fn(), extensionAction: vi.fn(), fetchConnectors: vi.fn(), fetchConnectorTools: vi.fn(), setConnectorRule: vi.fn() }))
vi.mock('../../shell/AppShell', () => ({ HubPage: ({ children, toolbar }: { children: ReactNode; toolbar?: ReactNode }) => <main>{toolbar}{children}</main> }))
vi.mock('../pending-writes/PendingWritesPanel', () => ({ PendingWritesPanel: () => null }))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
const manifests = vi.hoisted(() => vi.fn())
vi.mock('../../extensions/registry', () => ({ useExtensionManifests: () => useQuery({ queryKey: keys.extensions.manifests, queryFn: manifests, staleTime: 30_000 }) }))

const ids = ['alpha', 'beta']
const skills = () => ({ skills: ids.map((name) => ({ name, disabled: true, category: null, description: '' })) })
const mcp = () => ({ toggle_supported: true, reload_required: true, servers: ids.map((name) => ({ name, enabled: false, can_toggle: true, status: 'disabled', health: 'unhealthy' })) })
const extensions = () => ({ protocol_version: 1, manifests: ids.map((id) => ({ id, name: id, source: 'manifest', enabled: false, can_toggle: true, capabilities: [], permissions: {}, settings_schema: [], warnings: [], sidecar: { origin: 'http://127.0.0.1:1234', consented: false } })) })
const connectors = () => ({ available: true, policy_revision: 'rev-1', connectors: ids.map((slug) => ({ slug, name: slug, enabled: false, rules_editable: true, connected: true, accounts: [], tools_off: 3, org_locked: false })) })
const cases = [
  { name: 'skill', ui: <SkillsPage />, key: keys.skills.all, snapshot: skills, read: () => vi.mocked(api.fetchSkills), write: () => vi.mocked(api.toggleSkill) },
  { name: 'MCP', ui: <McpSection heading="" />, key: keys.mcp.servers, snapshot: mcp, read: () => vi.mocked(api.fetchMcpServers), write: () => vi.mocked(api.toggleMcpServer) },
  { name: 'extension', ui: <ExtensionsSection />, key: keys.extensions.manifests, snapshot: extensions, read: () => manifests, write: () => vi.mocked(api.extensionAction) },
  { name: 'connector', ui: <ConnectorsSection />, key: keys.connectors.page, snapshot: connectors, read: () => vi.mocked(api.fetchConnectors), write: () => vi.mocked(api.setConnectorRule) },
]

beforeEach(() => {
  vi.resetAllMocks()
  teardownAll()
  vi.mocked(api.fetchSkillsUsage).mockResolvedValue({ usage: {} })
  vi.mocked(api.fetchMcpTools).mockResolvedValue({ tools: [], total: 0 })
  vi.mocked(api.fetchExtensionRegistry).mockResolvedValue({ entries: [] })
  vi.mocked(api.fetchConnectorTools).mockResolvedValue({ connector: 'alpha', policy_revision: 'rev-1', tools: [{ slug: 'read', name: 'Read', description: '', deprecated: false, enabled: false, editable: true, facet: 'read', locked: false }] })
})

function setup(c: typeof cases[number]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  c.read().mockResolvedValue(c.snapshot())
  const tree = () => <QueryClientProvider client={qc}><BootstrapContext.Provider value={DEFAULT_BOOTSTRAP}>{cloneElement(c.ui)}</BootstrapContext.Provider></QueryClientProvider>
  const view = render(tree())
  return { qc, ...view, tree }
}
const control = (name: string) => screen.getByRole('switch', { name: new RegExp(`^${name}(?:[: ]|$)`) })

it.each(cases)('$name reflects requested state while transport is held, suppresses duplicates and fences refreshes', async (c) => {
  const write = deferred<never>()
  c.write().mockReturnValue(write.promise)
  const { qc } = setup(c)
  await screen.findByRole('switch', { name: /^alpha(?:[: ]|$)/ })
  fireEvent.click(control('alpha'))
  await waitFor(() => expect(control('alpha')).toBeChecked())
  expect(control('alpha')).toHaveAttribute('aria-busy', 'true')
  expect(control('alpha')).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(control('alpha'))
  act(() => qc.setQueryData(c.key, c.snapshot()))
  expect(control('alpha')).toBeChecked()
  if (c.name === 'connector') {
    expect(control('beta')).toHaveAttribute('aria-disabled', 'true')
  } else {
    expect(control('beta')).not.toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(control('beta'))
    await waitFor(() => expect(control('beta')).toBeChecked())
  }
  expect(c.write()).toHaveBeenCalledTimes(c.name === 'connector' ? 1 : 2)
})

it.each(cases)('$name uses the authoritative normalized value after success', async (c) => {
  const write = deferred<never>()
  c.write().mockReturnValue(write.promise)
  setup(c)
  await screen.findByRole('switch', { name: /^alpha(?:[: ]|$)/ })
  fireEvent.click(control('alpha'))
  await waitFor(() => expect(control('alpha')).toBeChecked())
  await act(async () => { write.resolve({ ok: true, enabled: false } as never); await Promise.resolve() })
  await waitFor(() => expect(control('alpha')).not.toBeChecked())
  expect(control('alpha')).not.toHaveAttribute('aria-disabled', 'true')
})

it.each(cases)('$name restores confirmed state and reports a refused write', async (c) => {
  const write = deferred<never>()
  c.write().mockReturnValue(write.promise)
  setup(c)
  await screen.findByRole('switch', { name: /^alpha(?:[: ]|$)/ })
  fireEvent.click(control('alpha'))
  await waitFor(() => expect(control('alpha')).toBeChecked())
  await act(async () => { write.resolve({ ok: false, error: 'Refused' } as never); await Promise.resolve() })
  await waitFor(() => expect(control('alpha')).not.toBeChecked())
  expect(showToast).toHaveBeenCalledWith(expect.any(String), expect.any(Number), 'error')
})

it.each(cases)('$name retains ownership across unmount, and fences a previous profile completion', async (c) => {
  const old = deferred<never>(), fresh = deferred<never>()
  c.write().mockReturnValueOnce(old.promise).mockReturnValue(fresh.promise)
  const { qc, rerender, tree } = setup(c)
  await screen.findByRole('switch', { name: /^alpha(?:[: ]|$)/ })
  fireEvent.click(control('alpha'))
  await waitFor(() => expect(control('alpha')).toBeChecked())
  rerender(<div />)
  rerender(tree())
  expect(control('alpha')).toBeChecked()
  act(() => { teardownAll(); qc.clear(); qc.setQueryData(c.key, c.snapshot()) })
  rerender(tree())
  await waitFor(() => expect(control('alpha')).not.toBeChecked())
  fireEvent.click(control('alpha'))
  await waitFor(() => expect(c.write()).toHaveBeenCalledTimes(2))
  await act(async () => { old.resolve({ ok: true } as never); await Promise.resolve() })
  expect(control('alpha')).toBeChecked()
  expect(control('alpha')).toHaveAttribute('aria-busy', 'true')
  expect(showToast).not.toHaveBeenCalled()
})

it.each(cases)('$name reconciles a transport failure and keeps read recovery separate from another write', async (c) => {
  c.write().mockRejectedValue(new Error('Connection lost'))
  const { qc } = setup(c)
  await screen.findByRole('switch', { name: /^alpha(?:[: ]|$)/ })
  c.read().mockRejectedValue(new Error('Offline'))
  fireEvent.click(control('alpha'))
  const retry = await within(control('alpha').closest('li')!).findByRole('button', { name: 'Retry' })
  expect(control('alpha')).toBeChecked()
  expect(control('alpha')).toHaveAttribute('aria-disabled', 'true')
  c.read().mockResolvedValue(c.snapshot())
  fireEvent.click(retry)
  await waitFor(() => expect(control('alpha')).not.toBeChecked())
  expect(c.write()).toHaveBeenCalledTimes(1)
  expect(qc.getQueryData(c.key)).toEqual(c.snapshot())
})

it.each(cases.filter((c) => c.name !== 'connector'))('$name keeps a peer intent when the first write reconciles', async (c) => {
  const first = deferred<never>(), second = deferred<never>()
  c.write().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  setup(c)
  await screen.findByRole('switch', { name: /^alpha(?:[: ]|$)/ })
  fireEvent.click(control('alpha'))
  await waitFor(() => expect(control('alpha')).toBeChecked())
  fireEvent.click(control('beta'))
  await waitFor(() => expect(control('beta')).toBeChecked())
  await act(async () => { first.resolve({ ok: true } as never); await Promise.resolve() })
  await waitFor(() => expect(control('alpha')).not.toBeChecked())
  expect(control('beta')).toBeChecked()
  expect(control('beta')).toHaveAttribute('aria-busy', 'true')
  await act(async () => { second.resolve({ ok: true } as never); await Promise.resolve() })
  await waitFor(() => expect(control('beta')).not.toBeChecked())
})

it('serializes connector tool and app rules through conflict reconciliation and the fresh revision', async () => {
  const c = cases[3]!
  const write = deferred<never>()
  c.write().mockReturnValueOnce(write.promise).mockResolvedValue({ ok: true, revision: 'rev-3' } as never)
  const { qc } = setup(c)
  await screen.findByRole('switch', { name: /^alpha(?:[: ]|$)/ })
  fireEvent.click(screen.getAllByRole('button', { name: /Tools/ })[0]!)
  const tool = await screen.findByRole('switch', { name: 'Read available to Hermes' })
  fireEvent.click(tool)
  await waitFor(() => expect(tool).toBeChecked())
  expect(tool).toHaveAttribute('aria-busy', 'true')
  expect(control('alpha')).toHaveAttribute('aria-disabled', 'true')
  expect(control('alpha')).not.toBeChecked()
  const { ApiError } = await import('../../contracts')
  // Reject the held transport without a timer, then read the server's replacement revision.
  c.read().mockResolvedValue({ ...connectors(), policy_revision: 'rev-2' })
  await act(async () => { write.resolve(Promise.reject(new ApiError({ kind: 'http', status: 409, path: '/api/connectors/alpha/policy', code: 'policy_conflict', message: 'stale', retryable: false })) as never); await Promise.resolve() })
  await waitFor(() => expect(tool).not.toBeChecked())
  expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/changed/i), 5000, 'error')
  fireEvent.click(control('beta'))
  await waitFor(() => expect(api.setConnectorRule).toHaveBeenLastCalledWith('beta', 'rev-2', { enabled: true }))
  expect(qc.getQueryData(keys.connectors.page)).toMatchObject({ policy_revision: 'rev-2' })
})

it('keeps connector rules without a revision and server-locked tools disabled', async () => {
  const { qc } = setup(cases[3]!)
  await screen.findByRole('switch', { name: /^alpha(?:[: ]|$)/ })
  act(() => qc.setQueryData(keys.connectors.page, { ...connectors(), policy_revision: null }))
  await waitFor(() => expect(control('alpha')).toHaveAttribute('aria-disabled', 'true'))
  fireEvent.click(control('alpha'))
  expect(api.setConnectorRule).not.toHaveBeenCalled()
  act(() => qc.setQueryData(keys.connectors.page, connectors()))
  vi.mocked(api.fetchConnectorTools).mockResolvedValue({ connector: 'alpha', policy_revision: 'rev-1', tools: [{ slug: 'read', name: 'Read', description: '', deprecated: false, enabled: false, editable: false, facet: 'read', locked: true }] })
  fireEvent.click(screen.getAllByRole('button', { name: /Tools/ })[0]!)
  const tool = await screen.findByRole('switch', { name: 'Read available to Hermes' })
  expect(tool).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(tool)
  expect(api.setConnectorRule).not.toHaveBeenCalled()
})

it('retains a pending connector tool and its recovery action after a failed tool refresh', async () => {
  const { qc } = setup(cases[3]!)
  await screen.findByRole('switch', { name: /^alpha(?:[: ]|$)/ })
  fireEvent.click(screen.getAllByRole('button', { name: /Tools/ })[0]!)
  const tool = await screen.findByRole('switch', { name: 'Read available to Hermes' })
  vi.mocked(api.setConnectorRule).mockRejectedValue(new Error('Connection lost'))
  vi.mocked(api.fetchConnectorTools).mockRejectedValue(new Error('Offline'))
  fireEvent.click(tool)
  const retry = await within(tool.parentElement!).findByRole('button', { name: 'Retry' })
  expect(tool).toBeInTheDocument()
  expect(tool).toBeChecked()
  expect(control('beta')).toHaveAttribute('aria-disabled', 'true')
  vi.mocked(api.fetchConnectorTools).mockResolvedValue(qc.getQueryData<Awaited<ReturnType<typeof api.fetchConnectorTools>>>(keys.connectors.tools('alpha'))!)
  fireEvent.click(retry)
  await waitFor(() => expect(tool).not.toBeChecked())
  expect(control('beta')).not.toHaveAttribute('aria-disabled', 'true')
  expect(api.setConnectorRule).toHaveBeenCalledOnce()
})

it('review regression: skill list reconciliation excludes failed cached details', async () => {
  const { qc } = setup(cases[0]!)
  await screen.findByRole('switch', { name: /^alpha/ })
  const unrelated = vi.fn().mockRejectedValue(new Error('Removed skill'))
  await qc.query({ queryKey: keys.skills.content('removed'), queryFn: unrelated }).catch(() => undefined)
  vi.mocked(api.toggleSkill).mockResolvedValue({ ok: true, name: 'alpha', enabled: false })
  await userEvent.click(control('alpha'))
  await waitFor(() => expect(control('alpha')).not.toHaveAttribute('aria-disabled', 'true'))
  expect(unrelated).toHaveBeenCalledOnce()
  expect(control('alpha')).not.toBeChecked()
})

it.each(cases.filter((c) => c.name !== 'connector'))('review regression: $name accessible name stays consistent with requested checked state', async (c) => {
  c.write().mockReturnValue(deferred<never>().promise)
  setup(c)
  await screen.findByRole('switch', { name: /^alpha/ })
  await userEvent.click(control('alpha'))
  await waitFor(() => expect(control('alpha')).toBeChecked())
  expect(control('alpha')).toHaveAccessibleName('alpha')
})

it('review regression: extension state text activates its switch and suppresses a pending duplicate', async () => {
  vi.mocked(api.extensionAction).mockReturnValue(deferred<never>().promise)
  setup(cases[2]!)
  const toggle = await screen.findByRole('switch', { name: /^alpha/ })
  const row = toggle.closest('li')!
  await userEvent.click(within(row).getByText('Disabled', { exact: true }))
  await waitFor(() => expect(api.extensionAction).toHaveBeenCalledWith('toggle', { id: 'alpha', enabled: true }))
  expect(toggle).toBeChecked()
  await userEvent.click(within(row).getByText('Enabled', { exact: true }))
  expect(api.extensionAction).toHaveBeenCalledOnce()
})
